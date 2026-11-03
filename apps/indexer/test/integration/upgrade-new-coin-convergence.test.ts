/**
 * v1.22.0 — a coin added in a release: a node that indexed orders in it
 * while still on the version before converges with the federation once it
 * upgrades.
 *
 * "old" is given exactly what the version before the coin leaves behind: the
 * raw payloads in `ops`, the order in the new coin rejected 'asset_invalid',
 * the barter listing that accepts it rejected 'accepted_assets_entry_unknown',
 * the later replace of the first order rejected too, and the BLURT that paid
 * each listing fee recorded in fee_payments / fee_payment_legs (the
 * dispatcher records those for every fee op, whatever its verdict). "fresh"
 * indexes the same blocks on this version through the real dispatcher. XRP
 * plays the new coin: it is in this version's registry, and "old" refused it
 * as a version without it would have.
 *
 * After the upgrade reconcile both hold the same orders (fee verified from the
 * recorded transfers) and the same event-log verdicts; an order in a made-up
 * ticker stays refused and is never replayed; an order whose fee transfers are
 * not recorded yet waits for a later boot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { applyBlock } from '../../src/indexer/dispatcher';
import { recordFeePayment } from '../../src/indexer/feePayments';
import {
	reapplyObsoleteRejections,
	reconcileAfterUpgrade
} from '../../src/indexer/reconcileUpgrade';
import type { FeeVerifier } from '../../src/indexer/fee/verifier';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const T0 = Date.parse('2026-11-02T12:00:00Z');
const FEES = 'morphit-fees'; // this node's fee recipient and the canonical treasury

type Op = [string, Record<string, unknown>];
const cj = (signer: string, id: string, json: unknown): Op => [
	'custom_json',
	{ required_auths: [], required_posting_auths: [signer], id, json: JSON.stringify(json) }
];
const fee = (signer: string, permlink: string, blurt: string): Op => [
	'transfer',
	{ from: signer, to: FEES, amount: `${blurt} BLURT`, memo: `morphit-fee:${permlink}` }
];
const order = (permlink: string, extra: Record<string, unknown>) => ({
	permlink,
	side: 'sell',
	asset: 'XRP',
	fiat_currency: 'USD',
	amount_min: 100,
	amount_max: 1000,
	price_model: { kind: 'spread', percent: 0 },
	payment_methods: ['cash'],
	...extra
});

/** Each transaction: its operations, the Morphit op last. */
const BLOCKS: Record<number, Op[][]> = {
	101: [
		[fee('alice', 'x1', '1000.000'), cj('alice', 'morphit_order_v1', order('x1', {}))],
		[
			fee('bob', 'b1', '1000.000'),
			cj(
				'bob',
				'morphit_order_v1',
				order('b1', {
					asset: 'BARTER',
					price_model: { kind: 'fixed', price: 250 },
					accepted_assets: ['BTC', 'XRP']
				})
			)
		],
		[
			fee('mallory', 'f1', '1000.000'),
			cj('mallory', 'morphit_order_v1', order('f1', { asset: 'FAKE' }))
		]
	],
	102: [[cj('alice', 'morphit_order_replace_v1', order('x1', { amount_max: 2000 }))]],
	103: [[fee('carol', 'c1', '1000.000'), cj('carol', 'morphit_order_v1', order('c1', {}))]]
};
/** What the version before XRP wrote for blocks 101–103. */
const OLD_VERDICT: Record<string, [string, string | null]> = {
	'101-0': ['rejected', 'asset_invalid'],
	'101-1': ['rejected', 'accepted_assets_entry_unknown'],
	'101-2': ['rejected', 'asset_invalid'],
	'102-0': ['rejected', 'asset_invalid'],
	'103-0': ['rejected', 'asset_invalid']
};

const stub: FeeVerifier = {
	name: 'stub',
	verify: async () => ({ kind: 'pending_external', reason: 'x' })
};
const config = fakeConfig({ feeRecipient: FEES });
const blurt = mockBlurt({});
const amounts = { btcSatoshis: 1000, xmrPiconero: 781_250_000n };
const deps = (f: IntegrationFixture) => ({
	db: f.db,
	blurt,
	config,
	feeVerifiers: { btc: stub, xmr: stub },
	feeAmounts: amounts,
	fiatToUsd: (a: number) => a
});
const reconcile = (f: IntegrationFixture) => reconcileAfterUpgrade(deps(f));

