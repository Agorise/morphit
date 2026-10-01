/**
 * v1.20.2 — public Monero NODES as XMR fee sources, and the lone-answer rule.
 *
 * Node responses are monerod's own shape (core_rpc_server_commands_defs.h,
 * COMMAND_RPC_GET_TRANSACTIONS; read 2026-10-01): {status:'OK', untrusted,
 * txs:[{tx_hash, as_json, prunable_hash, in_pool, confirmations, …}],
 * missed_tx:[…]}, `as_json` being the transaction as a JSON STRING. The
 * transactions are the PyPI-`monero`-built vectors of xmrRawTx.test.ts and
 * the real mainnet transaction 0323898c…; the prunable hashes below were
 * computed separately (Python, pycryptodome Keccak over monerod's prunable
 * serialization) and are proven right by the txid they produce.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	LONE_ANSWER_AFTER_MS,
	MoneroProofFeeVerifier,
	parseXmrExplorer
} from '$indexer/fee/moneroProofVerifier';
import { moneroTxHash } from '$indexer/fee/xmrRawTx';
import type { FeeClaim } from '$indexer/fee/verifier';
import { DEFAULT_XMR_EXPLORERS } from '../../../src/config/xmrExplorers';
import { parseXmrAddress, xmrFeePaymentId } from '@morphit/release-schema';

const V = JSON.parse(
	readFileSync(resolve(__dirname, '../../fixtures/xmr-rawtx-vectors.json'), 'utf8')
);
const MAINNET = JSON.parse(
	readFileSync(resolve(__dirname, '../../fixtures/xmr-rawtx-mainnet-0323898c.json'), 'utf8')
).transaction_data;
const MAINNET_TXID = '0323898c1e355ed3b1939a4ab617611d95bdf8f22777cdab44c6dfd4cc537d3e';
const MAINNET_PRUNABLE_HASH = 'f9020a40a8dc1f6811c454b33cd4fa3443f7581576e3ab64bd5d95346cbf8c76';
const PRUNABLE: Record<string, string> = {
	'integrated-primary+change': 'ff6340d559948c296f2cc07e92bffabeb6cf3cd27f4865b95d1839fca067c47a',
	'subaddress+change': 'bfbcc99d320d1e84ce96690b0c21967e98ff743bb122c808253bb168f1870d93'
};
const byName = (n: string) => V.vectors.find((v: { name: string }) => v.name === n);
const FEE = 781_250_000n;
const NODE = 'node+https://node.example:18089';
const NODE2 = 'node+https://other-node.example';
const RAW = 'raw-tx+https://moneroblocks.info';
const DEAD = 'https://dead-explorer.example';

type Reply = { status?: number; json?: unknown; text?: string } | 'throw';
type Route = (url: string, init?: RequestInit) => Reply | undefined;
function fetcher(...routes: Route[]) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, ...(init !== undefined ? { init } : {}) });
		let r: Reply | undefined;
		for (const route of routes) {
			r = route(url, init);
			if (r !== undefined) break;
		}
		if (r === undefined || r === 'throw') throw new TypeError(`fetch failed: ${url}`);
		const status = r.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => r.json,
			text: async () => r.text ?? JSON.stringify(r.json)
		} as unknown as Response;
	}) as typeof fetch;
	return { f, calls };
}

/** A monerod node at `spec` holding vector `v`. */
function node(
	spec: string,
	v: { tx: Record<string, unknown>; txid: string; name: string },
	o: {
		confirmations?: number;
		inPool?: boolean;
		pruned?: boolean;
		prunableHash?: string;
		untrusted?: boolean;
		status?: string;
		missed?: boolean;
		asJson?: string;
	} = {}
): Route {
	const base = spec.slice('node+'.length);
	return (url) => {
		if (url !== `${base}/get_transactions`) return undefined;
		if (o.missed) return { json: { status: 'OK', untrusted: false, missed_tx: [v.txid] } };
		const tx = { ...v.tx };
		if (o.pruned) delete tx.rctsig_prunable;
		const entry: Record<string, unknown> = {
			tx_hash: v.txid,
			as_hex: '',
			as_json: o.asJson ?? JSON.stringify(tx),
			prunable_hash: o.prunableHash ?? PRUNABLE[v.name] ?? '',
			in_pool: o.inPool === true,
			double_spend_seen: false
		};
		if (o.inPool !== true) entry.confirmations = o.confirmations ?? 5;
		return {
			json: {
				status: o.status ?? 'OK',
				untrusted: o.untrusted ?? false,
				txs: [entry],
				txs_as_json: [entry.as_json]
			}
		};
	};
}

