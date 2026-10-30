/**
 * Fast-sync's snapshot op, read on a node whose every RPC node is a Tor/I2P
 * service (v1.21.18).
 *
 * WHAT WENT WRONG. resolveTrustedSnapshotOp asked for the newest 1000 entries
 * of @morphit's history in one read, from each operator. Over Tor/I2P that
 * never arrives (morphitlat, v1.21.16: 10 entries took 33.7 s through its
 * indexer, 100 none within 240 s), so a hidden-only node could not find the
 * snapshot to fast-sync from, and its mirror job could not either.
 *
 * NOW. When every node in the pool is a .onion/.i2p service, the history is
 * read in pages of HIDDEN_HISTORY_PAGE_SIZE positions, newest first, each page
 * agreed by the same quorum; the op found is still confirmed in its block by a
 * quorum and must carry the pinned key's signature. A pool with a clearnet node
 * keeps the single read.
 *
 * The operators below never answer a page of more than 50 entries (as over
 * Tor/I2P), and only every other history position is an entry (the other is
 * the chain's fee for the op, which the answer leaves out), as on the chain.
 */
import { describe, expect, it } from 'vitest';
import { PrivateKey, cryptoUtils } from '@beblurt/dblurt';

import {
	HIDDEN_HISTORY_PAGE_SIZE,
	readsOnlyHiddenNodes,
	resolveTrustedSnapshotOp,
	transactionIdOf
} from '../../src/blurt/snapshotOpTrust';
import { agreedReader } from '../testutils/fakeChain';

const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
const KEY = PrivateKey.fromSeed('indexer-snapshot-paged-official');
const PUB = KEY.createPublic().toString();
const OTHER = PrivateKey.fromSeed('indexer-snapshot-paged-someone-else');

function snapshotTx(lastBlock: number, key = KEY) {
	const op = [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: ['morphit'],
			id: 'indexer_snapshot_v1',
			json: JSON.stringify({
				ipfs_cid: `bafy${'b'.repeat(55)}`,
				sha256: 'c'.repeat(64),
				chain_id: CHAIN_ID,
				schema_version: 1,
				last_applied_block: lastBlock,
				size_bytes: 1000,
				indexer_version: '1.21.18'
			})
		}
	];
	const tx = cryptoUtils.signTransaction(
		{
			ref_block_num: lastBlock & 0xffff,
			ref_block_prefix: 4242,
			expiration: '2026-10-01T00:01:00',
			operations: [op],
			extensions: []
		} as never,
		[key],
		Buffer.from(CHAIN_ID, 'hex')
	) as unknown as Record<string, unknown>;
	return { op, tx, trxId: transactionIdOf(tx)! };
}

/** @morphit's history 0..top: an entry at every odd position, large filler
 *  ops except where `ops` puts a snapshot op. */
function chain(
	top: number,
	ops: Array<{ seq: number; blockNum: number; tx: ReturnType<typeof snapshotTx> }>
) {
	const history: unknown[] = [];
	const blocks = new Map<number, unknown>();
	for (let seq = 1; seq <= top; seq += 2) {
		const o = ops.find((x) => x.seq === seq);
		if (o) {
			history.push([seq, { block: o.blockNum, trx_id: o.tx.trxId, op: o.tx.op }]);
			blocks.set(o.blockNum, {
				block_id: `${o.blockNum.toString(16).padStart(8, '0')}${'a'.repeat(32)}`,
				transactions: [o.tx.tx],
				transaction_ids: [o.tx.trxId]
			});
			continue;
		}
		history.push([
			seq,
			{
				block: 64_000_000 + seq,
				trx_id: seq.toString(16).padStart(40, '0'),
				op: [
					'custom_json',
					{
						required_auths: [],
						required_posting_auths: ['morphit'],
						id: 'morphit_release_v1',
						json: JSON.stringify({ version: '1.0.0', note: 'x'.repeat(3_600) })
					}
				]
			}
		]);
	}
	/** One operator: Blurt's paging rule, and no answer over 50 entries. */
	const operator = (method: string, params: readonly unknown[]): unknown => {
		if (method === 'get_block') return blocks.get(params[0] as number) ?? null;
		if (method !== 'get_account_history') throw new Error(`unexpected ${method}`);
		const [, from, limit] = params as [string, number, number];
		if (from !== -1 && from < limit) throw new Error('start must be greater than limit');
		const hi = from === -1 ? top : from;
		const page = (history as Array<[number, unknown]>).filter(
			([s]) => s >= Math.max(0, hi - limit) && s <= hi
		);
		if (page.length > 50) throw new Error('no answer in time');
		return page;
	};
	return { operator };
}

const hiddenPool = () => [
	{ url: 'http://aaaa.onion' },
	{ url: 'http://bbbb.b32.i2p' },
	{ url: 'http://cccc.onion' }
];

