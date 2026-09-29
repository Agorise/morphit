/**
 * v1.20.0 (G1) — BLURT fees verify ACROSS instances.
 *
 * Before: every indexer counted the 90 % owner leg only when it went to its OWN
 * MORPHIT_INDEXER_FEE_RECIPIENT, so an order posted through instance B (legs to
 * @b-fees + @morphit-fees) was `underpaid` — hidden — on every other instance,
 * and a first-contact DM from a B user was dropped on the recipient's instance.
 *
 * Now: the owner leg may also go to the fee_recipient that the operator OWNING
 * the op's `operator_tag` registered on chain before the op's block. The chain
 * is the only list — no maintainer list, no stake. These tests drive the REAL
 * handlers — register, order, stranger fee — against real Postgres; every
 * verdict is read back from the rows the handlers wrote.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import registerHandler from '../../src/indexer/handlers/operatorRegister';
import orderHandler from '../../src/indexer/handlers/order';
import strangerFeeHandler from '../../src/indexer/handlers/strangerFee';
import type { Handler, OpContext } from '../../src/indexer/handler-contract';
import type { ChainOperation } from '../../src/blurt/client';
import {
	reconcileOperatorRegistrations,
	backfillFeeRecipientHistory
} from '../../src/indexer/reconcileRegistrations';
import { instanceRoute } from '../../src/api/instance';
import { operatorRegistrationRoute } from '../../src/api/operatorRegistration';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx, fakeConfig, unusedBlurt } from '../testutils/context';

const REG = 1_000_000;
/** An order block after the registrations. */
const LATER = REG + 1_000;
const timeOf = (block: number): Date => new Date(Date.UTC(2026, 0, 1) + block * 3_000);

/** This indexer is the canonical instance: its own recipient is the treasury. */
const HERE = fakeConfig({ feeRecipient: 'morphit-fees' });

const d = INTEGRATION_ENABLED ? describe : describe.skip;

