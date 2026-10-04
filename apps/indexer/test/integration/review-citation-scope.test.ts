/**
 * a review may cite only an order the reviewer and the subject traded
 * on, from the consensus activation time (block timestamp).
 *
 * Before: any paid order of either party, of any age or status, was a valid
 * citation. One counterparty with ONE verified conversation filed one 1★ review
 * per order the victim ever listed (six citations took a 5.00 average to 2.82),
 * and no detector fired.
 *
 * Real feedback handler, real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import feedbackHandler from '../../src/indexer/handlers/feedback';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

const NOW = new Date('2026-10-01T12:00:00Z');
/** A review in a block stamped at the activation time, and one a second earlier. */
const H = new Date(CONSENSUS_V2_ACTIVATION_TIME);
const BEFORE = new Date(H.getTime() - 1000);

describe.skipIf(!INTEGRATION_ENABLED)('review citations are bound to the pair', () => {
	let fx: IntegrationFixture;
	let trx = 0;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		// The victim's six paid orders, one live, the rest long cancelled.
		for (let i = 0; i < 6; i++) {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method)
				 VALUES ('bob', $1, 'sell', 'BLURT', 'USD', '{"kind":"spread","percent":0}', ARRAY['cash'],
				         $2, $3, $3, 'verified', 'blurt')`,
				[
					`bob-order-${i}`,
					i === 0 ? 'live' : 'cancelled',
					new Date(NOW.getTime() - 86_400_000 * (10 - i))
				]
			);
		}
		// One verified conversation between mallory and bob, about nothing in particular.
		await chat('mallory', 'bob', null);
	});

	async function chat(a: string, b: string, orderPermlink: string | null): Promise<void> {
		const t0 = new Date(NOW.getTime() - 3 * 3_600_000);
		for (const [s, r, m] of [
			[a, b, 0],
			[b, a, 5],
			[a, b, 10],
			[b, a, 20]
		] as const) {
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
				 VALUES ($1, $2, 'x', '{}'::jsonb, $3, $4, $5)`,
				[s, r, new Date(t0.getTime() + m * 60_000), `c${trx++}`, orderPermlink]
			);
		}
	}

	const review = (reviewer: string, permlink: string, blockTime: Date) =>
		fx.db.withTx((c) =>
			feedbackHandler(
				makeCtx({
					signer: reviewer,
					blockNum: 700,
					blockTime,
					trxId: String(trx++).padStart(40, 'a'),
					payload: { subject: 'bob', rating: 1, order_permlink: permlink }
				}),
				c
			)
		);

	it('from the activation time, orders the pair never traded on cannot be cited', async () => {
		const verdicts = [];
		for (let i = 0; i < 6; i++) verdicts.push(await review('mallory', `bob-order-${i}`, H));
		expect(verdicts.every((v) => !v.ok)).toBe(true);
		const n = await fx.db.query(
			`SELECT count(*)::int AS n FROM feedback WHERE reviewer = 'mallory'`
		);
		expect(n.rows[0]).toEqual({ n: 0 });
	});

	it('an order the pair discussed in chat, or completed together, can be cited', async () => {
		await chat('mallory', 'bob', 'bob-order-2');
		await fx.db.query(
			`UPDATE orders SET completed_counterparty = 'mallory' WHERE account = 'bob' AND permlink = 'bob-order-4'`
		);
		expect(await review('mallory', 'bob-order-2', H)).toEqual({ ok: true });
		expect(await review('mallory', 'bob-order-4', H)).toEqual({ ok: true });
		expect((await review('mallory', 'bob-order-3', H)).ok).toBe(false);
	});

	it('a chat about the order with SOMEONE ELSE does not count', async () => {
		await chat('carol', 'bob', 'bob-order-1');
		expect((await review('mallory', 'bob-order-1', H)).ok).toBe(false);
	});

	it('before the activation time the recorded verdicts of history are unchanged', async () => {
		expect(await review('mallory', 'bob-order-5', BEFORE)).toEqual({ ok: true });
	});
});
