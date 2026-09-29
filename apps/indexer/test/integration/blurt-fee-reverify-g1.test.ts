/**
 * v1.20.0 (G1) — the one-shot re-verification of BLURT fee ops this node judged
 * BEFORE it knew the tagged operator's fee account.
 *
 * The rollout window: operator B upgrades and its upgrade re-registers with
 * `fee_recipient` at block X. This node still runs v1.19.x until it upgrades:
 * its register handler applies the op WITHOUT reading the field (the payload
 * is kept in `ops`), and every order / stranger fee paid through B after X is
 * judged the old way — orders stored `underpaid` (hidden), stranger fees
 * rejected `fee_underpaid`. After this node upgrades, the boot reconcile
 * back-fills the history from `ops` and the re-verifier re-fetches each such
 * op's transaction from the chain, checks it is byte-for-byte the transaction
 * this node indexed (its id is a hash of its content), and re-judges it with the
 * new rule — as of the op's block.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import strangerFeeHandler from '../../src/indexer/handlers/strangerFee';
import type { Handler, OpContext } from '../../src/indexer/handler-contract';
import type { BlockHeader, BlockTransaction, ChainOperation } from '../../src/blurt/client';
import { transactionIdOf } from '../../src/blurt/snapshotOpTrust';
import { reconcileOperatorRegistrations } from '../../src/indexer/reconcileRegistrations';
import {
	BACKLOG_INTERVAL_MS,
	BlurtFeeReverifier,
	INTERVAL_MS,
	MAX_FETCHES_PER_PASS
} from '../../src/indexer/blurtFeeReverify';
import operatorRegisterHandler from '../../src/indexer/handlers/operatorRegister';
import { recordFeeRecipient } from '../../src/indexer/feeRecipients';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx, fakeConfig, mockBlurt, unusedBlurt } from '../testutils/context';

const AGE = 201_600;
const REG = 1_000_000;
const LATER = REG + AGE + 1_000;
/** Recent enough for the 30-day stranger-fee window and the 365-day order window. */
const BASE_TIME = Date.now() - 2 * 24 * 3600 * 1000;
const timeOf = (block: number): Date => new Date(BASE_TIME + (block - LATER) * 3_000);
const HERE = fakeConfig({ feeRecipient: 'morphit-fees' });

const d = INTEGRATION_ENABLED ? describe : describe.skip;

