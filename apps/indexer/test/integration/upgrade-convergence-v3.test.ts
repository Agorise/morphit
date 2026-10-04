/**
 * v1.20.0 (V3-1) — a node that indexed the v1.20.0 release op, and the orders
 * after it, while still running v1.19 converges with the federation once it
 * upgrades (the ceremony's order for morphitir and morphitlat).
 *
 * "old" is given exactly what a v1.19 node leaves behind: the release row with
 * its treasury rebuilt from the fields v1.19 knew (no xpub, no
 * primary_address), the raw payloads in `ops`, the BTC order without a txid
 * and the XMR order with a tx key REJECTED with v1.19's reasons, and a later
 * cancel of one of those orders rejected for want of the order. "fresh"
 * indexes the same blocks on v1.20 through the real dispatcher. After the
 * upgrade reconcile, both hold the same pins, orders, addresses and event-log
 * verdicts, and number the next order the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { applyBlock } from '../../src/indexer/dispatcher';
import { reconcileAfterUpgrade } from '../../src/indexer/reconcileUpgrade';
import type { FeeVerifier } from '../../src/indexer/fee/verifier';
import { xmrFeePaymentId } from '@morphit/release-schema';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');
const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
const OFFICIAL_KEY = PrivateKey.fromSeed('upgrade-convergence-official');
const OFFICIAL_PUBKEY = OFFICIAL_KEY.createPublic().toString();
const acct = {
	name: 'morphit',
	posting: { weight_threshold: 1, account_auths: [], key_auths: [[OFFICIAL_PUBKEY, 1]] },
	active: { weight_threshold: 1, account_auths: [], key_auths: [] },
	owner: { weight_threshold: 1, account_auths: [], key_auths: [] },
	memo_key: OFFICIAL_PUBKEY
};
const XPUB_A =
	'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const SHARED = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const SUB =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const PRIMARY =
	'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
const TXKEY = 'e5b4fe26ae0a3a2f7d2bbed8a0c2a1c6d66925ccdbcb6bcef67a0ad66a9b9807';
const T0 = Date.parse('2026-09-28T12:00:00Z');

const release = {
	version: '1.20.0',
	hash_manifest: { 'index.html': 'sha256-' + 'a'.repeat(43) + '=' },
	treasury: {
		btc: { address: SHARED, satoshis: 1000, xpub: XPUB_A },
		xmr: { address: SUB, piconero: '781250000', primary_address: PRIMARY }
	}
};
const cj = (signer: string, id: string, json: unknown): [string, unknown] => [
	'custom_json',
	{ required_auths: [], required_posting_auths: [signer], id, json: JSON.stringify(json) }
];
const order = (permlink: string, extra: Record<string, unknown>) => ({
	permlink,
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 100,
	amount_max: 1000,
	price_model: { kind: 'spread', percent: 0 },
	payment_methods: ['cash'],
	...extra
});
const BLOCKS: Record<number, [string, unknown][]> = {
	100: [cj('morphit', 'morphit_release_v1', release)],
	101: [
		cj('alice', 'morphit_order_v1', order('a1', { fee_method: 'btc' })),
		cj('alice', 'morphit_order_v1', order('a2', { fee_method: 'btc' })),
		cj(
			'bob',
			'morphit_order_v1',
			order('x1', { fee_method: 'xmr', external_tx_id: 'c'.repeat(64), tx_key: TXKEY })
		)
	],
	102: [cj('alice', 'morphit_order_cancel_v1', { permlink: 'a2' })],
	103: [cj('carol', 'morphit_order_v1', order('c1', { fee_method: 'btc' }))]
};
/** What v1.19 wrote for blocks 100–102 (its reasons; its stripped treasury). */
const V119_VERDICT: Record<string, [string, string | null]> = {
	'100-0': ['applied', null],
	'101-0': ['rejected', 'external_tx_id_required_for_btc_xmr'],
	'101-1': ['rejected', 'external_tx_id_required_for_btc_xmr'],
	'101-2': ['rejected', 'tx_proof_required_for_xmr'],
	'102-0': ['rejected', 'target_not_found']
};

