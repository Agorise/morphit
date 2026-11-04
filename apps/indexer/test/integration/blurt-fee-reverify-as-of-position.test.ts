/**
 * v1.22.1 — the fee re-check (blurtFeeReverify) judges every op AS OF ITS OWN
 * POSITION in the chain, as the live pass did, not from the tables as they
 * stand when the node happens to run it.
 *
 * Until v1.22.1:
 *  1. The Sybil tier counted an order ended in the op's OWN block (before the
 *     op in the transaction order, but the live pass applies a block's order
 *     ops first) as not live: one tier too low, and an order the live pass
 *     judged underpaid was VERIFIED.
 *  2. It counted an order ended BEFORE the op as live when something touched
 *     it later (a counterparty named on a completed order): one tier too
 *     high, and an order that paid in full stayed underpaid — depending on
 *     WHEN the node ran the re-check.
 *  3. A stranger fee rejected live was marked APPLIED because the sender paid
 *     for the same pair LATER ("already paid").
 *  4. A stranger fee paid later in the SAME block raised the escalating price,
 *     so a fee that paid the price in force at its position stayed rejected.
 *  5. Stranger fees were re-judged newest first, so a fee whose price depends
 *     on an earlier one (also waiting to be re-judged) was priced without it.
 * Verdicts the old rule reached that can be wrong in a way the current rule
 * repairs are judged again, once.
 *
 * And (review of v1.22.1): when a fee judged out of order is valid and the
 * pair's row belongs to a LATER fee, the row moves to it; a sender's later fee
 * waits while an earlier one cannot be judged; an op this process gave up on,
 * or one whose judging threw, does not keep the others out; stranger fees are
 * re-judged at any age (no 30-day window).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import orderHandler from '../../src/indexer/handlers/order';
import strangerFeeHandler from '../../src/indexer/handlers/strangerFee';
import operatorRegisterHandler from '../../src/indexer/handlers/operatorRegister';
import type { Handler } from '../../src/indexer/handler-contract';
import type { BlockHeader, BlockTransaction, ChainOperation } from '../../src/blurt/client';
import { transactionIdOf } from '../../src/blurt/snapshotOpTrust';
import { reconcileOperatorRegistrations } from '../../src/indexer/reconcileRegistrations';
import { BlurtFeeReverifier } from '../../src/indexer/blurtFeeReverify';
import { getStrangerFeeQuote } from '../../src/indexer/strangerFeePricing';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx, fakeConfig, mockBlurt, unusedBlurt } from '../testutils/context';

const REG = 1_000_000;
const N = REG + 300_000;
/** Dated before the consensus activation, like the G1 scenarios (configured
 *  62.5 BLURT base); the as-of-position rule does not depend on the date. */
const BASE_TIME = Date.parse(CONSENSUS_V2_ACTIVATION_TIME) - 3 * 24 * 3600 * 1000;
const timeOf = (block: number): Date => new Date(BASE_TIME + (block - N) * 3_000);
const SCENARIO_NOW = new Date(BASE_TIME + 2 * 24 * 3600 * 1000);
const TWO_DAYS_BEFORE = new Date(BASE_TIME - 2 * 24 * 3600 * 1000);
const HERE = fakeConfig({ feeRecipient: 'morphit-fees' });

const d = INTEGRATION_ENABLED ? describe : describe.skip;

