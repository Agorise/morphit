/**
 * The release and rpc-directory ops are trusted only when the transaction the
 * block carries is signed by the pinned official posting key.
 *
 * WHAT WAS WRONG. Both handlers checked only that the op named the official
 * account and that ONE RPC endpoint, asked at apply time, reported the pinned
 * key for that account. A hostile node could serve a block holding an unsigned
 * op "from @morphit": its onion nodes joined the live RPC pool as separate
 * quorum operators and were stored for the relay, and a forged release could
 * move the treasury pin. And when that lookup failed (an RPC blip), the
 * handler threw, the dispatcher committed the op as rejected, and the node
 * lost a genuine release and its treasury pin for good.
 *
 * Real dispatcher, real Postgres, real signatures (dblurt).
 */
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');
const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
const OFFICIAL = PrivateKey.fromSeed('official-op-trust-official');
const OTHER = PrivateKey.fromSeed('official-op-trust-someone-else');
const CFG = {
	officialAccountName: 'morphit',
	officialPostingPubkey: OFFICIAL.createPublic().toString(),
	chainId: CHAIN_ID
};

const ATTACKER_NODES = ['a', 'b', 'c'].map((x) => ({
	onion: `http://${x.repeat(56)}.onion:8091`,
	name: `attacker-${x}`
}));

function trx(id: string, json: unknown, key: typeof OFFICIAL | null): unknown {
	const unsigned = {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: '2026-10-01T12:01:00',
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['morphit'],
					id,
					json: JSON.stringify(json)
				}
			]
		],
		extensions: []
	};
	if (key === null) return { ...unsigned, signatures: [] };
	return cryptoUtils.signTransaction(unsigned as never, [key], Buffer.from(CHAIN_ID, 'hex'));
}

function blockOf(t: unknown, n: number): unknown {
	return {
		timestamp: '2026-10-01T12:00:00',
		transaction_ids: [`${n}`.padStart(40, '0')],
		transactions: [t]
	};
}

const releasePayload = (version: string) => ({
	version,
	hash_manifest: { '/index.html': 'sha256-' + 'a'.repeat(43) + '=' },
	treasury: { btc: null, xmr: null, blurt: { base: 62.5 } }
});

interface Chain {
	merged: { urls: readonly string[]; ops: unknown }[];
	accountReads: number;
}

/** The chain as the dispatcher sees it: one operator (so the fee-relevant
 *  confirmation applies single-source), an account read that answers with the
 *  pinned key — or throws, for a blip — and a pool merge that is recorded. */
function chainStub(accountRead: 'honest' | 'throws'): {
	chain: Chain;
	blurt: ReturnType<typeof mockBlurt>;
} {
	const chain: Chain = { merged: [], accountReads: 0 };
	const blurt = mockBlurt({
		operatorCount: () => 1,
		reachableOperatorCount: () => 1,
		getAccount: (async () => {
			chain.accountReads++;
			if (accountRead === 'throws') throw new Error('all RPC endpoints failed');
			const auth = {
				weight_threshold: 1,
				account_auths: [],
				key_auths: [[CFG.officialPostingPubkey, 1]]
			};
			return {
				name: 'morphit',
				posting: auth,
				active: auth,
				owner: auth,
				memo_key: CFG.officialPostingPubkey
			};
		}) as never,
		mergeRpcEndpoints: ((urls: readonly string[], ops: unknown) => {
			chain.merged.push({ urls, ops });
			return [...urls];
		}) as never
	});
	return { chain, blurt };
}

async function apply(
	fx: IntegrationFixture,
	n: number,
	b: unknown,
	blurt: ReturnType<typeof mockBlurt>
): Promise<void> {
	const c: pg.PoolClient = await fx.pool.connect();
	try {
		await c.query(`SET search_path TO "${fx.schema}"`);
		await c.query('BEGIN');
		await applyBlock(c, n, b as never, blurt, fakeConfig(CFG), {}, {}, ((a: number) => a) as never);
		await c.query('COMMIT');
	} catch (e) {
		await c.query('ROLLBACK').catch(() => {});
		throw e;
	} finally {
		c.release();
	}
}