const xmr: FeeVerifier = {
	name: 'xmr-stub',
	verify: async (c) =>
		c.txKey === TXKEY && c.xmrBinding?.paymentId === xmrFeePaymentId('bob', 'x1')
			? { kind: 'verified', observedAmount: 781_250_000n }
			: { kind: 'rejected', reason: 'payment_id_mismatch' }
};
const btc: FeeVerifier = {
	name: 'btc-stub',
	verify: async () => ({ kind: 'pending_external', reason: 'x' })
};
const config = fakeConfig({
	officialPostingPubkey: OFFICIAL_PUBKEY,
	officialAccountName: 'morphit',
	chainId: CHAIN_ID
});

/** The transaction as the chain carries it: official ops are signed with the
 *  pinned key (release and rpc-directory ops are trusted by their signature). */
function trxOf(op: [string, unknown], blockTime: number): unknown {
	const body = op[1] as { required_posting_auths?: string[] };
	if (body.required_posting_auths?.[0] !== 'morphit') return { operations: [op] };
	return cryptoUtils.signTransaction(
		{
			ref_block_num: 1,
			ref_block_prefix: 2,
			expiration: new Date(blockTime + 60_000).toISOString().slice(0, 19),
			operations: [op],
			extensions: []
		} as never,
		[OFFICIAL_KEY],
		Buffer.from(CHAIN_ID, 'hex')
	);
}
const blurt = mockBlurt({ getAccount: async () => acct as never });
const amounts = { btcSatoshis: 1000, xmrPiconero: 781_250_000n };