/** moneroblocks.info holding vector `v` at depth `depth` (block 100). */
function moneroblocks(v: { tx: unknown; txid: string }, depth = 4): Route {
	return (url) => {
		if (url === `https://moneroblocks.info/api/get_transaction_data/${v.txid}`)
			return { json: { status: 'OK', transaction_data: v.tx } };
		if (url === `https://moneroblocks.info/tx/${v.txid}`)
			return { text: '<dd><a href="/block/100">100</a></dd>' };
		if (url === 'https://moneroblocks.info/api/get_block_data/100')
			return {
				json: {
					status: 'OK',
					block_data: { result: { block_header: { height: 100, depth }, tx_hashes: [v.txid] } }
				}
			};
		return undefined;
	};
}
const dead: Route = (url) => (url.startsWith(DEAD) ? 'throw' : undefined);

const cfg = (explorerUrls: string[], feeAddress: string, min = 1) => ({
	feeAddress,
	explorerUrls,
	minConfirmations: 1,
	requestTimeoutMs: 2_000,
	minSuccessfulResponses: min
});
function claim(v: { txid: string; tx_key: string }, o: Partial<FeeClaim> = {}): FeeClaim {
	return {
		feeMethod: 'xmr',
		expectedAmount: FEE,
		externalTxId: v.txid,
		txProof: null,
		txKey: v.tx_key,
		permlink: 'p',
		signer: 's',
		xmrBinding: null,
		...o
	};
}
const bindingFor = (account: string, permlink: string) => {
	const p = parseXmrAddress(V.treasury.primary);
	if (!p.ok) throw new Error('bad');
	return {
		primaryAddress: V.treasury.primary,
		viewPub: p.value.viewPub,
		paymentId: xmrFeePaymentId(account, permlink)
	};
};
const SUB = byName('subaddress+change');
const BOUND = byName('integrated-primary+change');
const HOURS_3 = 3 * 60 * 60 * 1000;

describe('the node source kind', () => {
	it('node+https:// is a node; http, credentials and junk are refused', () => {
		expect(parseXmrExplorer('node+https://node.monero.fail/')).toEqual({
			kind: 'node',
			base: 'https://node.monero.fail'
		});
		expect(parseXmrExplorer('node+https://xmr-node.cakewallet.com:18081')).toEqual({
			kind: 'node',
			base: 'https://xmr-node.cakewallet.com:18081'
		});
		expect(parseXmrExplorer('node+http://node.example:18081')).toBeNull();
		expect(parseXmrExplorer('node+https://u:p@node.example')).toBeNull();
		expect(parseXmrExplorer('node+')).toBeNull();
	});
	it('the default list has the three explorers and three nodes, all valid', () => {
		expect(DEFAULT_XMR_EXPLORERS).toHaveLength(6);
		expect(DEFAULT_XMR_EXPLORERS.map((u) => parseXmrExplorer(u)?.kind)).toEqual([
			'txprove',
			'txprove',
			'raw-tx',
			'node',
			'node',
			'node'
		]);
	});
});

describe('a pruned copy is still checked against the txid (prunable_hash)', () => {
	it('the real mainnet transaction without its signatures + its prunable hash → its txid', () => {
		expect(moneroTxHash(MAINNET)).toBe(MAINNET_TXID);
		const pruned = { ...MAINNET };
		delete pruned.rctsig_prunable;
		expect(moneroTxHash(pruned, MAINNET_PRUNABLE_HASH)).toBe(MAINNET_TXID);
	});
	it('a wrong prunable hash does not give the txid; no prunable part and no hash → no answer', () => {
		const pruned = { ...MAINNET };
		delete pruned.rctsig_prunable;
		expect(moneroTxHash(pruned, 'ab'.repeat(32))).not.toBe(MAINNET_TXID);
		expect(moneroTxHash(pruned)).toBeNull();
		expect(moneroTxHash(pruned, 'zz')).toBeNull();
		expect(moneroTxHash(pruned, '0'.repeat(64))).toBeNull();
	});
	it('a full copy ignores a prunable hash that came with it', () => {
		expect(moneroTxHash(MAINNET, 'ab'.repeat(32))).toBe(MAINNET_TXID);
	});
});

