/**
 * v1.22.0 — the upgrade replay judges an order AS OF ITS OWN POSITION in the
 * chain, and heals it together with its later cancel.
 *
 * A node on the version before a coin was added refuses the orders in it but
 * keeps applying the same account's other ops. When it upgrades, the replay
 * judges the refused order after those later ops are already stored, so:
 *
 * 1. Its Sybil tier must count only the orders that existed at its position.
 *    Counting the table as it stands also counted the account's LATER order:
 *    a 3rd order that paid the 1× fee was charged as a 4th (1.25×) and stored
 *    'underpaid', hidden, where every other node shows it.
 * 2. The first-buy waiver's "has this account posted before?" likewise counts
 *    only orders before the op (the handler is called directly: no refusal
 *    reason replayed today reaches a waiver, so this guards the next one).
 * 3. The order and its later cancel are healed in ONE transaction. They were
 *    two: a process that died after the first left the order healed, and the
 *    next boot never replayed the cancel (its order no longer needed healing),
 *    so the listing stayed live there for good.
 *
 * 4. The orders in the added coin have their own scan, read until none is
 *    left. They shared one batch with the v1.19 reasons, which this version
 *    still gives for a malformed payload: such rows, earlier in the chain,
 *    filled the batch at every boot and the coin's orders were never reached.
 * 5. A dependent op that fails for a reason other than "still refused" (a
 *    timeout, a lost connection) undoes the whole heal, order included, and
 *    the next boot heals both. Kept, the order was healed and its cancel
 *    refused for good.
 * 6. An order that had ENDED before the replayed op does not count toward its
 *    tier, even when its updated_at moved later (a counterparty named on a
 *    completed order, a fee attestation, a fee re-check). Read from
 *    updated_at alone, it counted, and the replayed order that paid 1× was
 *    stored underpaid.
 * 7. "Before" and "after" are the order the live pass applied ops in: a
 *    block's order ops run before its other ops (sortOpsForAdmission). So an
 *    order cancelled in the same block as the replayed order, even in an
 *    earlier transaction, was still live when it was counted; one cancelled
 *    later counts too (also when the event log lacks its cancel); and a
 *    cancel placed in an earlier transaction of the order's own block is
 *    replayed after it.
 * 8. A dependent op that throws for any other reason than a passing database
 *    trouble is recorded as the live pass records it ('handler_threw:…'): the
 *    order is healed and the next boot has nothing left to do.
 * 9. Only dependents refused because the order was missing are replayed: a
 *    cancel the dispatcher refused before any handler ran (invalid_text) stays
 *    refused, as on every node.
 * 10. An account whose refused order cannot be judged this boot (its heal was
 *    undone by a passing database trouble, or its fee transfers are not
 *    recorded yet) is not healed further this boot: its later orders would be
 *    judged without that order, for good.
 * 11. Every row of the older scan is read, not one batch: an older-scan order
 *    left for a later boot was missing from the tier of the account's later
 *    order in the added coin, for good.
 * 12. A lost connection is not the op's fault: when it also makes the
 *    savepoint's rollback fail (masking the first error), the heal is still
 *    undone for the next boot. Recorded 'handler_threw:Client has encountered
 *    a connection error…', the order stayed refused for good.
 * 13. An order whose permlink the account used again for a later order, which
 *    this node applied meanwhile, stays refused ('permlink_taken_since'):
 *    replayed, it was marked applied while the row stayed the later order's.
 *    (A node that knew the coin holds the first order; a replay cannot undo
 *    that.)
 *
 * XRP plays the coin the old version did not know, as in
 * upgrade-new-coin-convergence.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { applyBlock } from '../../src/indexer/dispatcher';
import { recordFeePayment } from '../../src/indexer/feePayments';
import orderHandler from '../../src/indexer/handlers/order';
import { FEDERATION_BLURT_BASE } from '../../src/indexer/fee/feeRulesAtBlock';
import { reconcileAfterUpgrade } from '../../src/indexer/reconcileUpgrade';
import type { FeeVerifier } from '../../src/indexer/fee/verifier';
import type { OpContext } from '../../src/indexer/handler-contract';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const T0 = Date.parse('2026-11-02T12:00:00Z');
/** The coin "old" did not know: a REAL ticker of this version, which "old"
 *  refused as the version before it would have (the replay must accept it). */
const ADDED_COIN = 'XRP';
const FEES = 'morphit-fees'; // this node's fee recipient and the canonical treasury
/** Exactly the 1× listing fee (no release pins a base here, so the
 *  federation's default is in force: T0 is after the activation time). */