describe.skipIf(!INTEGRATION_ENABLED)('upgrade from v1.19 converges (V3-1)', () => {
	let old: IntegrationFixture;
	let fresh: IntegrationFixture;
	beforeAll(async () => {
		old = await setupWithMigrations();
		fresh = await setupWithMigrations();
	});
	afterAll(async () => {
		await old?.teardown();
		await fresh?.teardown();
	});

	async function apply(f: IntegrationFixture, n: number): Promise<void> {
		const ops = BLOCKS[n]!;
		const c: pg.PoolClient = await f.pool.connect();
		try {
			await c.query(`SET search_path TO "${f.schema}"`);
			await c.query('BEGIN');
			await applyBlock(
				c,
				n,
				{
					timestamp: new Date(T0 + n * 3000).toISOString().slice(0, 19),
					transaction_ids: ops.map((_, i) => `trx-${n}-${i}`),
					transactions: ops.map((op) => trxOf(op, T0 + n * 3000))
				} as never,
				blurt,
				config,
				{ btc, xmr },
				amounts,
				((a: number) => a) as never
			);
			await c.query('COMMIT');
		} catch (e) {
			await c.query('ROLLBACK');
			throw e;
		} finally {
			c.release();
		}
	}

	/** Blocks 100–102 as a v1.19 node recorded them. */
	async function indexAsV119(f: IntegrationFixture): Promise<void> {
		for (const n of [100, 101, 102]) {
			for (const [i, op] of BLOCKS[n]!.entries()) {
				const body = op[1] as { id: string; json: string; required_posting_auths: string[] };
				const [status, reason] = V119_VERDICT[`${n}-${i}`]!;
				await f.db.query(
					`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status, reject_reason)
					 VALUES ($1, $2, 0, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
					[
						n,
						i,
						new Date(T0 + n * 3000),
						`trx-${n}-${i}`,
						body.required_posting_auths[0],
						body.id,
						body.json,
						status,
						reason
					]
				);
			}
		}
		// v1.19's release handler rebuilt the treasury from the fields it knew.
		await f.db.query(
			`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num, source_trx_id,
			                       signer, valid, created_at, treasury)
			 VALUES ('1.20.0', $1::jsonb, '{}'::jsonb, '', 100, 'trx-100-0', 'morphit', true, $2, $3::jsonb)`,
			[
				JSON.stringify(release.hash_manifest),
				new Date(T0 + 300_000),
				JSON.stringify({
					btc: { address: SHARED, satoshis: 1000 },
					xmr: { address: SUB, piconero: '781250000' }
				})
			]
		);
		await f.db.query(`UPDATE state SET last_applied_block = 102`).catch(() => {});
	}

	const snapshot = async (f: IntegrationFixture) => ({
		treasury: (await f.db.query(`SELECT treasury FROM releases WHERE valid`)).rows.map(
			(r) => r.treasury
		),
		orders: (
			await f.db.query(
				`SELECT account, permlink, status, fee_status, btc_fee_index, btc_fee_address, btc_fee_xpub,
				        xmr_payment_id, xmr_tx_key
				   FROM orders ORDER BY account, permlink`
			)
		).rows,
		ops: (
			await f.db.query(
				`SELECT block_num::int AS b, trx_in_block AS t, status, reject_reason FROM ops ORDER BY 1, 2`
			)
		).rows
	});

	it('same pins, orders, fee addresses and verdicts after the upgrade — and the same next address', async () => {
		for (const n of [100, 101, 102]) await apply(fresh, n);
		await indexAsV119(old);
		expect(await snapshot(old)).not.toEqual(await snapshot(fresh)); // the divergence V3 found

		await reconcileAfterUpgrade({
			db: old.db,
			blurt,
			config,
			feeVerifiers: { btc, xmr },
			feeAmounts: amounts,
			fiatToUsd: (a) => a
		});
		const o = await snapshot(old);
		const n = await snapshot(fresh);
		expect(o).toEqual(n);
		expect(o.orders.map((r) => [r.permlink, r.status, r.btc_fee_index])).toEqual([
			['a1', 'live', 0],
			['a2', 'cancelled', 1],
			['x1', 'live', null]
		]);

		// both nodes carry on identically
		for (const f of [old, fresh]) await apply(f, 103);
		expect(await snapshot(old)).toEqual(await snapshot(fresh));

		// idempotent: a second boot changes nothing
		await reconcileAfterUpgrade({
			db: old.db,
			blurt,
			config,
			feeVerifiers: { btc, xmr },
			feeAmounts: amounts,
			fiatToUsd: (a) => a
		});
		expect(await snapshot(old)).toEqual(await snapshot(fresh));
	});

	it('a release the current validator refuses (a malformed new block v1.19 ignored) stops pinning, as on a fresh node', async () => {
		const bad = {
			...release,
			version: '1.20.1',
			// v1.19 ignored `xpub`; the current validator refuses a malformed one.
			treasury: {
				...release.treasury,
				btc: { address: SHARED, satoshis: 1000, xpub: 'not-an-xpub' }
			}
		};
		const f2 = await setupWithMigrations();
		const o2 = await setupWithMigrations();
		try {
			const c = await f2.pool.connect();
			try {
				await c.query(`SET search_path TO "${f2.schema}"`);
				await c.query('BEGIN');
				await applyBlock(
					c,
					200,
					{
						timestamp: new Date(T0).toISOString().slice(0, 19),
						transaction_ids: ['trx-200-0'],
						transactions: [{ operations: [cj('morphit', 'morphit_release_v1', bad)] }]
					} as never,
					blurt,
					config,
					{ btc, xmr },
					amounts,
					((a: number) => a) as never
				);
				await c.query('COMMIT');
			} finally {
				c.release();
			}
			await o2.db.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
				 VALUES (200, 0, 0, $1, 'trx-200-0', 'morphit', 'morphit_release_v1', $2::jsonb, 'applied')`,
				[new Date(T0), JSON.stringify(bad)]
			);
			await o2.db.query(
				`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num, source_trx_id,
				                       signer, valid, created_at, treasury)
				 VALUES ('1.20.1', '{}'::jsonb, '{}'::jsonb, '', 200, 'trx-200-0', 'morphit', true, $1,
				         '{"btc":{"address":"${SHARED}","satoshis":1000},"xmr":null}'::jsonb)`,
				[new Date(T0)]
			);
			await reconcileAfterUpgrade({
				db: o2.db,
				blurt,
				config,
				feeVerifiers: { btc, xmr },
				feeAmounts: amounts,
				fiatToUsd: (a) => a
			});
			const view = async (f: IntegrationFixture) => ({
				pins: (await f.db.query(`SELECT count(*)::int AS n FROM releases WHERE valid`)).rows[0]?.n,
				op: (await f.db.query(`SELECT status, reject_reason FROM ops WHERE block_num = 200`))
					.rows[0]
			});
			expect(await view(o2)).toEqual(await view(f2));
			expect((await view(o2)).pins).toBe(0);
		} finally {
			await f2.teardown();
			await o2.teardown();
		}
	});
});