describe('verifying through a node', () => {
	it('unbound: POSTs only the txid (never the tx key) and verifies locally', async () => {
		const { f, calls } = fetcher(node(NODE, SUB));
		const r = await new MoneroProofFeeVerifier(cfg([NODE], V.treasury.subaddress), f).verify(
			claim(SUB)
		);
		expect(r).toEqual({ kind: 'verified', observedAmount: FEE });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('https://node.example:18089/get_transactions');
		expect(calls[0]!.init?.method).toBe('POST');
		expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
			txs_hashes: [SUB.txid],
			decode_as_json: true,
			prune: false
		});
		expect(JSON.stringify(calls).includes(SUB.tx_key)).toBe(false);
	});
	it('a PRUNED node verifies the same payment', async () => {
		const { f } = fetcher(node(NODE, SUB, { pruned: true }));
		expect(
			await new MoneroProofFeeVerifier(cfg([NODE], V.treasury.subaddress), f).verify(claim(SUB))
		).toEqual({ kind: 'verified', observedAmount: FEE });
	});
	it('a pruned node with a made-up prunable hash is no answer', async () => {
		const { f } = fetcher(node(NODE, SUB, { pruned: true, prunableHash: 'ab'.repeat(32) }));
		const r = await new MoneroProofFeeVerifier(cfg([NODE], V.treasury.subaddress), f).verify(
			claim(SUB)
		);
		expect(r.kind).toBe('pending_external');
	});
	it('a node serving another transaction under this txid is no answer', async () => {
		const other = byName('two-outputs-same-primary+change');
		const { f } = fetcher(node(NODE, SUB, { asJson: JSON.stringify(other.tx) }));
		const r = await new MoneroProofFeeVerifier(cfg([NODE], V.treasury.subaddress), f).verify(
			claim(SUB)
		);
		expect(r.kind).toBe('pending_external');
	});
	it('missed_tx → not found', async () => {
		const { f } = fetcher(node(NODE, SUB, { missed: true }));
		const r = await new MoneroProofFeeVerifier(cfg([NODE], V.treasury.subaddress), f).verify(
			claim(SUB)
		);
		expect(r.kind).toBe('rejected');
		expect((r as { reason: string }).reason).toMatch(/^tx_not_found/);
	});
	it('a syncing node (untrusted) or a busy one is no answer', async () => {
		for (const o of [{ untrusted: true }, { status: 'BUSY' }]) {
			const { f } = fetcher(node(NODE, SUB, o));
			const r = await new MoneroProofFeeVerifier(cfg([NODE], V.treasury.subaddress), f).verify(
				claim(SUB)
			);
			expect(r.kind).toBe('pending_external');
		}
	});
	it('in the pool → 0 confirmations, not yet', async () => {
		const { f } = fetcher(node(NODE, SUB, { inPool: true }));
		const r = await new MoneroProofFeeVerifier(cfg([NODE], V.treasury.subaddress), f).verify(
			claim(SUB)
		);
		expect(r).toEqual({ kind: 'pending_external', reason: 'tx only 0 confirmations, need 1' });
	});
	it('bound: verified for the order whose payment ID it carries, refused for another', async () => {
		const { f } = fetcher(node(NODE, BOUND));
		const ver = new MoneroProofFeeVerifier(cfg([NODE], V.treasury.subaddress), f);
		expect(
			await ver.verify(claim(BOUND, { xmrBinding: bindingFor('alice', 'order-kx2mq7p4n8za') }))
		).toEqual({ kind: 'verified', observedAmount: FEE });
		expect(
			await ver.verify(claim(BOUND, { xmrBinding: bindingFor('mallory', 'order-copied') }))
		).toEqual({ kind: 'rejected', reason: 'payment_id_mismatch' });
	});
	it('a node and a raw-tx explorer that agree make a quorum of two', async () => {
		const { f } = fetcher(node(NODE, SUB), moneroblocks(SUB), dead);
		expect(
			await new MoneroProofFeeVerifier(cfg([NODE, RAW, DEAD], V.treasury.subaddress, 2), f).verify(
				claim(SUB)
			)
		).toEqual({ kind: 'verified', observedAmount: FEE });
	});
});