d('G1 — cross-instance BLURT fee verification', () => {
	let fx: IntegrationFixture;
	let trxSeq = 0;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.query('DELETE FROM known_instances');
		await fx.db.query('DELETE FROM operator_registration_events');
		await fx.db.query('DELETE FROM operators');
		await fx.db.query('DELETE FROM stranger_fees');
		// The history table only exists once G1 is in; on the unfixed code this
		// cleanup is simply skipped (the assertions below are what fail).
		await fx.db.query('DELETE FROM operator_fee_recipients').catch(() => undefined);
	});

	/** Run one op like the dispatcher does: its own transaction, rolled back on
	 *  a rejection, with the event-log row written either way. */
	async function apply(
		handler: Handler,
		opId: string,
		over: Partial<OpContext> & { signer: string; blockNum: number; payload: unknown }
	): Promise<{ ok: boolean; reason?: string }> {
		const seq = ++trxSeq;
		const trxId = (over.trxId ?? `trx${String(seq).padStart(37, '0')}`).slice(0, 40);
		const ctx = makeCtx({
			trxInBlock: seq,
			config: HERE,
			blockTime: timeOf(over.blockNum),
			feeAmounts: { blurtBase: 62.5 },
			blurt: unusedBlurt(),
			...over,
			trxId
		});
		const c = await fx.pool.connect();
		try {
			await c.query('BEGIN');
			const r = await handler(ctx, c);
			if (!r.ok) await c.query('ROLLBACK');
			else await c.query('COMMIT');
			await c.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status, reject_reason)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
				[
					ctx.blockNum,
					ctx.trxInBlock,
					ctx.opInTrx,
					ctx.blockTime,
					trxId,
					ctx.signer,
					opId,
					JSON.stringify(ctx.payload),
					r.ok ? 'applied' : 'rejected',
					r.ok ? null : r.reason
				]
			);
			return r;
		} finally {
			c.release();
		}
	}

	const register = (
		account: string,
		tag: string,
		blockNum: number,
		extra: Record<string, unknown> = {}
	) =>
		apply(registerHandler, 'morphit_operator_register_v1', {
			signer: account,
			blockNum,
			payload: { v: 1, tag, display_name: `${tag} market`, ...extra }
		});

	const leg = (from: string, to: string, amount: string, memo: string): ChainOperation =>
		['transfer', { from, to, amount, memo }] as const;

	/** Post an order paying `legs`, return the fee_status the handler stored. */
	async function postOrder(
		signer: string,
		blockNum: number,
		legs: ReadonlyArray<[to: string, amount: string]>,
		tag?: string,
		config = HERE
	): Promise<string | undefined> {
		const permlink = `o-${signer}-${blockNum}`;
		const r = await apply(orderHandler, 'morphit_order_v1', {
			signer,
			blockNum,
			config,
			payload: {
				permlink,
				side: 'sell',
				asset: 'BLURT',
				fiat_currency: 'USD',
				amount_min: 10,
				amount_max: 100,
				price_model: { kind: 'spread', percent: 1 },
				payment_methods: ['cash'],
				...(tag !== undefined ? { operator_tag: tag } : {})
			},
			siblingOps: legs.map(([to, amount]) => leg(signer, to, amount, `morphit-fee:${permlink}`))
		});
		expect(r.ok).toBe(true);
		const row = await fx.db.query<{ fee_status: string }>(
			'SELECT fee_status FROM orders WHERE account = $1 AND permlink = $2',
			[signer, permlink]
		);
		return row.rows[0]?.fee_status;
	}

	/** The fee a user of instance B pays: 90 % to B's account, 10 % canonical. */
	const VIA_B: ReadonlyArray<[string, string]> = [
		['b-fees', '56.250 BLURT'],
		['morphit-fees', '6.250 BLURT']
	];

	it('an order posted via B (tag of an operator whose registered fee_recipient is b-fees) verifies here', async () => {
		expect(await register('bop', 'b-node', REG, { fee_recipient: 'b-fees' })).toEqual({ ok: true });
		expect(await postOrder('alice', LATER, VIA_B, 'b-node')).toBe('verified');
	});

	it('any operator that registered a fees account counts from the NEXT block — no list, no extra step', async () => {
		// Before the operator published a fees account: underpaid.
		expect(await postOrder('amy', REG - 1, VIA_B, 'b-node')).toBe('underpaid');
		await register('bop', 'b-node', REG, { fee_recipient: 'b-fees' });
		// The registration's own block does not count yet (block-order independent).
		expect(await postOrder('ben', REG, VIA_B, 'b-node')).toBe('underpaid');
		expect(await postOrder('cyd', REG + 1, VIA_B, 'b-node')).toBe('verified');
		// A brand-new instance (e.g. a third-party one) is accepted the same way.
		await register('vop', 'vig', REG + 2, { fee_recipient: 'vig-fees' });
		expect(
			await postOrder(
				'dee',
				REG + 3,
				[
					['vig-fees', '56.250 BLURT'],
					['morphit-fees', '6.250 BLURT']
				],
				'vig'
			)
		).toBe('verified');
	});

	it('the same order is still verified on B itself and on a third instance C', async () => {
		await register('bop', 'b-node', REG, { fee_recipient: 'b-fees' });
		expect(
			await postOrder('carol', LATER, VIA_B, 'b-node', fakeConfig({ feeRecipient: 'b-fees' }))
		).toBe('verified');
		expect(
			await postOrder('dave', LATER, VIA_B, 'b-node', fakeConfig({ feeRecipient: 'c-fees' }))
		).toBe('verified');
	});

	it("a leg to b-fees with no tag, or with another operator's tag, stays ignored (decoy defence)", async () => {
		await register('bop', 'b-node', REG, { fee_recipient: 'b-fees' });
		await register('cop', 'c-node', REG, { fee_recipient: 'c-fees' });
		expect(await postOrder('alice', LATER, VIA_B)).toBe('underpaid');
		expect(await postOrder('frank', LATER, VIA_B, 'c-node')).toBe('underpaid');
		expect(await postOrder('gina', LATER, VIA_B, 'no-such-tag')).toBe('underpaid');
	});

	it('the canonical 10 % leg stays mandatory', async () => {
		await register('bop', 'b-node', REG, { fee_recipient: 'b-fees' });
		expect(await postOrder('alice', LATER, [['b-fees', '62.500 BLURT']], 'b-node')).toBe(
			'underpaid'
		);
		// The 100 % canonical fee (an instance with no fees account) still verifies.
		expect(await postOrder('hank', LATER, [['morphit-fees', '62.500 BLURT']])).toBe('verified');
	});

	it('replay determinism: a later fee_recipient change never flips an older order; the history table records both', async () => {
		await register('bop', 'b-node', REG, { fee_recipient: 'b-fees' });
		const CHANGE = LATER + 10_000;
		await register('bop', 'b-node', CHANGE, { fee_recipient: 'b-fees2' });

		// Paid to b-fees BEFORE the change → verified; AFTER → underpaid.
		expect(await postOrder('alice', CHANGE - 1, VIA_B, 'b-node')).toBe('verified');
		expect(await postOrder('ivan', CHANGE + 1, VIA_B, 'b-node')).toBe('underpaid');
		expect(
			await postOrder(
				'judy',
				CHANGE + 1,
				[
					['b-fees2', '56.250 BLURT'],
					['morphit-fees', '6.250 BLURT']
				],
				'b-node'
			)
		).toBe('verified');
		// A registration in the SAME block as the order does not count yet.
		expect(
			await postOrder(
				'kate',
				CHANGE,
				[
					['b-fees2', '56.250 BLURT'],
					['morphit-fees', '6.250 BLURT']
				],
				'b-node'
			)
		).toBe('underpaid');

		const hist = await fx.db.query<{ fee_recipient: string; effective_block: string }>(
			`SELECT fee_recipient, effective_block::text FROM operator_fee_recipients
			  WHERE account = 'bop' ORDER BY effective_block`
		);
		expect(hist.rows).toEqual([
			{ fee_recipient: 'b-fees', effective_block: String(REG) },
			{ fee_recipient: 'b-fees2', effective_block: String(CHANGE) }
		]);
		// A re-registration WITHOUT the field leaves the recipient as it was.
		await register('bop', 'b-node', CHANGE + 5);
		expect(
			await postOrder(
				'liam',
				CHANGE + 10,
				[
					['b-fees2', '56.250 BLURT'],
					['morphit-fees', '6.250 BLURT']
				],
				'b-node'
			)
		).toBe('verified');
	});

	it('a malformed fee_recipient rejects the registration (fee_recipient_invalid) and changes nothing', async () => {
		for (const bad of ['B-Fees', '@b-fees', 'x', 7, { a: 1 }]) {
			expect(await register('bop', 'b-node', REG, { fee_recipient: bad })).toEqual({
				ok: false,
				reason: 'fee_recipient_invalid'
			});
		}
		const n = await fx.db.query(`SELECT 1 FROM operators WHERE account = 'bop'`);
		expect(n.rowCount).toBe(0);
		// An unknown extra field is ignored (forward compatibility).
		expect(
			await register('bop', 'b-node', REG, { fee_recipient: 'b-fees', future_field: 'x' })
		).toEqual({ ok: true });
	});

	it("a first-contact stranger fee paid via B verifies on the recipient's instance", async () => {
		await register('bop', 'b-node', REG, { fee_recipient: 'b-fees' });
		const memo = 'morphit-stranger:rita';
		const pay = (signer: string, tag?: string) =>
			apply(strangerFeeHandler, 'morphit_stranger_fee_v1', {
				signer,
				blockNum: LATER,
				payload: {
					v: 1,
					recipient: 'rita',
					amount_blurt: 5,
					...(tag ? { operator_tag: tag } : {})
				},
				siblingOps: [
					leg(signer, 'b-fees', '4.500 BLURT', memo),
					leg(signer, 'morphit-fees', '0.500 BLURT', memo)
				]
			});
		expect(await pay('sam', 'b-node')).toEqual({ ok: true });
		const row = await fx.db.query(
			`SELECT 1 FROM stranger_fees WHERE sender = 'sam' AND recipient = 'rita'`
		);
		expect(row.rowCount).toBe(1);
		// Without the tag the b-fees leg is still a decoy here.
		expect(await pay('tom')).toEqual({ ok: false, reason: 'fee_underpaid' });
	});

	it('the boot reconcile records history for a healed registration AND back-fills registrations an older indexer applied', async () => {
		// (a) An operator_register op an OLDER build applied (it ignored the
		//     field): the event log has the payload, the history table nothing.
		await fx.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block, last_action_block_num)
			 VALUES ('bop', 'b-node', 'B', $1, $1)`,
			[REG]
		);
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES ($1, 2, 0, $2, 'aaaa000000000000000000000000000000000001', 'bop', 'morphit_operator_register_v1',
			         '{"v":1,"tag":"b-node","display_name":"B","fee_recipient":"b-fees"}'::jsonb, 'applied'),
			        ($1 + 5, 0, 0, $2, 'aaaa000000000000000000000000000000000002', 'bop', 'morphit_operator_register_v1',
			         '{"v":1,"tag":"b-node","display_name":"B","fee_recipient":"NOT VALID"}'::jsonb, 'applied')`,
			[REG, timeOf(REG)]
		);
		// (b) A registration a validator bug REJECTED, carrying fee_recipient.
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status, reject_reason)
			 VALUES ($1, 0, 0, $2, 'cccc000000000000000000000000000000000003', 'cop', 'morphit_operator_register_v1',
			         '{"v":1,"tag":"c-node","display_name":"C market","fee_recipient":"c-fees"}'::jsonb, 'rejected', 'old_validator_bug')`,
			[REG + 7, timeOf(REG + 7)]
		);
		const summary = await reconcileOperatorRegistrations({
			db: fx.db,
			blurt: unusedBlurt(),
			config: HERE,
			feeVerifiers: {},
			feeAmounts: {},
			fiatToUsd: (a) => a
		});
		expect(summary.healed).toBe(1);
		const hist = await fx.db.query<{
			account: string;
			fee_recipient: string;
			effective_block: string;
			trx_in_block: number;
		}>(
			`SELECT account, fee_recipient, effective_block::text, trx_in_block FROM operator_fee_recipients ORDER BY account`
		);
		expect(hist.rows).toEqual([
			{ account: 'bop', fee_recipient: 'b-fees', effective_block: String(REG), trx_in_block: 2 },
			{ account: 'cop', fee_recipient: 'c-fees', effective_block: String(REG + 7), trx_in_block: 0 }
		]);
		// Idempotent: a second boot adds nothing.
		await reconcileOperatorRegistrations({
			db: fx.db,
			blurt: unusedBlurt(),
			config: HERE,
			feeVerifiers: {},
			feeAmounts: {},
			fiatToUsd: (a) => a
		});
		const again = await fx.db.query(`SELECT 1 FROM operator_fee_recipients`);
		expect(again.rowCount).toBe(2);
		// And both now drive the verifier.
		expect(await postOrder('alice', LATER, VIA_B, 'b-node')).toBe('verified');
		expect(
			await postOrder(
				'mona',
				LATER,
				[
					['c-fees', '56.250 BLURT'],
					['morphit-fees', '6.250 BLURT']
				],
				'c-node'
			)
		).toBe('verified');
	});

	it('BACKFILL STARVATION (V3-8): rows the back-fill can never record do not hide later rows', async () => {
		let b = REG;
		for (const fr of ['', null, 'BAD', 'x']) {
			await fx.db.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
				 VALUES ($1, 0, 0, NOW(), $2, 'spam', 'morphit_operator_register_v1', $3::jsonb, 'applied')`,
				[
					++b,
					`t${b}`,
					JSON.stringify({ v: 1, tag: 'spam-tag', display_name: 'x', fee_recipient: fr })
				]
			);
		}
		// A valid-looking value on a payload the validator refuses (display name).
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES ($1, 0, 0, NOW(), $2, 'spam', 'morphit_operator_register_v1', $3::jsonb, 'applied')`,
			[
				++b,
				`t${b}`,
				JSON.stringify({ v: 1, tag: 'spam-tag', display_name: '', fee_recipient: 'spam-fees' })
			]
		);
		await fx.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES ($1, 0, 0, NOW(), 'tB', 'bop', 'morphit_operator_register_v1', $2::jsonb, 'applied')`,
			[++b, JSON.stringify({ v: 1, tag: 'b-node', display_name: 'B', fee_recipient: 'b-fees' })]
		);
		await backfillFeeRecipientHistory(fx.db, 2);
		const hist = await fx.db.query<{ account: string }>(
			`SELECT account FROM operator_fee_recipients`
		);
		expect(hist.rows).toEqual([{ account: 'bop' }]);
	});

	it("/v1/instance reports whether this instance's fees account is registered (= accepted elsewhere)", async () => {
		const read = async (cfg: ReturnType<typeof fakeConfig>) => {
			const res = await instanceRoute(cfg, undefined, fx.db).request('/');
			const body = (await res.json()) as Record<string, unknown>;
			return {
				fee_recipient: body.fee_recipient,
				fee_recipient_registered: body.fee_recipient_registered
			};
		};
		const B = fakeConfig({ feeRecipient: 'b-fees', instanceOperatorTag: 'b-node' });
		// Not registered at all yet.
		expect(await read(B)).toEqual({
			fee_recipient: 'b-fees',
			fee_recipient_registered: false
		});
		// Registered, but without the field (every pre-v1.20 registration).
		await register('bop', 'b-node', REG);
		expect((await read(B)).fee_recipient_registered).toBe(false);
		// Registered with a DIFFERENT account than the one configured.
		await register('bop', 'b-node', REG + 10, { fee_recipient: 'old-fees' });
		expect((await read(B)).fee_recipient_registered).toBe(false);
		// Registered with the configured account.
		await register('bop', 'b-node', REG + 20, { fee_recipient: 'b-fees' });
		expect(await read(B)).toEqual({
			fee_recipient: 'b-fees',
			fee_recipient_registered: true
		});
		// An instance paying 100 % to the canonical treasury needs no registration.
		expect(
			(await read(fakeConfig({ feeRecipient: 'morphit-fees' }))).fee_recipient_registered
		).toBe(true);
	});

	it('V3-4: /v1/operator-registration/:account serves the newest APPLIED register payload (what the upgrade heal re-publishes)', async () => {
		const route = operatorRegistrationRoute(fx.db);
		expect((await route.request('/bop')).status).toBe(404);
		await register('bop', 'b-node', REG, {
			contact_url: 'https://b.example/c',
			origin: 'https://b.example'
		});
		// A later op the handler REFUSES (bad fee_recipient) must not be served.
		await register('bop', 'b-node', REG + 5, { fee_recipient: 'NOT VALID' });
		const res = await route.request('/bop');
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			account: 'bop',
			tag: 'b-node',
			block_num: REG,
			payload: {
				v: 1,
				tag: 'b-node',
				display_name: 'b-node market',
				contact_url: 'https://b.example/c',
				origin: 'https://b.example'
			}
		});
		expect((await route.request('/Not%20An%20Account')).status).toBe(400);
	});
});