describe.skipIf(!INTEGRATION_ENABLED)('upgrade that adds a coin converges', () => {
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
		const trxs = BLOCKS[n]!;
		const c: pg.PoolClient = await f.pool.connect();
		try {
			await c.query(`SET search_path TO "${f.schema}"`);
			await c.query('BEGIN');
			await applyBlock(
				c,
				n,
				{
					timestamp: new Date(T0 + n * 3000).toISOString().slice(0, 19),
					transaction_ids: trxs.map((_, i) => `trx-${n}-${i}`),
					transactions: trxs.map((operations) => ({ operations }))
				} as never,
				blurt,
				config,
				{ btc: stub, xmr: stub },
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

	/** Blocks as the version before the coin recorded them. */
	async function indexAsOld(f: IntegrationFixture, blocks: number[]): Promise<void> {
		for (const n of blocks) {
			for (const [i, operations] of BLOCKS[n]!.entries()) {
				const opInTrx = operations.length - 1;
				const body = operations[opInTrx]![1] as {
					id: string;
					json: string;
					required_posting_auths: string[];
				};
				const [status, reason] = OLD_VERDICT[`${n}-${i}`]!;
				const pos = {
					blockNum: n,
					trxInBlock: i,
					opInTrx,
					trxId: `trx-${n}-${i}`,
					blockTime: new Date(T0 + n * 3000),
					signer: body.required_posting_auths[0]!,
					opId: body.id,
					payload: JSON.parse(body.json) as unknown
				};
				await f.db.query(
					`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status, reject_reason)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
					[n, i, opInTrx, pos.blockTime, pos.trxId, pos.signer, pos.opId, body.json, status, reason]
				);
				await recordFeePayment(f.db, pos, operations as never);
			}
		}
	}

	const snapshot = async (f: IntegrationFixture) => ({
		orders: (
			await f.db.query(
				`SELECT account, permlink, asset, accepted_assets, status, fee_status, fee_method, amount_max::text
				   FROM orders ORDER BY account, permlink`
			)
		).rows,
		ops: (
			await f.db.query(
				`SELECT block_num::int AS b, trx_in_block AS t, status, reject_reason FROM ops ORDER BY 1, 2`
			)
		).rows
	});

	it('same orders, fees and verdicts after the upgrade; a made-up ticker stays refused', async () => {
		for (const n of [101, 102]) await apply(fresh, n);
		await indexAsOld(old, [101, 102]);
		expect(await snapshot(old)).not.toEqual(await snapshot(fresh));

		await reconcile(old);
		const o = await snapshot(old);
		expect(o).toEqual(await snapshot(fresh));
		expect(
			o.orders.map((r) => [r.permlink, r.asset, r.status, r.fee_status, r.amount_max])
		).toEqual([
			['x1', 'XRP', 'live', 'verified', '2000'],
			['b1', 'BARTER', 'live', 'verified', '1000']
		]);
		expect(o.ops.find((r) => r.b === 101 && r.t === 2)).toEqual({
			b: 101,
			t: 2,
			status: 'rejected',
			reject_reason: 'asset_invalid'
		});

		// idempotent: a second boot changes nothing, and reads nothing — the
		// order in a made-up ticker is not even picked up for a replay
		const again = await reapplyObsoleteRejections(deps(old));
		expect(again).toEqual({ scanned: 0, healed: 0, dependentsHealed: 0 });
		expect(await snapshot(old)).toEqual(await snapshot(fresh));
	});

	it('an order whose fee transfers are not recorded yet waits, then heals', async () => {
		await apply(fresh, 103);
		await indexAsOld(old, [103]);
		await old.db.query(`DELETE FROM fee_payment_legs WHERE block_num = 103`);
		await old.db.query(`DELETE FROM fee_payments WHERE block_num = 103`);

		await reconcile(old);
		const waiting = (await snapshot(old)).ops.find((r) => r.b === 103);
		expect(waiting).toEqual({ b: 103, t: 0, status: 'rejected', reject_reason: 'asset_invalid' });

		// the back-fill records them; the next boot heals the order
		const operations = BLOCKS[103]![0]!;
		const body = operations[1]![1] as { json: string };
		await recordFeePayment(
			old.db,
			{
				blockNum: 103,
				trxInBlock: 0,
				opInTrx: 1,
				trxId: 'trx-103-0',
				blockTime: new Date(T0 + 103 * 3000),
				signer: 'carol',
				opId: 'morphit_order_v1',
				payload: JSON.parse(body.json) as unknown
			},
			operations as never
		);
		await reconcile(old);
		expect(await snapshot(old)).toEqual(await snapshot(fresh));
	});
});