describe('only one source reachable (quorum of two)', () => {
	const ver = (f: typeof fetch, urls: string[]) =>
		new MoneroProofFeeVerifier(cfg(urls, V.treasury.subaddress, 2), f);

	it('at intake (not waited): still waits for a second source', async () => {
		const { f } = fetcher(moneroblocks(SUB, 20), dead);
		const r = await ver(f, [RAW, DEAD]).verify(claim(SUB));
		expect(r.kind).toBe('pending_external');
	});
	it('after two hours, 10+ blocks deep, everyone else unreachable: its answer is accepted', async () => {
		const { f } = fetcher(moneroblocks(SUB, 20), dead);
		const r = await ver(f, [RAW, DEAD]).verify(claim(SUB, { waitedMs: HOURS_3 }));
		expect(r).toEqual({ kind: 'verified', observedAmount: FEE });
	});
	it('the same through a node', async () => {
		const { f } = fetcher(node(NODE, SUB, { confirmations: 12 }), dead);
		const r = await ver(f, [NODE, DEAD]).verify(claim(SUB, { waitedMs: LONE_ANSWER_AFTER_MS }));
		expect(r).toEqual({ kind: 'verified', observedAmount: FEE });
	});
	it('not deep enough to stand alone: waits, and says why', async () => {
		const { f } = fetcher(node(NODE, SUB, { confirmations: 5 }), dead);
		const r = await ver(f, [NODE, DEAD]).verify(claim(SUB, { waitedMs: HOURS_3 }));
		expect(r).toEqual({
			kind: 'pending_external',
			reason: 'only one explorer reachable; tx 5 confirmations, need 10 to accept it alone'
		});
	});
	it('another source saying "not found" blocks it', async () => {
		const { f } = fetcher(
			node(NODE, SUB, { confirmations: 50 }),
			node(NODE2, SUB, { missed: true })
		);
		const r = await ver(f, [NODE, NODE2]).verify(claim(SUB, { waitedMs: HOURS_3 }));
		expect(r.kind).toBe('pending_external');
	});
	it('another source answering something different blocks it (no one source settles a disagreement)', async () => {
		const other = byName('two-outputs-same-primary+change');
		// NODE2 serves content that does not hash to the txid → unusable
		const { f } = fetcher(
			node(NODE, SUB, { confirmations: 50 }),
			node(NODE2, SUB, { asJson: JSON.stringify(other.tx) })
		);
		const r = await ver(f, [NODE, NODE2]).verify(claim(SUB, { waitedMs: HOURS_3 }));
		expect(r.kind).toBe('pending_external');
	});
	it('a lone answer never turns an underpayment or a wrong order into a payment', async () => {
		const { f } = fetcher(node(NODE, BOUND, { confirmations: 50 }), dead);
		const r = await ver(f, [NODE, DEAD]).verify(
			claim(BOUND, {
				waitedMs: HOURS_3,
				xmrBinding: bindingFor('mallory', 'order-copied')
			})
		);
		expect(r).toEqual({ kind: 'rejected', reason: 'payment_id_mismatch' });
		const { f: f2 } = fetcher(node(NODE, SUB, { confirmations: 50 }), dead);
		const u = await ver(f2, [NODE, DEAD]).verify(
			claim(SUB, { waitedMs: HOURS_3, expectedAmount: FEE * 10n })
		);
		expect(u.kind).toBe('rejected');
		expect((u as { reason: string }).reason).toMatch(/^underpaid/);
	});
});