d('G1 — re-verification of fee ops judged before the fee account was known', () => {
	let fx: IntegrationFixture;
	/** block number → the block the (mock) chain serves. */
	let chain: Map<number, BlockHeader>;
	let fetches: number[];

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx.teardown();
	});
	beforeEach(async () => {
		await reset();
	});
	async function reset(): Promise<void> {
		await truncateAll(fx);
		for (const t of [
			'known_instances',
			'operator_registration_events',
			'operators',
			'stranger_fees'
		]) {
			await fx.db.query(`DELETE FROM ${t}`);
		}
		await fx.db.query('DELETE FROM operator_fee_recipients').catch(() => undefined);
		await fx.db.query('DELETE FROM fee_reverify_done').catch(() => undefined);
		chain = new Map();
		fetches = [];
	}

	/** What a v1.19.x node holds after applying B's re-registration: the
	 *  operators row and the event-log payload, but no history row. */
	async function oldNodeAppliedRegistration(): Promise<void> {
		await fx.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block, last_action_block_num)
			 VALUES ('bop', 'b-node', 'B', $1, $1)`,
			[REG - 50_000]
		);
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES ($1, 0, 0, $2, 'bbbb000000000000000000000000000000000001', 'bop', 'morphit_operator_register_v1',
			         '{"v":1,"tag":"b-node","display_name":"B","fee_recipient":"b-fees"}'::jsonb, 'applied')`,
			[REG, timeOf(REG)]
		);
	}

	/** Build the transaction a user of B broadcasts, put its block on the mock
	 *  chain, and run it through `handler` (which, with no history row yet,
	 *  judges it the old way). Returns the op context used. */
	async function indexOp(
		handler: Handler,
		opId: string,
		signer: string,
		blockNum: number,
		payload: Record<string, unknown>,
		legs: ReadonlyArray<[string, string]>,
		memo: string
	): Promise<{ ctx: OpContext; ok: boolean; reason?: string }> {
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
		const trx: BlockTransaction = {
			ref_block_num: blockNum & 0xffff,
			ref_block_prefix: 12345,
			expiration: timeOf(blockNum + 20)
				.toISOString()
				.slice(0, 19),
			operations,
			signatures: []
		};
		const trxId = transactionIdOf({ ...trx, extensions: [] })!;
		const trxInBlock = 1;
		chain.set(blockNum, {
			timestamp: timeOf(blockNum).toISOString().slice(0, 19),
			transactions: [{ ...trx, operations: [] }, trx],
			transaction_ids: ['0'.repeat(40), trxId]
		});
		const ctx = makeCtx({
			signer,
			blockNum,
			trxInBlock,
			opInTrx: 0,
			trxId,
			blockTime: timeOf(blockNum),
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
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status, reject_reason)
			 VALUES ($1, $2, 0, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
			[
				blockNum,
				trxInBlock,
				ctx.blockTime,
				trxId,
				signer,
				opId,
				JSON.stringify(payload),
				r.ok ? 'applied' : 'rejected',
				r.ok ? null : r.reason
			]
		);
		return { ctx, ...r };
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
	const VIA_B: ReadonlyArray<[string, string]> = [
		['b-fees', '56.250 BLURT'],
		['morphit-fees', '6.250 BLURT']
	];

	const reverifier = () =>
		new BlurtFeeReverifier({
			db: fx.db,
			blurt: mockBlurt({
				getBlock: async (n: number) => {
					fetches.push(n);
					return chain.get(n) ?? null;
				}
			}),
			config: HERE
		});

	const bootReconcile = () =>
		reconcileOperatorRegistrations({
			db: fx.db,
			blurt: unusedBlurt(),
			config: HERE,
			feeVerifiers: {},
			feeAmounts: {},
			fiatToUsd: (a) => a
		});

	const feeStatus = async (account: string, permlink: string) =>
		(
			await fx.db.query<{ fee_status: string }>(
				'SELECT fee_status FROM orders WHERE account = $1 AND permlink = $2',
				[account, permlink]
			)
		).rows[0]?.fee_status;

	it('an order paid via B that this node stored underpaid is re-verified once, from the re-fetched transaction', async () => {
		await oldNodeAppliedRegistration();
		await indexOp(
			orderHandler,
			'morphit_order_v1',
			'alice',
			LATER,
			orderPayload('p1'),
			VIA_B,
			'morphit-fee:p1'
		);
		expect(await feeStatus('alice', 'p1')).toBe('underpaid');

		await bootReconcile();
		const verified: string[] = [];
		const rv = new BlurtFeeReverifier({
			db: fx.db,
			blurt: mockBlurt({
				getBlock: async (n: number) => {
					fetches.push(n);
					return chain.get(n) ?? null;
				}
			}),
			config: HERE,
			onOrderVerified: (id) => verified.push(id)
		});
		const s = await rv.runOnce();
		expect(s.orders).toEqual({ checked: 1, verified: 1 });
		expect(await feeStatus('alice', 'p1')).toBe('verified');
		expect(verified).toEqual(['alice/p1']);
		// The verified fee counts toward the payer's loyalty tally, as live.
		const loyalty = await fx.db.query<{ c: string }>(
			`SELECT cumulative_blurt_paid::text AS c FROM account_loyalty WHERE account = 'alice'`
		);
		expect(Number(loyalty.rows[0]?.c)).toBeCloseTo(62.5, 3);
		// One-shot: a second pass fetches nothing.
		const before = fetches.length;
		await rv.runOnce();
		expect(fetches.length).toBe(before);
	});

	it('a transaction the chain serves back ALTERED (id no longer matches) changes nothing and is retried later', async () => {
		await oldNodeAppliedRegistration();
		await indexOp(
			orderHandler,
			'morphit_order_v1',
			'bob',
			LATER,
			orderPayload('p2'),
			VIA_B,
			'morphit-fee:p2'
		);
		await bootReconcile();
		// A lying node inflates the canonical leg so the fee would pass.
		const blk = chain.get(LATER)!;
		const t = blk.transactions[1]!;
		const forged = {
			...t,
			operations: t.operations.map((op) =>
				op[0] === 'transfer' && (op[1] as { to: string }).to === 'morphit-fees'
					? (['transfer', { ...op[1], amount: '62.500 BLURT' }] as ChainOperation)
					: op
			)
		};
		chain.set(LATER, { ...blk, transactions: [blk.transactions[0]!, forged] });
		const s = await reverifier().runOnce();
		expect(s.orders.verified).toBe(0);
		expect(s.fetchFailures).toBe(1);
		expect(await feeStatus('bob', 'p2')).toBe('underpaid');
		const done = await fx.db.query('SELECT 1 FROM fee_reverify_done');
		expect(done.rowCount).toBe(0);
	});

	it('orders that cannot flip are never fetched: no tag, untagged decoy, operator without a fees account, or genuinely short', async () => {
		await oldNodeAppliedRegistration();
		// A second operator C registered WITHOUT a fees account: nothing ties any
		// account to it, so nothing tagged C is selected (not even under LEGACY
		// GRACE).
		await fx.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block, last_action_block_num)
			 VALUES ('cop', 'c-node', 'C', $1, $1)`,
			[REG - 50_000]
		);
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES ($1, 0, 0, $2, 'cccc000000000000000000000000000000000001', 'cop', 'morphit_operator_register_v1',
			         '{"v":1,"tag":"c-node","display_name":"C"}'::jsonb, 'applied')`,
			[REG + 1, timeOf(REG + 1)]
		);
		// Untagged: the b-fees leg is a decoy here.
		const { operator_tag: _tag, ...untagged } = orderPayload('p3');
		await indexOp(
			orderHandler,
			'morphit_order_v1',
			'carl',
			LATER,
			untagged,
			VIA_B,
			'morphit-fee:p3'
		);
		// Tagged C, before and after C's registration: C has no fees account.
		for (const [who, blk] of [
			['dora', REG - 5],
			['dick', LATER + 1]
		] as const) {
			await indexOp(
				orderHandler,
				'morphit_order_v1',
				who,
				blk,
				{ ...orderPayload(`c-${who}`), operator_tag: 'c-node' },
				[
					['c-fees', '56.250 BLURT'],
					['morphit-fees', '6.250 BLURT']
				],
				`morphit-fee:c-${who}`
			);
		}
		await bootReconcile();
		const s = await reverifier().runOnce();
		expect(s.orders.checked).toBe(0);
		expect(fetches).toEqual([]);

		// Tagged B but genuinely short → fetched once, stays underpaid, marked done.
		await indexOp(
			orderHandler,
			'morphit_order_v1',
			'emma',
			LATER + 5,
			orderPayload('p5'),
			[
				['b-fees', '20.000 BLURT'],
				['morphit-fees', '2.500 BLURT']
			],
			'morphit-fee:p5'
		);
		const s2 = await reverifier().runOnce();
		expect(s2.orders).toEqual({ checked: 1, verified: 0 });
		expect(await feeStatus('emma', 'p5')).toBe('underpaid');
		const n = fetches.length;
		await reverifier().runOnce();
		expect(fetches.length).toBe(n);
	});

	it('a stranger fee paid via B and rejected before the upgrade is applied, so the pair is admitted', async () => {
		await oldNodeAppliedRegistration();
		const memo = 'morphit-stranger:rita';
		const r = await indexOp(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			LATER,
			{ v: 1, recipient: 'rita', amount_blurt: 5, operator_tag: 'b-node' },
			[
				['b-fees', '4.500 BLURT'],
				['morphit-fees', '0.500 BLURT']
			],
			memo
		);
		expect(r.ok).toBe(false);
		// The sender went on to pay other first-contact fees days LATER. The
		// escalating price must be judged as of the op's block — later
		// payments must not raise it.
		for (const [i, who] of ['una', 'vic', 'wes'].entries()) {
			await fx.db.query(
				`INSERT INTO stranger_fees (sender, recipient, paid_block_num, paid_trx_id, paid_at, amount_blurt)
				 VALUES ('sam', $1, $2, $3, $4, 5)`,
				[who, LATER + 50_000 + i, `later${i}`, timeOf(LATER + 50_000 + i)]
			);
		}
		await bootReconcile();
		const s = await reverifier().runOnce();
		expect(s.strangerFees).toEqual({ checked: 1, applied: 1 });
		const row = await fx.db.query(
			`SELECT paid_block_num::text AS b FROM stranger_fees WHERE sender='sam' AND recipient='rita'`
		);
		expect(row.rows).toEqual([{ b: String(LATER) }]);
		const op = await fx.db.query<{ status: string; reject_reason: string | null }>(
			`SELECT status, reject_reason FROM ops WHERE op_id = 'morphit_stranger_fee_v1' AND signer = 'sam'`
		);
		expect(op.rows).toEqual([{ status: 'applied', reject_reason: null }]);
	});

	it('V3-9: the Sybil tier is counted in CHAIN order — a later order in the SAME block does not raise it', async () => {
		await oldNodeAppliedRegistration();
		// alice already has 3 live orders.
		for (const p of ['e1', 'e2', 'e3']) {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, amount_min, amount_max, price_model,
				                     payment_methods, status, created_at, updated_at, fee_status, fee_method)
				 VALUES ('alice', $1, 'sell','BLURT','USD',10,100,'{"kind":"spread","percent":1}'::jsonb,
				         ARRAY['cash'],'live', $2, $2, 'verified','blurt')`,
				[p, new Date(timeOf(LATER).getTime() - 3600_000)]
			);
		}
		// 4th order: tier 4 = 62.5 × 1.25 = 78.125 BLURT, paid via B (90/10).
		const legs: ReadonlyArray<[string, string]> = [
			['b-fees', '70.313 BLURT'],
			['morphit-fees', '7.813 BLURT']
		];
		await indexOp(
			orderHandler,
			'morphit_order_v1',
			'alice',
			LATER,
			orderPayload('o4'),
			legs,
			'morphit-fee:o4'
		);
		expect(await feeStatus('alice', 'o4')).toBe('underpaid'); // the old (v1.19) judgment
		// alice's 5th order sits LATER in the same block: its create op is at
		// (LATER, trx 2), after o4's (LATER, trx 1).
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, amount_min, amount_max, price_model,
			                     payment_methods, status, created_at, updated_at, fee_status, fee_method)
			 VALUES ('alice', 'o5', 'sell','BLURT','USD',10,100,'{"kind":"spread","percent":1}'::jsonb,
			         ARRAY['cash'],'live', $1, $1, 'verified','blurt')`,
			[timeOf(LATER)]
		);
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES ($1, 2, 0, $2, 'o5o5000000000000000000000000000000000000', 'alice', 'morphit_order_v1', $3::jsonb, 'applied')`,
			[LATER, timeOf(LATER), JSON.stringify(orderPayload('o5'))]
		);
		await bootReconcile();
		await reverifier().runOnce();
		// What a fresh v1.20 node decides live for the same op (o5 not yet seen): verified.
		expect(await feeStatus('alice', 'o4')).toBe('verified');
	});

	// ── LEGACY GRACE (v1.20.0, G1 wave 3) ────────────────────────────────────
	// On v1.19 every BLURT order paid through B went 90 % to B's own fees
	// account, which no other instance could know. B's first `fee_recipient`
	// registration (block R) comes AFTER those orders, so the strict as-of-block
	// rule can never accept them. Below E = R + 1 (the first block at which the
	// strict rule accepts B's account), an op is judged as if the FIRST account
	// B registered had been in force.

	const LEGACY = REG - 1_000;
	const B_REGISTER = { v: 1, tag: 'b-node', display_name: 'B', fee_recipient: 'b-fees' };

	/** B's operators row from its original (pre-G1) registration. */
	async function operatorB(): Promise<void> {
		await fx.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block, last_action_block_num)
			 VALUES ('bop', 'b-node', 'B', $1, $1)`,
			[REG - 50_000]
		);
	}

	/** B's re-registration with `fee_recipient`, as each kind of node holds it. */
	async function bRegisters(
		kind: 'upgraded' | 'fresh' | 'fastsync',
		block: number,
		feeRecipient: string,
		trxId: string
	): Promise<void> {
		const payload = { ...B_REGISTER, fee_recipient: feeRecipient };
		let status = 'applied';
		if (kind === 'fresh') {
			// A v1.20 node applies it through the real handler (writes the history row).
			const ctx = makeCtx({
				signer: 'bop',
				blockNum: block,
				trxInBlock: 0,
				opInTrx: 0,
				trxId,
				blockTime: timeOf(block),
				payload,
				config: HERE
			});
			const c = await fx.pool.connect();
			try {
				await c.query('BEGIN');
				const r = await operatorRegisterHandler(ctx, c);
				await c.query(r.ok ? 'COMMIT' : 'ROLLBACK');
				expect(r).toMatchObject({ ok: true });
			} finally {
				c.release();
			}
		}
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES ($1, 0, 0, $2, $3, 'bop', 'morphit_operator_register_v1', $4::jsonb, $5)`,
			[block, timeOf(block), trxId, JSON.stringify(payload), status]
		);
		if (kind === 'fastsync') {
			// The snapshot carries the history row its source built.
			await recordFeeRecipient(fx.db, {
				account: 'bop',
				feeRecipient,
				blockNum: block,
				trxId,
				trxInBlock: 0,
				opInTrx: 0
			});
		}
		// 'upgraded': the v1.19 handler kept only the ops row; the boot
		// reconcile back-fills the history from it.
	}

	/**
	 * One node's final verdict on a legacy order (block LEGACY, before B ever
	 * registered a fees account) whose legs are `legs`, after B registers
	 * `b-fees` at REG.
	 */
	async function legacyVerdict(
		kind: 'upgraded' | 'fresh' | 'fastsync',
		legs: ReadonlyArray<[string, string]>
	): Promise<string | undefined> {
		await reset();
		await operatorB();
		// Every kind of node judged the order live with no fees account known for
		// B (the v1.19 rule and the strict v1.20 rule agree): underpaid.
		await indexOp(
			orderHandler,
			'morphit_order_v1',
			'lena',
			LEGACY,
			orderPayload('legacy'),
			legs,
			'morphit-fee:legacy'
		);
		expect(await feeStatus('lena', 'legacy')).toBe('underpaid');
		await bRegisters(kind, REG, 'b-fees', 'bbbb000000000000000000000000000000000001');
		if (kind === 'upgraded') await bootReconcile();
		// A fast-synced node's `fee_reverify_done` is local and starts empty.
		expect((await fx.db.query('SELECT 1 FROM fee_reverify_done')).rowCount).toBe(0);
		await reverifier().runOnce();
		await reverifier().runOnce();
		return feeStatus('lena', 'legacy');
	}

	it('LEGACY GRACE converges: an order paid to B’s first-registered account before B registered it ends VERIFIED on an upgraded, a fresh and a fast-synced node', async () => {
		const verdicts: Record<string, string | undefined> = {};
		for (const kind of ['upgraded', 'fresh', 'fastsync'] as const) {
			verdicts[kind] = await legacyVerdict(kind, VIA_B);
		}
		expect(verdicts).toEqual({ upgraded: 'verified', fresh: 'verified', fastsync: 'verified' });
	});

	it('LEGACY GRACE converges: a leg paid to an account B used BEFORE its first registration (≠ F) stays UNDERPAID on all three, by design', async () => {
		const legs: ReadonlyArray<[string, string]> = [
			['b-old-fees', '56.250 BLURT'],
			['morphit-fees', '6.250 BLURT']
		];
		const verdicts: Record<string, string | undefined> = {};
		for (const kind of ['upgraded', 'fresh', 'fastsync'] as const) {
			verdicts[kind] = await legacyVerdict(kind, legs);
		}
		expect(verdicts).toEqual({ upgraded: 'underpaid', fresh: 'underpaid', fastsync: 'underpaid' });
	});

	it('LEGACY GRACE: before R the leg must go EXACTLY to the FIRST registered account; no canonical leg or a short amount still fails', async () => {
		await operatorB();
		const cases: Array<[string, ReadonlyArray<[string, string]>, string]> = [
			['to-first', VIA_B, 'verified'],
			[
				'to-second', // B's SECOND fees account, registered later: not F
				[
					['b-new-fees', '56.250 BLURT'],
					['morphit-fees', '6.250 BLURT']
				],
				'underpaid'
			],
			[
				// 100 % to F, nothing to @morphit-fees: no leg this node recognised,
				// stored `missing` — and without the canonical cut it can never
				// pass, so it is not even fetched.
				'no-canon',
				[['b-fees', '62.500 BLURT']],
				'missing'
			],
			[
				'short', // 90/10 but the total is below the listing fee
				[
					['b-fees', '30.000 BLURT'],
					['morphit-fees', '3.333 BLURT']
				],
				'underpaid'
			]
		];
		for (const [i, [p, legs]] of cases.entries()) {
			const r = await indexOp(
				orderHandler,
				'morphit_order_v1',
				`lp${i}`,
				LEGACY - i,
				orderPayload(p),
				legs,
				`morphit-fee:${p}`
			);
			expect(r.ok).toBe(true);
		}
		await bRegisters('fresh', REG, 'b-fees', 'bbbb000000000000000000000000000000000001');
		await bRegisters('fresh', REG + 100, 'b-new-fees', 'bbbb000000000000000000000000000000000002');
		const s = await reverifier().runOnce();
		expect(s.orders).toEqual({ checked: 3, verified: 1 });
		for (const [i, [p, , want]] of cases.entries()) {
			expect([p, await feeStatus(`lp${i}`, p)]).toEqual([p, want]);
		}
	});

	it('LEGACY GRACE: an order in the SAME block as B’s first registration (strictly: not yet in force) is accepted against it', async () => {
		await operatorB();
		await bRegisters('fresh', REG, 'b-fees', 'bbbb000000000000000000000000000000000001');
		await indexOp(
			orderHandler,
			'morphit_order_v1',
			'dora',
			REG,
			orderPayload('same-block'),
			VIA_B,
			'morphit-fee:same-block'
		);
		expect(await feeStatus('dora', 'same-block')).toBe('underpaid'); // strict: row not before REG
		await reverifier().runOnce();
		expect(await feeStatus('dora', 'same-block')).toBe('verified');
	});

	it('LEGACY GRACE never moves: a later fees-account change does not un-grace legacy orders; orders after it are judged strictly', async () => {
		await operatorB();
		await indexOp(
			orderHandler,
			'morphit_order_v1',
			'lena',
			LEGACY,
			orderPayload('old'),
			VIA_B,
			'morphit-fee:old'
		);
		await bRegisters('fresh', REG, 'b-fees', 'bbbb000000000000000000000000000000000001');
		await bRegisters('fresh', REG + 500, 'b-fees2', 'bbbb000000000000000000000000000000000002');
		// Paid to the OLD account after the change: the strict rule refuses it.
		await indexOp(
			orderHandler,
			'morphit_order_v1',
			'mick',
			LATER,
			orderPayload('after-change'),
			VIA_B,
			'morphit-fee:after-change'
		);
		await reverifier().runOnce();
		expect(await feeStatus('lena', 'old')).toBe('verified');
		expect(await feeStatus('mick', 'after-change')).toBe('underpaid');
	});

	it('LEGACY GRACE: expired or closed legacy orders are not re-judged', async () => {
		await operatorB();
		for (const [i, [who, p]] of (
			[
				['xena', 'expired'],
				['yuri', 'closed']
			] as const
		).entries()) {
			await indexOp(
				orderHandler,
				'morphit_order_v1',
				who,
				LEGACY - i,
				orderPayload(p),
				VIA_B,
				`morphit-fee:${p}`
			);
		}
		await fx.db.query(
			`UPDATE orders SET expires_at = NOW() - INTERVAL '1 hour' WHERE permlink = 'expired'`
		);
		await fx.db.query(`UPDATE orders SET status = 'cancelled' WHERE permlink = 'closed'`);
		await bRegisters('fresh', REG, 'b-fees', 'bbbb000000000000000000000000000000000001');
		const s = await reverifier().runOnce();
		expect(s.orders.checked).toBe(0);
		expect(fetches).toEqual([]);
		expect(await feeStatus('xena', 'expired')).toBe('underpaid');
	});

	it('LEGACY GRACE: a TAGGED stranger fee from before R is applied; an untagged (v1.19-shaped) one is never selected', async () => {
		await operatorB();
		const legs: ReadonlyArray<[string, string]> = [
			['b-fees', '4.500 BLURT'],
			['morphit-fees', '0.500 BLURT']
		];
		const tagged = await indexOp(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'sam',
			LEGACY,
			{ v: 1, recipient: 'rita', amount_blurt: 5, operator_tag: 'b-node' },
			legs,
			'morphit-stranger:rita'
		);
		expect(tagged).toMatchObject({ ok: false, reason: 'fee_underpaid' });
		const untagged = await indexOp(
			strangerFeeHandler,
			'morphit_stranger_fee_v1',
			'tom',
			LEGACY - 1,
			{ v: 1, recipient: 'rita', amount_blurt: 5 },
			legs,
			'morphit-stranger:rita'
		);
		expect(untagged).toMatchObject({ ok: false, reason: 'fee_underpaid' });
		await bRegisters('fresh', REG, 'b-fees', 'bbbb000000000000000000000000000000000001');
		const s = await reverifier().runOnce();
		expect(s.strangerFees).toEqual({ checked: 1, applied: 1 });
		expect(fetches).toEqual([LEGACY]);
		const paid = await fx.db.query<{ sender: string }>(
			`SELECT sender FROM stranger_fees WHERE recipient = 'rita'`
		);
		expect(paid.rows).toEqual([{ sender: 'sam' }]);
	});

	it('LEGACY GRACE is prompt: a pass runs AT ONCE when B’s registration lands, and a backlog beyond one pass drains every BACKLOG_INTERVAL_MS, not every INTERVAL_MS', async () => {
		await operatorB();
		const N = MAX_FETCHES_PER_PASS + 5;
		for (let i = 0; i < N; i++) {
			await indexOp(
				orderHandler,
				'morphit_order_v1',
				`payer${i}`,
				LEGACY - i,
				orderPayload(`bulk${i}`),
				VIA_B,
				`morphit-fee:bulk${i}`
			);
		}
		let clock = 1_000_000;
		const rv = new BlurtFeeReverifier({
			db: fx.db,
			blurt: mockBlurt({
				getBlock: async (n: number) => {
					fetches.push(n);
					return chain.get(n) ?? null;
				}
			}),
			config: HERE,
			now: () => clock
		});
		const verifiedCount = async () =>
			Number(
				(
					await fx.db.query<{ n: string }>(
						`SELECT count(*)::text AS n FROM orders WHERE fee_status = 'verified'`
					)
				).rows[0]?.n
			);
		await rv.maybeRun(); // the first pass after boot: nothing to do yet
		expect(await verifiedCount()).toBe(0);
		// B upgrades (its heal registers `b-fees`), a second later — long before
		// the 10-minute rotation.
		await bRegisters('fresh', REG, 'b-fees', 'bbbb000000000000000000000000000000000001');
		clock += 1_000;
		await rv.maybeRun();
		expect(await verifiedCount()).toBe(MAX_FETCHES_PER_PASS);
		// The rest: on the backlog interval.
		clock += BACKLOG_INTERVAL_MS - 1;
		await rv.maybeRun();
		expect(await verifiedCount()).toBe(MAX_FETCHES_PER_PASS);
		clock += 1;
		await rv.maybeRun();
		expect(await verifiedCount()).toBe(N);
		expect(BACKLOG_INTERVAL_MS).toBeLessThan(INTERVAL_MS);
	});
});