async function opVerdict(fx: IntegrationFixture, n: number): Promise<[string, string | null]> {
	const r = await fx.db.query<{ status: string; reject_reason: string | null }>(
		'SELECT status, reject_reason FROM ops WHERE block_num = $1',
		[n]
	);
	return [r.rows[0]!.status, r.rows[0]!.reject_reason];
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'official ops are trusted only when signed by the pinned key',
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			await fx?.teardown();
		});
		beforeEach(async () => {
			await truncateAll(fx);
			await fx.db.query('DELETE FROM rpc_directory');
		});

		const dir = { v: 1, ts: '2026-10-01T12:00:00Z', nodes: ATTACKER_NODES };

		it('an UNSIGNED rpc-directory op is rejected: nothing merged into the pool, nothing stored', async () => {
			const { chain, blurt } = chainStub('honest');
			await apply(fx, 10, blockOf(trx('morphit_rpc_v1', dir, null), 10), blurt);
			expect(await opVerdict(fx, 10)).toEqual(['rejected', 'not_signed_by_pinned_key']);
			expect(chain.merged).toEqual([]);
			expect((await fx.db.query('SELECT 1 FROM rpc_directory')).rowCount).toBe(0);
		});

		it('an rpc-directory op signed by any other key is rejected', async () => {
			const { chain, blurt } = chainStub('honest');
			await apply(fx, 11, blockOf(trx('morphit_rpc_v1', dir, OTHER), 11), blurt);
			expect(await opVerdict(fx, 11)).toEqual(['rejected', 'not_signed_by_pinned_key']);
			expect(chain.merged).toEqual([]);
			expect((await fx.db.query('SELECT 1 FROM rpc_directory')).rowCount).toBe(0);
		});

		it('an rpc-directory op signed by the pinned key is merged and stored, with no chain read', async () => {
			const { chain, blurt } = chainStub('throws');
			await apply(fx, 12, blockOf(trx('morphit_rpc_v1', dir, OFFICIAL), 12), blurt);
			expect(await opVerdict(fx, 12)).toEqual(['applied', null]);
			expect(chain.merged.length).toBe(1);
			expect((await fx.db.query('SELECT node_count FROM rpc_directory')).rows).toEqual([
				{ node_count: 3 }
			]);
			expect(chain.accountReads).toBe(0);
		});

		it('an UNSIGNED or wrongly signed release is recorded invalid and never moves the treasury pin', async () => {
			const { blurt } = chainStub('honest');
			await apply(
				fx,
				20,
				blockOf(trx('morphit_release_v1', releasePayload('9.9.9'), null), 20),
				blurt
			);
			await apply(
				fx,
				21,
				blockOf(trx('morphit_release_v1', releasePayload('9.9.8'), OTHER), 21),
				blurt
			);
			const rows = await fx.db.query<{ version: string; valid: boolean; invalid_reason: string }>(
				'SELECT version, valid, invalid_reason FROM releases ORDER BY source_block_num'
			);
			expect(rows.rows).toEqual([
				{ version: '9.9.9', valid: false, invalid_reason: 'not_signed_by_pinned_key' },
				{ version: '9.9.8', valid: false, invalid_reason: 'not_signed_by_pinned_key' }
			]);
		});

		it('a release signed by the pinned key is recorded valid even while every RPC read fails', async () => {
			const { chain, blurt } = chainStub('throws');
			await apply(
				fx,
				30,
				blockOf(trx('morphit_release_v1', releasePayload('1.20.4'), OFFICIAL), 30),
				blurt
			);
			expect(await opVerdict(fx, 30)).toEqual(['applied', null]);
			const rows = await fx.db.query<{ version: string; valid: boolean }>(
				'SELECT version, valid FROM releases'
			);
			expect(rows.rows).toEqual([{ version: '1.20.4', valid: true }]);
			expect(chain.accountReads).toBe(0);
		});
	}
);