d('fee re-check: every op judged as of its position in the chain', () => {
	let fx: IntegrationFixture;
	let chain: Map<number, BlockHeader>;
	let fetches: number[];

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		for (const t of [
			'known_instances',
			'operator_registration_events',
			'operators',
			'stranger_fees',
			'operator_fee_recipients',
			'fee_reverify_done'
		]) {
			await fx.db.query(`DELETE FROM ${t}`);
		}
		chain = new Map();
		fetches = [];
	});

	const B_REGISTER = { v: 1, tag: 'b-node', display_name: 'B', fee_recipient: 'b-fees' };

	/** Operator B with fees account `b-fees` from block REG. `old`: this node
	 *  ran v1.19 then (no history row until the boot reconcile), so fees paid
	 *  through B were judged without it. `known`: judged with it. */
	async function operatorB(kind: 'old' | 'known'): Promise<void> {
		await fx.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block, last_action_block_num)
			 VALUES ('bop', 'b-node', 'B', $1, $1)`,
			[REG - 50_000]
		);
		const trxId = 'bbbb000000000000000000000000000000000001';
		if (kind === 'known') {
			const ctx = makeCtx({
				signer: 'bop',
				blockNum: REG,
				trxInBlock: 0,
				opInTrx: 0,
				trxId,
				blockTime: timeOf(REG),
				payload: B_REGISTER,
				config: HERE
			});
			const c = await fx.pool.connect();
			try {
				await c.query('BEGIN');
				const r = await operatorRegisterHandler(ctx, c);
				expect(r).toMatchObject({ ok: true });
				await c.query('COMMIT');
			} finally {
				c.release();
			}
		}
		await opRow(REG, 0, 'bop', 'morphit_operator_register_v1', B_REGISTER, 'applied', trxId);
	}

	async function bootReconcile(): Promise<void> {
		await reconcileOperatorRegistrations({
			db: fx.db,
			blurt: unusedBlurt(),
			config: HERE,
			feeVerifiers: {},
			feeAmounts: {},
			fiatToUsd: (a) => a
		});
	}

	async function opRow(
		block: number,
		trx: number,
		signer: string,
		opId: string,
		payload: unknown,
		status: 'applied' | 'rejected',
		trxId = `${block}-${trx}`.padEnd(40, '0'),
		reason: string | null = null
	): Promise<void> {
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status, reject_reason)
			 VALUES ($1, $2, 0, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
			[block, trx, timeOf(block), trxId, signer, opId, JSON.stringify(payload), status, reason]
		);
	}

	/** Put a transaction on the mock chain at (block, trx) and run its fee op
	 *  through `handler` live, then log it as the dispatcher does. */
	async function judgeLive(
		handler: Handler,
		opId: string,
		signer: string,
		block: number,
		trx: number,
		payload: Record<string, unknown>,
		legs: ReadonlyArray<[string, string]>,
		memo: string
	): Promise<{ ok: boolean; reason?: string; trxId: string }> {
		const operations: ChainOperation[] = [
			[
				'custom_json',
				{
					required_auths: [signer],
					required_posting_auths: [],
					id: opId,
					json: JSON.stringify(payload)
				}
			],
			...legs.map(
				([to, amount]) => ['transfer', { from: signer, to, amount, memo }] as ChainOperation
			)
		];
		const t: BlockTransaction = {
			ref_block_num: block & 0xffff,
			ref_block_prefix: 12345 + trx,
			expiration: timeOf(block + 20)
				.toISOString()
				.slice(0, 19),
			operations,
			signatures: []
		};
		const trxId = transactionIdOf({ ...t, extensions: [] })!;
		const blk = chain.get(block) ?? {
			timestamp: timeOf(block).toISOString().slice(0, 19),
			transactions: [],
			transaction_ids: []
		};
		const txs = [...blk.transactions];
		const ids = [...(blk.transaction_ids ?? [])];
		while (txs.length < trx) {
			txs.push({ ...t, operations: [] });
			ids.push('0'.repeat(40));
		}
		txs[trx] = t;
		ids[trx] = trxId;
		chain.set(block, { ...blk, transactions: txs, transaction_ids: ids });
		const ctx = makeCtx({
			signer,
			blockNum: block,
			trxInBlock: trx,
			opInTrx: 0,
			trxId,
			blockTime: timeOf(block),
			payload,
			siblingOps: operations,
			config: HERE,
			feeAmounts: { blurtBase: 62.5 }
		});
		const c = await fx.pool.connect();
		let r: { ok: boolean; reason?: string };
		try {
			await c.query('BEGIN');
			r = await handler(ctx, c);
			await c.query(r.ok ? 'COMMIT' : 'ROLLBACK');
		} finally {
			c.release();
		}
		await opRow(
			block,
			trx,
			signer,
			opId,
			payload,
			r.ok ? 'applied' : 'rejected',
			trxId,
			r.ok ? null : (r.reason ?? null)
		);
		return { ...r, trxId };
	}

	const orderPayload = (permlink: string) => ({
		permlink,
		side: 'sell',
		asset: 'BLURT',
		fiat_currency: 'USD',
		amount_min: 10,
		amount_max: 100,
		price_model: { kind: 'spread', percent: 1 },
		payment_methods: ['cash'],
		operator_tag: 'b-node'
	});
	/** Tier 1–3 (×1.0) via B: 90 % to b-fees, 10 % to the canonical treasury. */
	const TIER_1_TO_3: ReadonlyArray<[string, string]> = [
		['b-fees', '56.250 BLURT'],
		['morphit-fees', '6.250 BLURT']
	];

	/** One of alice's orders, created two days before block N (outside the 24 h
	 *  window, so it counts only while live), with its create op logged. */
	async function olderOrder(permlink: string, createBlock: number): Promise<void> {
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, amount_min, amount_max, price_model,
			                     payment_methods, status, created_at, updated_at, fee_status, fee_method)
			 VALUES ('alice', $1, 'sell','BLURT','USD',10,100,'{"kind":"spread","percent":1}'::jsonb,
			         ARRAY['cash'],'live', $2, $2, 'verified','blurt')`,
			[permlink, TWO_DAYS_BEFORE]
		);
		await opRow(createBlock, 0, 'alice', 'morphit_order_v1', orderPayload(permlink), 'applied');
	}

	/** Blocks the mock chain does not serve (a node that fails to answer). */
	let unavailable: Set<number>;
	beforeEach(() => {
		unavailable = new Set();
	});
	const reverifier = (db: Pick<IntegrationFixture['db'], 'query' | 'withTx'> = fx.db) =>
		new BlurtFeeReverifier({
			db,
			blurt: mockBlurt({
				getBlock: async (n: number) => {
					fetches.push(n);
					return unavailable.has(n) ? null : (chain.get(n) ?? null);
				}
			}),
			config: HERE,
			windowEnd: () => SCENARIO_NOW
		});

	const feeStatus = async (permlink: string) =>
		(
			await fx.db.query<{ fee_status: string }>(
				`SELECT fee_status FROM orders WHERE account = 'alice' AND permlink = $1`,
				[permlink]
			)
		).rows[0]?.fee_status;
	const outcomeAt = async (block: number, trx: number) =>
		(
			await fx.db.query<{ outcome: string }>(
				'SELECT outcome FROM fee_reverify_done WHERE block_num = $1 AND trx_in_block = $2',
				[block, trx]
			)
		).rows[0]?.outcome;
	const opStatus = async (block: number, trx: number) =>
		(
			await fx.db.query<{ status: string; reject_reason: string | null }>(
				'SELECT status, reject_reason FROM ops WHERE block_num = $1 AND trx_in_block = $2',
				[block, trx]
			)
		).rows[0];

	it('1. an order ended in the op’s OWN block still counted at the op: an underpaid order is not verified', async () => {
		await operatorB('known');
		for (const [i, p] of ['x1', 'x2', 'x3'].entries()) await olderOrder(p, N - 30_000 - i);
		// Block N: alice cancels x1 (trx 0) and posts y (trx 1). The live pass
		// applies a block's order ops first: x1 is still live when y is
		// judged, so y is her 4th order (×1.25) and paying ×1.0 is short.
		const y = await judgeLive(
			orderHandler,
			'morphit_order_v1',
			'alice',
			N,
			1,
			orderPayload('y'),
			TIER_1_TO_3,
			'morphit-fee:y'
		);
		expect(y.ok).toBe(true);
		expect(await feeStatus('y')).toBe('underpaid');
		await fx.db.query(
			`UPDATE orders SET status = 'cancelled', updated_at = $1 WHERE account = 'alice' AND permlink = 'x1'`,
			[timeOf(N)]
		);
		await opRow(N, 0, 'alice', 'morphit_order_cancel_v1', { permlink: 'x1' }, 'applied');

		const s = await reverifier().runOnce();
		expect(s.orders).toEqual({ checked: 1, verified: 0 });
		expect(await feeStatus('y')).toBe('underpaid');
		expect(await outcomeAt(N, 1)).toBe('underpaid_as_of_position');
		// Judged once.
		const n = fetches.length;
		await reverifier().runOnce();
		expect(fetches.length).toBe(n);
	});

	/** Case 2's setup: x1 completed BEFORE y, its counterparty named AFTER it. */
	async function endedBeforeTouchedAfter(): Promise<void> {
		await operatorB('old');
		for (const [i, p] of ['x1', 'x2', 'x3'].entries()) await olderOrder(p, N - 30_000 - i);
		await fx.db.query(
			`UPDATE orders SET status = 'completed', updated_at = $1, completed_at = $1
			  WHERE account = 'alice' AND permlink = 'x1'`,
			[timeOf(N - 100)]
		);
		await opRow(N - 100, 0, 'alice', 'morphit_order_complete_v1', { permlink: 'x1' }, 'applied');
		// y, her 3rd live order (×1.0), paid in full through B; this node ran
		// v1.19 and did not know b-fees: underpaid.
		const y = await judgeLive(
			orderHandler,
			'morphit_order_v1',
			'alice',
			N,
			1,
			orderPayload('y'),
			TIER_1_TO_3,
			'morphit-fee:y'
		);
		expect(y.ok).toBe(true);
		expect(await feeStatus('y')).toBe('underpaid');
		// Later the counterparty is named on the completed x1 (v1.20.0 G7).
		await fx.db.query(
			`UPDATE orders SET completed_counterparty = 'bob', updated_at = $1
			  WHERE account = 'alice' AND permlink = 'x1'`,
			[timeOf(N + 500)]
		);
		await opRow(
			N + 500,
			0,
			'alice',
			'morphit_order_complete_v1',
			{ permlink: 'x1', counterparty: 'bob' },
			'applied'
		);
		await bootReconcile();
	}

	it('2. an order ended BEFORE the op and touched after it does not count: an order paid in full is verified', async () => {
		await endedBeforeTouchedAfter();
		const s = await reverifier().runOnce();
		expect(s.orders).toEqual({ checked: 1, verified: 1 });
		expect(await feeStatus('y')).toBe('verified');
		expect(await outcomeAt(N, 1)).toBe('verified');
	});

	it('2b. the old rule’s "still underpaid" is judged again, once, by the current rule', async () => {
		await endedBeforeTouchedAfter();
		// What a node running v1.22.0 recorded for y.
		await fx.db.query(
			`INSERT INTO fee_reverify_done (block_num, trx_in_block, op_in_trx, op_id, outcome)
			 VALUES ($1, 1, 0, 'morphit_order_v1', 'still_underpaid')`,
			[N]
		);
		const s = await reverifier().runOnce();
		expect(s.orders).toEqual({ checked: 1, verified: 1 });
		expect(await feeStatus('y')).toBe('verified');
		expect(await outcomeAt(N, 1)).toBe('verified');
		// A verdict of the current rule is final.
		await fx.db.query(
			`UPDATE orders SET fee_status = 'underpaid' WHERE account = 'alice' AND permlink = 'y'`
		);
		await fx.db.query(
			`UPDATE fee_reverify_done SET outcome = 'underpaid_as_of_position' WHERE block_num = $1`,
			[N]
		);
		const n = fetches.length;
		await reverifier().runOnce();
		expect(fetches.length).toBe(n);
	});

	const stranger = (recipient: string, amount = 5) => ({
		v: 1,
		recipient,
		amount_blurt: amount,
		operator_tag: 'b-node'
	});

	/** Case 3's setup: f (short) rejected live; the pair paid in full later. */
	async function pairPaidLater(): Promise<void> {
		await operatorB('known');
		const f = await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N,
			1,
			stranger('rita'),
			[
				['b-fees', '2.000 BLURT'],
				['morphit-fees', '0.500 BLURT']
			],
			'morphit-stranger:rita'
		);
		expect(f).toMatchObject({ ok: false, reason: 'fee_underpaid' });
		const g = await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N + 1_000,
			1,
			stranger('rita'),
			[
				['b-fees', '4.500 BLURT'],
				['morphit-fees', '0.500 BLURT']
			],
			'morphit-stranger:rita'
		);
		expect(g.ok).toBe(true);
	}

	it('3. a stranger fee rejected live is not made "already paid" by a LATER payment for the pair', async () => {
		await pairPaidLater();
		const s = await reverifier().runOnce();
		expect(s.strangerFees).toEqual({ checked: 1, applied: 0 });
		expect(await opStatus(N, 1)).toEqual({ status: 'rejected', reject_reason: 'fee_underpaid' });
		expect(await outcomeAt(N, 1)).toBe('rejected_as_of_position:fee_underpaid');
	});

	it('3b. one the old rule applied that way is rejected again, once', async () => {
		await pairPaidLater();
		// What a node running v1.22.0 did to f.
		await fx.db.query(
			`UPDATE ops SET status = 'applied', reject_reason = NULL WHERE block_num = $1 AND trx_in_block = 1`,
			[N]
		);
		await fx.db.query(
			`INSERT INTO fee_reverify_done (block_num, trx_in_block, op_in_trx, op_id, outcome)
			 VALUES ($1, 1, 0, 'morphit_stranger_fee_v1', 'applied')`,
			[N]
		);
		await reverifier().runOnce();
		expect(await opStatus(N, 1)).toEqual({ status: 'rejected', reject_reason: 'fee_underpaid' });
		expect(await outcomeAt(N, 1)).toBe('unapplied_as_of_position:fee_underpaid');
		// The pair stays paid by the later fee, which is untouched.
		expect(await opStatus(N + 1_000, 1)).toEqual({ status: 'applied', reject_reason: null });
		const pair = await fx.db.query(
			`SELECT paid_block_num::int AS b FROM stranger_fees WHERE sender = 'sam' AND recipient = 'rita'`
		);
		expect(pair.rows).toEqual([{ b: N + 1_000 }]);
		const n = fetches.length;
		await reverifier().runOnce();
		expect(fetches.length).toBe(n);
	});

	it('3c. a fee the old rule applied WITH its own row is not judged again', async () => {
		await operatorB('old');
		const f = await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N,
			1,
			stranger('rita'),
			[
				['b-fees', '4.500 BLURT'],
				['morphit-fees', '0.500 BLURT']
			],
			'morphit-stranger:rita'
		);
		expect(f.ok).toBe(false);
		await bootReconcile();
		await reverifier().runOnce();
		expect(await opStatus(N, 1)).toEqual({ status: 'applied', reject_reason: null });
		// As a v1.22.0 node recorded it.
		await fx.db.query(`UPDATE fee_reverify_done SET outcome = 'applied' WHERE block_num = $1`, [N]);
		const n = fetches.length;
		await reverifier().runOnce();
		expect(fetches.length).toBe(n);
	});

	it('4. a fee paid LATER in the same block does not raise the price of one re-judged before it', async () => {
		await operatorB('old');
		// f (trx 1) paid the base price through B: unknown to this node, rejected.
		const f = await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N,
			1,
			stranger('rita'),
			[
				['b-fees', '4.500 BLURT'],
				['morphit-fees', '0.500 BLURT']
			],
			'morphit-stranger:rita'
		);
		expect(f).toMatchObject({ ok: false, reason: 'fee_underpaid' });
		// h (trx 2), paid to this instance: applied, priced at the base (f was
		// not recorded).
		const h = await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N,
			2,
			stranger('ursula'),
			[['morphit-fees', '5.000 BLURT']],
			'morphit-stranger:ursula'
		);
		expect(h.ok).toBe(true);
		await bootReconcile();
		const s = await reverifier().runOnce();
		// A node that knew b-fees accepted f at the base price: so does the re-check.
		expect(s.strangerFees).toEqual({ checked: 1, applied: 1 });
		expect(await opStatus(N, 1)).toEqual({ status: 'applied', reject_reason: null });
		expect(await outcomeAt(N, 1)).toBe('applied_as_of_position');
	});

	it('4b. the old rule’s "still rejected" is judged again, once', async () => {
		await operatorB('old');
		await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N,
			1,
			stranger('rita'),
			[
				['b-fees', '4.500 BLURT'],
				['morphit-fees', '0.500 BLURT']
			],
			'morphit-stranger:rita'
		);
		await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N,
			2,
			stranger('ursula'),
			[['morphit-fees', '5.000 BLURT']],
			'morphit-stranger:ursula'
		);
		await bootReconcile();
		await fx.db.query(
			`INSERT INTO fee_reverify_done (block_num, trx_in_block, op_in_trx, op_id, outcome)
			 VALUES ($1, 1, 0, 'morphit_stranger_fee_v1', 'still_rejected:amount_blurt_below_current_quote')`,
			[N]
		);
		await reverifier().runOnce();
		expect(await opStatus(N, 1)).toEqual({ status: 'applied', reject_reason: null });
		expect(await outcomeAt(N, 1)).toBe('applied_as_of_position');
	});

	it('5. stranger fees are re-judged in chain order: the later fee’s price counts the earlier one', async () => {
		await operatorB('old');
		// sam pays two first-contact fees through B 30 s apart, each at the base
		// price, and this (then v1.19) node rejects both (fee_underpaid). A node
		// that knew b-fees accepted e, so f was the second fee in 5 minutes and
		// owed twice the base: it refused f (amount_blurt_below_current_quote).
		for (const [block, who] of [
			[N, 'rita'],
			[N + 10, 'tom']
		] as const) {
			const r = await judgeLive(
				strangerFeeHandler,
				'morphit_stranger_fee_v1',
				'sam',
				block,
				1,
				stranger(who),
				[
					['b-fees', '4.500 BLURT'],
					['morphit-fees', '0.500 BLURT']
				],
				`morphit-stranger:${who}`
			);
			expect(r).toMatchObject({ ok: false, reason: 'fee_underpaid' });
		}
		await bootReconcile();
		const s = await reverifier().runOnce();
		expect(s.strangerFees).toEqual({ checked: 2, applied: 1 });
		expect(await opStatus(N, 1)).toEqual({ status: 'applied', reject_reason: null });
		expect(await opStatus(N + 10, 1)).toEqual({
			status: 'rejected',
			reject_reason: 'fee_underpaid'
		});
		expect(await outcomeAt(N + 10, 1)).toBe(
			'rejected_as_of_position:amount_blurt_below_current_quote'
		);
	});

	it('5b. the same in ONE block: the fee in the later transaction counts the earlier one', async () => {
		await operatorB('old');
		for (const [trx, who] of [
			[1, 'rita'],
			[2, 'tom']
		] as const) {
			const r = await judgeLive(
				strangerFeeHandler,
				'morphit_stranger_fee_v1',
				'sam',
				N,
				trx,
				stranger(who),
				[
					['b-fees', '4.500 BLURT'],
					['morphit-fees', '0.500 BLURT']
				],
				`morphit-stranger:${who}`
			);
			expect(r).toMatchObject({ ok: false, reason: 'fee_underpaid' });
		}
		await bootReconcile();
		const s = await reverifier().runOnce();
		expect(s.strangerFees).toEqual({ checked: 2, applied: 1 });
		expect(await opStatus(N, 1)).toEqual({ status: 'applied', reject_reason: null });
		expect(await outcomeAt(N, 2)).toBe('rejected_as_of_position:amount_blurt_below_current_quote');
	});

	it('the escalating price as of a position counts exactly the fees recorded by ops before it', async () => {
		// sam's fees, all inside the 5-minute window before block N's time.
		const fee = async (
			block: number,
			trx: number,
			op: number,
			recipient: string,
			opStatus: 'applied' | 'rejected' | null
		) => {
			const trxId = `t${block}-${trx}`.padEnd(40, '0');
			await fx.db.query(
				`INSERT INTO stranger_fees (sender, recipient, paid_block_num, paid_trx_id, paid_at, amount_blurt)
				 VALUES ('sam', $1, $2, $3, $4, 5)`,
				[recipient, block, trxId, timeOf(block)]
			);
			if (opStatus !== null) {
				await fx.db.query(
					`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
					 VALUES ($1, $2, $3, $4, $5, 'sam', 'morphit_stranger_fee_v1', $6::jsonb, $7)
					 ON CONFLICT DO NOTHING`,
					[block, trx, op, timeOf(block), trxId, JSON.stringify(stranger(recipient)), opStatus]
				);
			}
		};
		const at = (trx: number, op: number) => ({ block_num: N, trx_in_block: trx, op_in_trx: op });
		const count = async (trx: number, op: number) =>
			(await getStrangerFeeQuote(fx.db, 'sam', timeOf(N), 0, at(trx, op))).recentCount;

		await fee(N - 5, 3, 0, 'r1', 'applied'); // earlier block: counts
		expect(await count(1, 0)).toBe(1);
		await fee(N, 0, 0, 'r2', 'applied'); // same block, earlier transaction
		expect(await count(1, 0)).toBe(2);
		expect(await count(0, 0)).toBe(1); // ...not before itself
		await fee(N, 2, 0, 'r3', 'applied'); // same block, later transaction
		expect(await count(1, 0)).toBe(2);
		// Two fees in one transaction (ops 0 and 1): each counts only the one
		// before it, though both rows name the same transaction.
		await fee(N, 4, 0, 'r4', 'applied');
		await fee(N, 4, 1, 'r5', null);
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES ($1, 4, 1, $2, $3, 'sam', 'morphit_stranger_fee_v1', $4::jsonb, 'applied')`,
			[N, timeOf(N), `t${N}-4`.padEnd(40, '0'), JSON.stringify(stranger('r5'))]
		);
		expect(await count(4, 1)).toBe(4); // r1 r2 r3 r4
		expect(await count(4, 2)).toBe(5); // and r5
		// A same-block row with no applied op on record is not counted.
		await fee(N, 5, 0, 'r6', 'rejected');
		await fee(N, 6, 0, 'r7', null);
		expect(await count(9, 0)).toBe(5); // r1–r5: not r6, r7
		// Without a position (the live pass and the quote API): every row.
		expect((await getStrangerFeeQuote(fx.db, 'sam', timeOf(N))).recentCount).toBe(7);
	});

	it('3d. found without the local bookkeeping: on a node fast-synced from one that ran the old rule, the same fee is rejected again', async () => {
		await pairPaidLater();
		// The snapshot carries the old rule's verdict; fee_reverify_done is
		// local and starts empty.
		await fx.db.query(
			`UPDATE ops SET status = 'applied', reject_reason = NULL WHERE block_num = $1 AND trx_in_block = 1`,
			[N]
		);
		await reverifier().runOnce();
		expect(await opStatus(N, 1)).toEqual({ status: 'rejected', reject_reason: 'fee_underpaid' });
		expect(await outcomeAt(N, 1)).toBe('unapplied_as_of_position:fee_underpaid');
	});

	it('6. a fee made valid by the re-check takes the pair row from a LATER fee, so the fees in between are priced with it', async () => {
		await operatorB('old');
		const viaB = (amount: string, canon: string): ReadonlyArray<[string, string]> => [
			['b-fees', amount],
			['morphit-fees', canon]
		];
		// e: rita, base price through B — rejected here (b-fees unknown).
		const e = await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N,
			1,
			stranger('rita'),
			viaB('4.500 BLURT', '0.500 BLURT'),
			'morphit-stranger:rita'
		);
		expect(e).toMatchObject({ ok: false, reason: 'fee_underpaid' });
		// h: tom, 30 s later, base price through B — rejected here too.
		const h = await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N + 10,
			1,
			stranger('tom'),
			viaB('4.500 BLURT', '0.500 BLURT'),
			'morphit-stranger:tom'
		);
		expect(h).toMatchObject({ ok: false, reason: 'fee_underpaid' });
		// g: rita again, much later, paid to this instance: applied, the pair row.
		const g = await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N + 1_000,
			1,
			stranger('rita'),
			[['morphit-fees', '5.000 BLURT']],
			'morphit-stranger:rita'
		);
		expect(g.ok).toBe(true);
		await bootReconcile();
		await reverifier().runOnce();
		// A node that knew b-fees: e paid the pair (row at N), h was the second
		// fee in 5 minutes and owed twice the base (refused), g found the pair
		// already paid.
		expect(await opStatus(N, 1)).toEqual({ status: 'applied', reject_reason: null });
		const pair = await fx.db.query(
			`SELECT paid_block_num::int AS b, paid_trx_id AS t FROM stranger_fees WHERE sender = 'sam' AND recipient = 'rita'`
		);
		expect(pair.rows).toEqual([{ b: N, t: e.trxId }]);
		expect(await opStatus(N + 10, 1)).toEqual({
			status: 'rejected',
			reject_reason: 'fee_underpaid'
		});
		expect(await outcomeAt(N + 10, 1)).toBe(
			'rejected_as_of_position:amount_blurt_below_current_quote'
		);
		expect(await opStatus(N + 1_000, 1)).toEqual({ status: 'applied', reject_reason: null });
		// g, applied with the pair paid before it, is not a candidate.
		const n = fetches.length;
		await reverifier().runOnce();
		expect(fetches.length).toBe(n);
	});

	/** Case 5's two fees (e at N, f at N+10), both rejected here. */
	async function twoFeesThirtySecondsApart(): Promise<void> {
		await operatorB('old');
		for (const [block, who] of [
			[N, 'rita'],
			[N + 10, 'tom']
		] as const) {
			await judgeLive(
				strangerFeeHandler,
				'morphit_stranger_fee_v1',
				'sam',
				block,
				1,
				stranger(who),
				[
					['b-fees', '4.500 BLURT'],
					['morphit-fees', '0.500 BLURT']
				],
				`morphit-stranger:${who}`
			);
		}
		await bootReconcile();
	}

	it('7. a sender’s later fee waits while an earlier one cannot be judged (its block is not served)', async () => {
		await twoFeesThirtySecondsApart();
		unavailable.add(N);
		const s = await reverifier().runOnce();
		expect(s.strangerFees.checked).toBe(0);
		expect(fetches).toEqual([N]);
		expect(await outcomeAt(N + 10, 1)).toBeUndefined();
		// The block comes back: both judged, in order, as case 5.
		unavailable.clear();
		await reverifier().runOnce();
		expect(await opStatus(N, 1)).toEqual({ status: 'applied', reject_reason: null });
		expect(await outcomeAt(N + 10, 1)).toBe(
			'rejected_as_of_position:amount_blurt_below_current_quote'
		);
	});

	it('7b. ...also once this process has given up on the earlier one', async () => {
		await twoFeesThirtySecondsApart();
		unavailable.add(N);
		const rv = reverifier();
		for (let i = 0; i < 5; i++) await rv.runOnce();
		// Fetched until given up (3 times), the later fee never.
		expect(fetches).toEqual([N, N, N]);
		expect(await outcomeAt(N + 10, 1)).toBeUndefined();
	});

	it('8. ops this process gave up on do not fill the selection and keep the others out', async () => {
		await operatorB('old');
		// 45 senders, each with one fee in a block the chain does not serve...
		for (let i = 0; i < 45; i++) {
			await judgeLive(
				strangerFeeHandler,
				'morphit_stranger_fee_v1',
				`gone${i}`,
				N + i,
				1,
				stranger('rita'),
				[
					['b-fees', '4.500 BLURT'],
					['morphit-fees', '0.500 BLURT']
				],
				'morphit-stranger:rita'
			);
			unavailable.add(N + i);
		}
		// ...and a later one that can be judged.
		await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N + 100,
			1,
			stranger('tom'),
			[
				['b-fees', '4.500 BLURT'],
				['morphit-fees', '0.500 BLURT']
			],
			'morphit-stranger:tom'
		);
		await bootReconcile();
		const rv = reverifier();
		for (let i = 0; i < 12; i++) await rv.runOnce();
		expect(await opStatus(N + 100, 1)).toEqual({ status: 'applied', reject_reason: null });
	});

	it('9. an op whose judging fails is retried, then given up, and does not stop the pass', async () => {
		await operatorB('known');
		for (const [i, p] of ['x1', 'x2', 'x3'].entries()) await olderOrder(p, N - 30_000 - i);
		// Two underpaid orders (4th and 5th of alice's): the newer, z, is
		// judged first and its judging fails.
		for (const [trx, p] of [
			[1, 'y'],
			[2, 'z']
		] as const) {
			await judgeLive(
				orderHandler,
				'morphit_order_v1',
				'alice',
				N,
				trx,
				orderPayload(p),
				TIER_1_TO_3,
				`morphit-fee:${p}`
			);
		}
		await fx.db.query(
			`UPDATE orders SET created_at = created_at + INTERVAL '1 second' WHERE permlink = 'z'`
		);
		let calls = 0;
		const failing = {
			query: fx.db.query.bind(fx.db),
			withTx: async <T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> => {
				calls++;
				if (calls === 1) throw new Error('judging failed');
				return fx.db.withTx(fn);
			}
		};
		const rv = reverifier(failing as never);
		const s = await rv.runOnce();
		expect(s.fetchFailures).toBe(1);
		expect(s.orders.checked).toBe(1);
		expect(await outcomeAt(N, 1)).toBe('underpaid_as_of_position');
		expect(await outcomeAt(N, 2)).toBeUndefined();
		await rv.runOnce();
		expect(await outcomeAt(N, 2)).toBe('underpaid_as_of_position');
	});

	it('8b. the same for orders (judged newest first)', async () => {
		await operatorB('known');
		// An older underpaid order that can be judged...
		await judgeLive(
			orderHandler,
			'morphit_order_v1',
			'alice',
			N,
			1,
			orderPayload('old'),
			[
				['b-fees', '20.000 BLURT'],
				['morphit-fees', '2.500 BLURT']
			],
			'morphit-fee:old'
		);
		// ...and 45 newer ones in blocks the chain does not serve.
		for (let i = 0; i < 45; i++) {
			const who = `gone${i}`;
			await judgeLive(
				orderHandler,
				'morphit_order_v1',
				who,
				N + 1 + i,
				1,
				{ ...orderPayload('p'), permlink: 'p' },
				[
					['b-fees', '20.000 BLURT'],
					['morphit-fees', '2.500 BLURT']
				],
				'morphit-fee:p'
			);
			await fx.db.query(`UPDATE orders SET created_at = $2 WHERE account = $1`, [
				who,
				timeOf(N + 1 + i)
			]);
			unavailable.add(N + 1 + i);
		}
		const rv = reverifier();
		for (let i = 0; i < 12; i++) await rv.runOnce();
		expect(await outcomeAt(N, 1)).toBe('underpaid_as_of_position');
	});

	it('9b. a stranger fee whose judging fails does not stop the pass; that sender’s later fees wait', async () => {
		await operatorB('old');
		for (const [block, who, to] of [
			[N, 'sam', 'rita'],
			[N + 5, 'una', 'rita'],
			[N + 10, 'sam', 'tom']
		] as const) {
			await judgeLive(
				strangerFeeHandler,
				'morphit_stranger_fee_v1',
				who,
				block,
				1,
				stranger(to),
				[
					['b-fees', '4.500 BLURT'],
					['morphit-fees', '0.500 BLURT']
				],
				`morphit-stranger:${to}`
			);
		}
		await bootReconcile();
		let calls = 0;
		const failing = {
			query: fx.db.query.bind(fx.db),
			withTx: async <T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> => {
				calls++;
				if (calls === 1) throw new Error('judging failed');
				return fx.db.withTx(fn);
			}
		};
		const rv = reverifier(failing as never);
		const s = await rv.runOnce();
		expect(s.fetchFailures).toBe(1);
		// una's fee is judged; sam's later one waits for sam's first.
		expect(await outcomeAt(N + 5, 1)).toBe('applied_as_of_position');
		expect(await outcomeAt(N + 10, 1)).toBeUndefined();
		await rv.runOnce();
		expect(await opStatus(N, 1)).toEqual({ status: 'applied', reject_reason: null });
		expect(await outcomeAt(N + 10, 1)).toBe(
			'rejected_as_of_position:amount_blurt_below_current_quote'
		);
	});

	it('3e. a fee the old rule applied by a later payment goes back to the reason it was rejected with', async () => {
		await operatorB('old');
		const viaB: ReadonlyArray<[string, string]> = [
			['b-fees', '4.500 BLURT'],
			['morphit-fees', '0.500 BLURT']
		];
		// e (rita) and f (tom, 30 s later), both at the base price through B:
		// both rejected fee_underpaid here.
		await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N,
			1,
			stranger('rita'),
			viaB,
			'morphit-stranger:rita'
		);
		await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N + 10,
			1,
			stranger('tom'),
			viaB,
			'morphit-stranger:tom'
		);
		// The pair sam→tom paid much later, to this instance.
		await judgeLive(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			N + 1_000,
			1,
			stranger('tom'),
			[['morphit-fees', '5.000 BLURT']],
			'morphit-stranger:tom'
		);
		await bootReconcile();
		// The old rule applied f because of that later payment.
		await fx.db.query(
			`UPDATE ops SET status = 'applied', reject_reason = NULL WHERE block_num = $1 AND trx_in_block = 1`,
			[N + 10]
		);
		await reverifier().runOnce();
		// Now e is applied first, so f owed twice the base: refused again,
		// stored with the reason it had before the old rule applied it.
		expect(await opStatus(N, 1)).toEqual({ status: 'applied', reject_reason: null });
		expect(await opStatus(N + 10, 1)).toEqual({
			status: 'rejected',
			reject_reason: 'fee_underpaid'
		});
		expect(await outcomeAt(N + 10, 1)).toBe(
			'unapplied_as_of_position:amount_blurt_below_current_quote'
		);
	});
});