const ONE_X = FEDERATION_BLURT_BASE.toFixed(3);

type Op = [string, Record<string, unknown>];
const cj = (signer: string, id: string, json: unknown): Op => [
	'custom_json',
	{ required_auths: [], required_posting_auths: [signer], id, json: JSON.stringify(json) }
];
const fee = (signer: string, permlink: string, blurt: string): Op => [
	'transfer',
	{ from: signer, to: FEES, amount: `${blurt} BLURT`, memo: `morphit-fee:${permlink}` }
];
const order = (permlink: string, extra: Record<string, unknown> = {}) => ({
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

/** Each transaction: its operations, the Morphit op last. */
const BLOCKS: Record<number, Op[][]> = {
	// dave: two orders, then a 3rd in the new coin paying exactly 1×, then a 4th
	201: [
		[fee('dave', 'd1', '1000.000'), cj('dave', 'morphit_order_v1', order('d1'))],
		[fee('dave', 'd2', '1000.000'), cj('dave', 'morphit_order_v1', order('d2'))]
	],
	202: [
		[fee('dave', 'd3', ONE_X), cj('dave', 'morphit_order_v1', order('d3', { asset: ADDED_COIN }))]
	],
	203: [[fee('dave', 'd4', '1000.000'), cj('dave', 'morphit_order_v1', order('d4'))]],
	// erin: an order in the new coin, cancelled in the next block
	301: [
		[
			fee('erin', 'e1', '1000.000'),
			cj('erin', 'morphit_order_v1', order('e1', { asset: ADDED_COIN }))
		]
	],
	302: [[cj('erin', 'morphit_order_cancel_v1', { permlink: 'e1' })]],
	// frank: his first order, posted before his BTC sell in block 402
	402: [[fee('frank', 'g2', '1000.000'), cj('frank', 'morphit_order_v1', order('g2'))]],
	// mallory: three XMR-fee orders with no transaction ID (refused today too)…
	501: ['m1', 'm2', 'm3'].map((p) => [
		cj('mallory', 'morphit_order_v1', order(p, { fee_method: 'xmr' }))
	]),
	// …then zed's two orders in the new coin
	502: ['z1', 'z2'].map((p) => [
		fee('zed', p, '1000.000'),
		cj('zed', 'morphit_order_v1', order(p, { asset: ADDED_COIN }))
	]),
	// gina: an order in the new coin, cancelled in the next block
	601: [
		[
			fee('gina', 'g1', '1000.000'),
			cj('gina', 'morphit_order_v1', order('g1', { asset: ADDED_COIN }))
		]
	],
	602: [[cj('gina', 'morphit_order_cancel_v1', { permlink: 'g1' })]],
	// hank: an order completed more than 24 h before his 3rd order (in the new
	// coin, paying exactly 1×), two live orders just before it
	1000: [[fee('hank', 'h0', '1000.000'), cj('hank', 'morphit_order_v1', order('h0'))]],
	1001: [[cj('hank', 'morphit_order_complete_v1', { permlink: 'h0' })]],
	30000: [
		[fee('hank', 'h1', '1000.000'), cj('hank', 'morphit_order_v1', order('h1'))],
		[fee('hank', 'h2', '1000.000'), cj('hank', 'morphit_order_v1', order('h2'))]
	],
	30001: [
		[fee('hank', 'h3', ONE_X), cj('hank', 'morphit_order_v1', order('h3', { asset: ADDED_COIN }))]
	],
	// kim: k0 more than 24 h old, cancelled in the SAME block as her 3rd order
	// (an earlier transaction): the live pass still counted it
	3000: [[fee('kim', 'k0', '1000.000'), cj('kim', 'morphit_order_v1', order('k0'))]],
	40000: [
		[fee('kim', 'k1', '1000.000'), cj('kim', 'morphit_order_v1', order('k1'))],
		[fee('kim', 'k2', '1000.000'), cj('kim', 'morphit_order_v1', order('k2'))],
		[cj('kim', 'morphit_order_cancel_v1', { permlink: 'k0' })],
		[fee('kim', 'k3', ONE_X), cj('kim', 'morphit_order_v1', order('k3', { asset: ADDED_COIN }))]
	],
	// lena and luke: l0/u0 more than 24 h old, cancelled in a LATER block
	4000: [
		[fee('lena', 'l0', '1000.000'), cj('lena', 'morphit_order_v1', order('l0'))],
		[fee('luke', 'u0', '1000.000'), cj('luke', 'morphit_order_v1', order('u0'))]
	],
	43000: [
		[fee('lena', 'l1', '1000.000'), cj('lena', 'morphit_order_v1', order('l1'))],
		[fee('lena', 'l2', '1000.000'), cj('lena', 'morphit_order_v1', order('l2'))],
		[fee('luke', 'u1', '1000.000'), cj('luke', 'morphit_order_v1', order('u1'))],
		[fee('luke', 'u2', '1000.000'), cj('luke', 'morphit_order_v1', order('u2'))]
	],
	43001: [
		[fee('lena', 'l3', ONE_X), cj('lena', 'morphit_order_v1', order('l3', { asset: ADDED_COIN }))],
		[fee('luke', 'u3', ONE_X), cj('luke', 'morphit_order_v1', order('u3', { asset: ADDED_COIN }))]
	],
	43002: [
		[cj('lena', 'morphit_order_cancel_v1', { permlink: 'l0' })],
		[cj('luke', 'morphit_order_cancel_v1', { permlink: 'u0' })]
	],
	// lou: a cancel in an EARLIER transaction of his order's own block
	50000: [
		[cj('lou', 'morphit_order_cancel_v1', { permlink: 'o1' })],
		[
			fee('lou', 'o1', '1000.000'),
			cj('lou', 'morphit_order_v1', order('o1', { asset: ADDED_COIN }))
		]
	],
	// nina: like kim, and the old node's event log lacks the cancel
	3001: [[fee('nina', 'n0', '1000.000'), cj('nina', 'morphit_order_v1', order('n0'))]],
	41000: [
		[fee('nina', 'n1', '1000.000'), cj('nina', 'morphit_order_v1', order('n1'))],
		[fee('nina', 'n2', '1000.000'), cj('nina', 'morphit_order_v1', order('n2'))],
		[cj('nina', 'morphit_order_cancel_v1', { permlink: 'n0' })],
		[fee('nina', 'n3', ONE_X), cj('nina', 'morphit_order_v1', order('n3', { asset: ADDED_COIN }))]
	],
	// olga: a cancel the dispatcher refuses before any handler runs
	52000: [
		[
			fee('olga', 'v1', '1000.000'),
			cj('olga', 'morphit_order_v1', order('v1', { asset: ADDED_COIN }))
		]
	],
	52001: [[cj('olga', 'morphit_order_cancel_v1', { permlink: 'v1', note: 'a\u0000b' })]],
	// pia: p2 (new coin) is cancelled later; p3 (new coin) pays 1×
	53000: [
		[fee('pia', 'p0', '1000.000'), cj('pia', 'morphit_order_v1', order('p0'))],
		[fee('pia', 'p1', '1000.000'), cj('pia', 'morphit_order_v1', order('p1'))]
	],
	53001: [
		[
			fee('pia', 'p2', '1000.000'),
			cj('pia', 'morphit_order_v1', order('p2', { asset: ADDED_COIN }))
		]
	],
	53002: [
		[fee('pia', 'p3', ONE_X), cj('pia', 'morphit_order_v1', order('p3', { asset: ADDED_COIN }))]
	],
	53003: [[cj('pia', 'morphit_order_cancel_v1', { permlink: 'p2' })]],
	// quin: q2 (new coin) has no fee rows recorded yet; q3 (new coin) pays 1×
	54000: [
		[fee('quin', 'q0', '1000.000'), cj('quin', 'morphit_order_v1', order('q0'))],
		[fee('quin', 'q1', '1000.000'), cj('quin', 'morphit_order_v1', order('q1'))]
	],
	54001: [
		[
			fee('quin', 'q2', '1000.000'),
			cj('quin', 'morphit_order_v1', order('q2', { asset: ADDED_COIN }))
		]
	],
	54002: [
		[fee('quin', 'q3', ONE_X), cj('quin', 'morphit_order_v1', order('q3', { asset: ADDED_COIN }))]
	],
	// sara: s0 (BLURT fee), then two XMR-fee orders the v1.19 handler refused
	// (a tx_key, no OutProof), then s3 in the new coin paying exactly 1×: the
	// 4th order, so underpaid
	56000: [[fee('sara', 's0', '1000.000'), cj('sara', 'morphit_order_v1', order('s0'))]],
	56001: [1, 2].map((i) => [
		cj(
			'sara',
			'morphit_order_v1',
			order(`s${i}`, {
				fee_method: 'xmr',
				external_tx_id: String(i).repeat(64),
				tx_key: String(i + 2).repeat(64)
			})
		)
	]),
	56002: [
		[fee('sara', 's3', ONE_X), cj('sara', 'morphit_order_v1', order('s3', { asset: ADDED_COIN }))]
	],
	// rita: an order in the new coin, cancelled in the next block
	57000: [
		[
			fee('rita', 'r1', '1000.000'),
			cj('rita', 'morphit_order_v1', order('r1', { asset: ADDED_COIN }))
		]
	],
	57001: [[cj('rita', 'morphit_order_cancel_v1', { permlink: 'r1' })]],
	// tina: t1 in the new coin, then t1 again (BTC) in the next block
	58000: [
		[
			fee('tina', 't1', '1000.000'),
			cj('tina', 'morphit_order_v1', order('t1', { asset: ADDED_COIN }))
		]
	],
	58001: [[fee('tina', 't1', '1000.000'), cj('tina', 'morphit_order_v1', order('t1'))]],
	// mike: an order in the new coin, cancelled in the next block
	51000: [
		[
			fee('mike', 'm1', '1000.000'),
			cj('mike', 'morphit_order_v1', order('m1', { asset: ADDED_COIN }))
		]
	],
	51001: [[cj('mike', 'morphit_order_cancel_v1', { permlink: 'm1' })]]
};
/** What the version before XRP wrote for the ops it refused. */
const OLD_VERDICT: Record<string, [string, string | null]> = {
	'202-0': ['rejected', 'asset_invalid'],
	'301-0': ['rejected', 'asset_invalid'],
	'302-0': ['rejected', 'target_not_found'],
	'501-0': ['rejected', 'external_tx_id_required_for_btc_xmr'],
	'501-1': ['rejected', 'external_tx_id_required_for_btc_xmr'],
	'501-2': ['rejected', 'external_tx_id_required_for_btc_xmr'],
	'502-0': ['rejected', 'asset_invalid'],
	'502-1': ['rejected', 'asset_invalid'],
	'601-0': ['rejected', 'asset_invalid'],
	'602-0': ['rejected', 'target_not_found'],
	'30001-0': ['rejected', 'asset_invalid'],
	'40000-3': ['rejected', 'asset_invalid'],
	'43001-0': ['rejected', 'asset_invalid'],
	'43001-1': ['rejected', 'asset_invalid'],
	'50000-0': ['rejected', 'target_not_found'],
	'50000-1': ['rejected', 'asset_invalid'],
	'51000-0': ['rejected', 'asset_invalid'],
	'51001-0': ['rejected', 'target_not_found'],
	'41000-3': ['rejected', 'asset_invalid'],
	'52000-0': ['rejected', 'asset_invalid'],
	'53001-0': ['rejected', 'asset_invalid'],
	'53002-0': ['rejected', 'asset_invalid'],
	'53003-0': ['rejected', 'target_not_found'],
	'54001-0': ['rejected', 'asset_invalid'],
	'54002-0': ['rejected', 'asset_invalid'],
	'56001-0': ['rejected', 'tx_proof_required_for_xmr'],
	'56001-1': ['rejected', 'tx_proof_required_for_xmr'],
	'56002-0': ['rejected', 'asset_invalid'],
	'57000-0': ['rejected', 'asset_invalid'],
	'57001-0': ['rejected', 'target_not_found'],
	'58000-0': ['rejected', 'asset_invalid']
};

const stub: FeeVerifier = {
	name: 'stub',
	verify: async () => ({ kind: 'pending_external', reason: 'x' })
};
const config = fakeConfig({ feeRecipient: FEES });
const blurt = mockBlurt({});
const amounts = { btcSatoshis: 1000, xmrPiconero: 781_250_000n };
const fiatToUsd = (a: number) => a;
const deps = (db: IntegrationFixture['db'], maxRows?: number) => ({
	db,
	...(maxRows !== undefined ? { maxRows } : {}),
	blurt,
	config,
	feeVerifiers: { btc: stub, xmr: stub },
	feeAmounts: amounts,
	fiatToUsd
});

describe.skipIf(!INTEGRATION_ENABLED)('upgrade replay judges an op as of its position', () => {
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

	/** Block `n` through the real dispatcher; `firstK`: only its first K
	 *  transactions (an old node that refused the last ones). */
	async function apply(f: IntegrationFixture, n: number, firstK?: number): Promise<void> {
		const trxs = firstK === undefined ? BLOCKS[n]! : BLOCKS[n]!.slice(0, firstK);
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
				fiatToUsd as never
			);
			await c.query('COMMIT');
		} catch (e) {
			await c.query('ROLLBACK');
			throw e;
		} finally {
			c.release();
		}
	}

	/** A block as the version before the coin recorded it: every op refused. */
	async function indexAsOld(f: IntegrationFixture, n: number, fromTrx = 0): Promise<void> {
		for (const [i, operations] of BLOCKS[n]!.entries()) {
			if (i < fromTrx) continue;
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

	const snapshot = async (f: IntegrationFixture, account: string) => ({
		orders: (
			await f.db.query(
				`SELECT permlink, asset, status, fee_status FROM orders WHERE account = $1 ORDER BY permlink`,
				[account]
			)
		).rows,
		ops: (
			await f.db.query(
				`SELECT block_num::int AS b, trx_in_block AS t, status, reject_reason
				   FROM ops WHERE signer = $1 ORDER BY 1, 2`,
				[account]
			)
		).rows
	});

	it('charges the tier the order had at its own position, not after later orders', async () => {
		for (const n of [201, 202, 203]) await apply(fresh, n);
		await apply(old, 201);
		await indexAsOld(old, 202);
		await apply(old, 203);

		const want = await snapshot(fresh, 'dave');
		expect(want.orders.find((o) => o.permlink === 'd3')).toEqual({
			permlink: 'd3',
			asset: ADDED_COIN,
			status: 'live',
			fee_status: 'verified'
		});
		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'dave')).toEqual(want);
	});

	it('heals the order and its cancel together, so a crash between them loses nothing', async () => {
		for (const n of [301, 302]) await apply(fresh, n);
		for (const n of [301, 302]) await indexAsOld(old, n);

		// The process dies right after its first commit: every later
		// transaction fails.
		let commits = 0;
		const dying = {
			query: old.db.query.bind(old.db),
			withTx: async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
				if (commits >= 1) throw new Error('process died');
				const r = await old.db.withTx(fn);
				commits++;
				return r;
			}
		};
		await reconcileAfterUpgrade(deps(dying as never));
		// the next boot, on a healthy process
		await reconcileAfterUpgrade(deps(old.db));

		const want = await snapshot(fresh, 'erin');
		expect(want.orders).toEqual([
			{ permlink: 'e1', asset: ADDED_COIN, status: 'cancelled', fee_status: 'verified' }
		]);
		expect(await snapshot(old, 'erin')).toEqual(want);
	});

	it('the first-buy waiver counts only orders posted before the op', async () => {
		await apply(old, 402); // frank's later order is already stored
		const waiver = order('g1', {
			side: 'buy',
			asset: 'BLURT',
			fee_method: 'waived_first_buy'
		});
		const judge = async (judgedOutOfOrder: boolean) =>
			old.db
				.withTx(async (c) => {
					const ctx: OpContext = {
						blockNum: 401,
						trxInBlock: 0,
						opInTrx: 0,
						blockTime: new Date(T0 + 401 * 3000),
						trxId: 'trx-401-0',
						signer: 'frank',
						payload: waiver,
						siblingOps: [],
						blurt,
						config,
						feeVerifiers: { btc: stub, xmr: stub },
						feeAmounts: amounts,
						fiatToUsd,
						recordOrderbookChange: () => {},
						recordChatChange: () => {},
						...(judgedOutOfOrder ? { judgedOutOfOrder: true as const } : {})
					};
					const r = await orderHandler(ctx, c);
					// throw to roll back: the table stays as it was for the next call
					throw { verdict: r.ok ? 'applied' : r.reason };
				})
				.catch((e: { verdict?: string }) => {
					if (e.verdict === undefined) throw e;
					return e.verdict;
				});

		// the live pass at block 403 would refuse it: frank has posted before
		expect(await judge(false)).toBe('waiver_not_first_order');
		// judged at its own position (block 401), frank had posted nothing yet
		expect(await judge(true)).toBe('applied');
	});

	it('malformed rows of the older scan cannot starve the added coin’s orders', async () => {
		for (const n of [501, 502]) await apply(fresh, n);
		for (const n of [501, 502]) await indexAsOld(old, n);
		// this version refuses mallory's orders for the very same reason
		expect((await snapshot(fresh, 'mallory')).ops.map((r) => r.reject_reason)).toEqual([
			'external_tx_id_required_for_btc_xmr',
			'external_tx_id_required_for_btc_xmr',
			'external_tx_id_required_for_btc_xmr'
		]);

		// a batch of one: smaller than mallory's rows and than zed's
		await reconcileAfterUpgrade(deps(old.db, 1));
		const want = await snapshot(fresh, 'zed');
		expect(want.orders.map((o) => [o.permlink, o.status, o.fee_status])).toEqual([
			['z1', 'live', 'verified'],
			['z2', 'live', 'verified']
		]);
		expect(await snapshot(old, 'zed')).toEqual(want);
		expect(await snapshot(old, 'mallory')).toEqual(await snapshot(fresh, 'mallory'));
	});

	it('a dependent op that fails another way undoes the whole heal; the next boot heals both', async () => {
		for (const n of [601, 602]) await apply(fresh, n);
		for (const n of [601, 602]) await indexAsOld(old, n);

		// The cancel's UPDATE fails once, as a timeout or a lost connection would.
		let failed = false;
		const flaky = {
			query: old.db.query.bind(old.db),
			withTx: <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
				old.db.withTx((c) =>
					fn(
						new Proxy(c, {
							get(target, prop, recv) {
								if (prop !== 'query') return Reflect.get(target, prop, recv);
								return (text: unknown, ...rest: unknown[]) => {
									if (
										!failed &&
										typeof text === 'string' &&
										/SET status = 'cancelled'/.test(text)
									) {
										failed = true;
										return Promise.reject(
											new Error('canceling statement due to statement timeout')
										);
									}
									return (target.query as (...a: unknown[]) => unknown).call(target, text, ...rest);
								};
							}
						})
					)
				)
		};
		await reconcileAfterUpgrade(deps(flaky as never));
		expect(failed).toBe(true);
		// nothing of it was kept: the order is still refused, so it is picked up again
		expect((await snapshot(old, 'gina')).orders).toEqual([]);

		await reconcileAfterUpgrade(deps(old.db));
		const want = await snapshot(fresh, 'gina');
		expect(want.orders).toEqual([
			{ permlink: 'g1', asset: ADDED_COIN, status: 'cancelled', fee_status: 'verified' }
		]);
		expect(await snapshot(old, 'gina')).toEqual(want);
	});

	it('an order that ended before the op does not count toward its tier, whatever its updated_at', async () => {
		for (const n of [1000, 1001, 30000, 30001]) await apply(fresh, n);
		for (const n of [1000, 1001, 30000]) await apply(old, n);
		await indexAsOld(old, 30001);
		// Later, something moves h0's updated_at past the 3rd order's block on
		// both nodes (naming the trade partner, a fee attestation or a fee
		// re-check all do).
		const later = new Date(T0 + 30002 * 3000);
		for (const f of [fresh, old])
			await f.db.query(
				`UPDATE orders SET updated_at = $1 WHERE account = 'hank' AND permlink = 'h0'`,
				[later]
			);

		const want = await snapshot(fresh, 'hank');
		expect(want.orders.map((o) => [o.permlink, o.status, o.fee_status])).toEqual([
			['h0', 'completed', 'verified'],
			['h1', 'live', 'verified'],
			['h2', 'live', 'verified'],
			['h3', 'live', 'verified']
		]);
		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'hank')).toEqual(want);
	});

	it('counts in the order the live pass applied ops: same-block and later ends', async () => {
		for (const n of [3000, 40000, 4000, 43000, 43001, 43002]) await apply(fresh, n);
		await apply(old, 3000);
		await apply(old, 40000, 3); // the old node applied k1, k2 and the cancel of k0…
		await indexAsOld(old, 40000, 3); // …and refused k3
		await apply(old, 4000);
		await apply(old, 43000);
		await indexAsOld(old, 43001);
		await apply(old, 43002);
		// luke's cancel is missing from the old node's event log (a restored
		// snapshot without its op log): his order's updated_at says when it ended
		await old.db.query(
			`DELETE FROM ops WHERE signer = 'luke' AND op_id = 'morphit_order_cancel_v1'`
		);

		const fk = await snapshot(fresh, 'kim');
		// the live pass counted k0 (its cancel ran after the block's order ops):
		// k3 is the 4th order and 1× is underpaid
		expect(fk.orders.find((o) => o.permlink === 'k3')).toEqual({
			permlink: 'k3',
			asset: ADDED_COIN,
			status: 'live',
			fee_status: 'underpaid'
		});
		const fl = await snapshot(fresh, 'lena');
		expect(fl.orders.find((o) => o.permlink === 'l3')?.fee_status).toBe('underpaid');

		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'kim')).toEqual(fk);
		expect(await snapshot(old, 'lena')).toEqual(fl);
		expect((await snapshot(old, 'luke')).orders).toEqual((await snapshot(fresh, 'luke')).orders);
	});

	it('replays a cancel placed in an earlier transaction of the order’s own block', async () => {
		await apply(fresh, 50000);
		await indexAsOld(old, 50000);
		const want = await snapshot(fresh, 'lou');
		expect(want.orders).toEqual([
			{ permlink: 'o1', asset: ADDED_COIN, status: 'cancelled', fee_status: 'verified' }
		]);
		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'lou')).toEqual(want);
	});

	it('a dependent that throws for a reason of its own is recorded as the live pass records it', async () => {
		for (const n of [51000, 51001]) await indexAsOld(old, n);
		const throwing = {
			query: old.db.query.bind(old.db),
			withTx: <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
				old.db.withTx((c) =>
					fn(
						new Proxy(c, {
							get(target, prop, recv) {
								if (prop !== 'query') return Reflect.get(target, prop, recv);
								return (text: unknown, ...rest: unknown[]) => {
									if (typeof text === 'string' && /SET status = 'cancelled'/.test(text))
										return Promise.reject(new Error('boom'));
									return (target.query as (...a: unknown[]) => unknown).call(target, text, ...rest);
								};
							}
						})
					)
				)
		};
		await reconcileAfterUpgrade(deps(throwing as never));
		const got = await snapshot(old, 'mike');
		expect(got.orders).toEqual([
			{ permlink: 'm1', asset: ADDED_COIN, status: 'live', fee_status: 'verified' }
		]);
		expect(got.ops).toEqual([
			{ b: 51000, t: 0, status: 'applied', reject_reason: null },
			{ b: 51001, t: 0, status: 'rejected', reject_reason: 'handler_threw:boom' }
		]);
		// nothing left for the next boot
		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'mike')).toEqual(got);
	});

	it('counts a same-block end from updated_at when the event log lacks it', async () => {
		for (const n of [3001, 41000]) await apply(fresh, n);
		await apply(old, 3001);
		await apply(old, 41000, 3);
		await indexAsOld(old, 41000, 3);
		await old.db.query(
			`DELETE FROM ops WHERE signer = 'nina' AND op_id = 'morphit_order_cancel_v1'`
		);
		const want = (await snapshot(fresh, 'nina')).orders;
		expect(want.find((o) => o.permlink === 'n3')?.fee_status).toBe('underpaid');
		await reconcileAfterUpgrade(deps(old.db));
		expect((await snapshot(old, 'nina')).orders).toEqual(want);
	});

	it('does not replay a dependent the dispatcher refused before any handler ran', async () => {
		for (const n of [52000, 52001]) await apply(fresh, n);
		await indexAsOld(old, 52000);
		await apply(old, 52001); // refused invalid_text by the dispatcher, as on every node
		const want = await snapshot(fresh, 'olga');
		expect(want.ops.find((r) => r.b === 52001)).toEqual({
			b: 52001,
			t: 0,
			status: 'rejected',
			reject_reason: 'invalid_text'
		});
		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'olga')).toEqual(want);
	});

	it('an account whose order could not be judged this boot waits whole: an undone heal', async () => {
		for (const n of [53000, 53001, 53002, 53003]) await apply(fresh, n);
		await apply(old, 53000);
		for (const n of [53001, 53002, 53003]) await indexAsOld(old, n);
		const want = await snapshot(fresh, 'pia');
		expect(want.orders.find((o) => o.permlink === 'p3')?.fee_status).toBe('underpaid');

		// p2's cancel hits a statement timeout once
		let failed = false;
		const flaky = {
			query: old.db.query.bind(old.db),
			withTx: <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
				old.db.withTx((c) =>
					fn(
						new Proxy(c, {
							get(target, prop, recv) {
								if (prop !== 'query') return Reflect.get(target, prop, recv);
								return (text: unknown, ...rest: unknown[]) => {
									if (
										!failed &&
										typeof text === 'string' &&
										/SET status = 'cancelled'/.test(text)
									) {
										failed = true;
										return Promise.reject(
											Object.assign(new Error('canceling statement due to statement timeout'), {
												code: '57014'
											})
										);
									}
									return (target.query as (...a: unknown[]) => unknown).call(target, text, ...rest);
								};
							}
						})
					)
				)
		};
		await reconcileAfterUpgrade(deps(flaky as never));
		expect(failed).toBe(true);
		// p3 waited with p2
		expect((await snapshot(old, 'pia')).orders.map((o) => o.permlink)).toEqual(['p0', 'p1']);
		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'pia')).toEqual(want);
	});

	it('an account whose order could not be judged this boot waits whole: fee rows not recorded yet', async () => {
		for (const n of [54000, 54001, 54002]) await apply(fresh, n);
		await apply(old, 54000);
		for (const n of [54001, 54002]) await indexAsOld(old, n);
		await old.db.query(`DELETE FROM fee_payment_legs WHERE block_num = 54001`);
		await old.db.query(`DELETE FROM fee_payments WHERE block_num = 54001`);
		const want = await snapshot(fresh, 'quin');
		expect(want.orders.find((o) => o.permlink === 'q3')?.fee_status).toBe('underpaid');

		await reconcileAfterUpgrade(deps(old.db));
		expect((await snapshot(old, 'quin')).orders.map((o) => o.permlink)).toEqual(['q0', 'q1']);
		// the back-fill records q2's transfers; the next boot heals both, in order
		const operations = BLOCKS[54001]![0]!;
		const body = operations[1]![1] as { json: string };
		await recordFeePayment(
			old.db,
			{
				blockNum: 54001,
				trxInBlock: 0,
				opInTrx: 1,
				trxId: 'trx-54001-0',
				blockTime: new Date(T0 + 54001 * 3000),
				signer: 'quin',
				opId: 'morphit_order_v1',
				payload: JSON.parse(body.json) as unknown
			},
			operations as never
		);
		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'quin')).toEqual(want);
	});

	it('reads every row of the older scan before the added coin’s orders', async () => {
		// the XMR listing fee a release pinned (an XMR order is judged by it)
		for (const f of [fresh, old])
			await f.db.query(
				`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num,
				                       source_trx_id, signer, valid, created_at, treasury)
				 VALUES ('1.20.0', '{}'::jsonb, '{}'::jsonb, '', 55999, 'rel-55999', 'morphit', true, $1, $2::jsonb)`,
				[new Date(T0), JSON.stringify({ xmr: { piconero: String(amounts.xmrPiconero) } })]
			);
		for (const n of [56000, 56001, 56002]) await apply(fresh, n);
		await apply(old, 56000);
		for (const n of [56001, 56002]) await indexAsOld(old, n);
		const want = await snapshot(fresh, 'sara');
		expect(want.orders.map((o) => o.permlink)).toEqual(['s0', 's1', 's2', 's3']);
		expect(want.orders.find((o) => o.permlink === 's3')?.fee_status).toBe('underpaid');
		// one row per batch: the older scan takes several batches
		await reconcileAfterUpgrade(deps(old.db, 1));
		expect(await snapshot(old, 'sara')).toEqual(want);
	});

	it('a lost connection that also fails the savepoint rollback undoes the heal', async () => {
		for (const n of [57000, 57001]) await apply(fresh, n);
		for (const n of [57000, 57001]) await indexAsOld(old, n);
		const want = await snapshot(fresh, 'rita');
		const before = await snapshot(old, 'rita');

		// r1's cancel loses the connection; from then on the client answers
		// nothing (as pg does: "not queryable"), ROLLBACK TO SAVEPOINT included
		let dead = false;
		const broken = {
			query: old.db.query.bind(old.db),
			withTx: <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
				old.db.withTx((c) =>
					fn(
						new Proxy(c, {
							get(target, prop, recv) {
								if (prop !== 'query') return Reflect.get(target, prop, recv);
								return (text: unknown, ...rest: unknown[]) => {
									if (dead)
										return Promise.reject(
											new Error('Client has encountered a connection error and is not queryable')
										);
									if (typeof text === 'string' && /SET status = 'cancelled'/.test(text)) {
										dead = true;
										return Promise.reject(new Error('Connection terminated unexpectedly'));
									}
									return (target.query as (...a: unknown[]) => unknown).call(target, text, ...rest);
								};
							}
						})
					)
				)
		};
		await reconcileAfterUpgrade(deps(broken as never));
		expect(dead).toBe(true);
		// nothing kept, nothing refused for good
		expect(await snapshot(old, 'rita')).toEqual(before);
		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'rita')).toEqual(want);
	});

	it('leaves refused an order whose permlink a later order of the account took', async () => {
		for (const n of [58000, 58001]) await apply(fresh, n);
		// a node that knew the coin: the first t1 holds the permlink
		expect((await snapshot(fresh, 'tina')).orders.map((o) => o.asset)).toEqual([ADDED_COIN]);
		await indexAsOld(old, 58000);
		await apply(old, 58001);
		const before = await snapshot(old, 'tina');
		expect(before.orders.map((o) => o.asset)).toEqual(['BTC']);
		await reconcileAfterUpgrade(deps(old.db));
		expect(await snapshot(old, 'tina')).toEqual({
			orders: before.orders,
			ops: [
				{ b: 58000, t: 0, status: 'rejected', reject_reason: 'permlink_taken_since' },
				{ b: 58001, t: 0, status: 'applied', reject_reason: null }
			]
		});
	});
});