const args = {
	signer: 'morphit',
	pinnedPubkey: PUB,
	chainId: CHAIN_ID,
	historyLimit: 1000,
	minAgree: 2
};

describe('the snapshot op over Tor/I2P', () => {
	it('is found in small agreed pages, newest first, and confirmed by its signature', async () => {
		const snap = snapshotTx(64_000_123);
		// Position 1_163: the 4th page from the top (1_201).
		const { operator } = chain(1_201, [{ seq: 1_163, blockNum: 64_500_000, tx: snap }]);
		const reader = Object.assign(agreedReader([operator, operator, operator], 2), {
			endpointSnapshot: hiddenPool
		});
		const r = await resolveTrustedSnapshotOp(reader, args);
		expect(r.ok, JSON.stringify(r)).toBe(true);
		if (!r.ok) return;
		expect(r.selected.payload.last_applied_block).toBe(64_000_123);
		expect(r.selected.trxId).toBe(snap.trxId);
		const pages = reader.calls.filter((c) => c.method === 'get_account_history');
		expect(pages.length).toBe(4);
		for (const p of pages) expect(p.params[2]).toBeLessThanOrEqual(HIDDEN_HISTORY_PAGE_SIZE);
		for (const p of pages) expect(p.minAgree).toBe(2);
		// Each page starts just below the agreed one before it.
		expect(pages.map((p) => p.params[1])).toEqual([-1, 1_190, 1_180, 1_170]);
	});

	it('where the next page starts is agreed too: one operator cannot make the read skip a page', async () => {
		const snap = snapshotTx(64_000_123);
		const { operator } = chain(1_201, [{ seq: 1_163, blockNum: 64_500_000, tx: snap }]);
		// Asked first, it answers each page with one made-up entry far below it,
		// so a read that took ITS lowest entry would jump past the snapshot op.
		const liar = (method: string, params: readonly unknown[]): unknown => {
			const page = operator(method, params);
			if (method !== 'get_account_history' || !Array.isArray(page) || page.length === 0)
				return page;
			const low = (page[0] as [number])[0];
			return [[low - 41, { block: 1, trx_id: '0'.repeat(39) + '1', op: ['vote', {}] }], ...page];
		};
		const reader = Object.assign(agreedReader([liar, operator, operator], 2), {
			endpointSnapshot: hiddenPool
		});
		const r = await resolveTrustedSnapshotOp(reader, args);
		expect(r.ok, JSON.stringify(r)).toBe(true);
		if (r.ok) expect(r.selected.trxId).toBe(snap.trxId);
	});

	it('a newest op signed by another key is refused, as before (no older op is taken instead)', async () => {
		const good = snapshotTx(64_000_100);
		const forged = snapshotTx(64_000_200, OTHER);
		const { operator } = chain(1_201, [
			{ seq: 1_195, blockNum: 64_500_002, tx: forged },
			{ seq: 1_163, blockNum: 64_500_000, tx: good }
		]);
		const reader = Object.assign(agreedReader([operator, operator, operator], 2), {
			endpointSnapshot: hiddenPool
		});
		const r = await resolveTrustedSnapshotOp(reader, args);
		expect(r.ok).toBe(false);
	});

	it('no op within the depth: refused, after reading no deeper than asked', async () => {
		const { operator } = chain(1_201, []);
		const reader = Object.assign(agreedReader([operator, operator, operator], 2), {
			endpointSnapshot: hiddenPool
		});
		const r = await resolveTrustedSnapshotOp(reader, { ...args, historyLimit: 100 });
		expect(r.ok).toBe(false);
		const pages = reader.calls.filter((c) => c.method === 'get_account_history');
		const read = pages.reduce((n, p) => n + (p.params[2] as number) + 1, 0);
		expect(read).toBe(100);
	});

	it('a pool with a clearnet node keeps the single read of the whole depth', async () => {
		const { operator } = chain(1_201, []);
		const reader = Object.assign(agreedReader([operator, operator, operator], 2), {
			endpointSnapshot: () => [...hiddenPool(), { url: 'https://rpc.example.org' }]
		});
		await resolveTrustedSnapshotOp(reader, args);
		const pages = reader.calls.filter((c) => c.method === 'get_account_history');
		expect(pages.map((p) => p.params)).toEqual([['morphit', -1, 1000]]);
	});

	it('tells a Tor/I2P-only pool from one with any clearnet or local node', () => {
		expect(readsOnlyHiddenNodes({ endpointSnapshot: hiddenPool })).toBe(true);
		expect(
			readsOnlyHiddenNodes({
				endpointSnapshot: () => [...hiddenPool(), { url: 'http://127.0.0.1:8091' }]
			})
		).toBe(false);
		expect(readsOnlyHiddenNodes({ endpointSnapshot: () => [] })).toBe(false);
		expect(readsOnlyHiddenNodes({})).toBe(false);
	});
});
