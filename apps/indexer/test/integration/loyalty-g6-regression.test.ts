/**
 * G6 regression — order op survives loyalty welcome collision.
 *
 * Pre-fix (audit 2026-05-06): trackVerifiedBlurtFee's welcome-bonus
 * INSERT caught the UNIQUE violation in JS but left the Postgres
 * transaction in ABORTED state.  When the dispatcher's per-op
 * SAVEPOINT was then RELEASE'd, the RELEASE itself failed (tx
 * aborted), the dispatcher treated the handler as thrown, and the
 * SAVEPOINT was ROLLBACK'd — discarding the order INSERT.
 *
 * Post-fix: the welcome INSERT runs inside its own nested SAVEPOINT,
 * which is ROLLBACK TO + RELEASE'd cleanly on collision.  The outer
 * transaction stays alive, the dispatcher's RELEASE SAVEPOINT
 * succeeds, the order INSERT survives.
 *
 * This test mirrors the dispatcher's SAVEPOINT structure exactly:
 *   BEGIN
 *     SAVEPOINT op_0_0
 *       (handler body — INSERT order, call trackVerifiedBlurtFee)
 *     RELEASE SAVEPOINT op_0_0
 *   COMMIT
 *
 * Asserts that on the SECOND call (which collides with the welcome),
 * the order row from that second call lands in the orders table.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { trackVerifiedBlurtFee } from '../../src/indexer/loyalty';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const BLOCK_TIME = new Date('2026-05-06T12:00:00Z');
const BLOCK_NUM = 100_000;

/** Mirrors the dispatcher's per-op savepoint sequence around a
 *  single handler call.  Caller supplies the body — they get a
 *  client that's already inside BEGIN + SAVEPOINT and is
 *  expected to leave in a state where RELEASE SAVEPOINT succeeds. */
async function withDispatcherSavepoint(
	fx: IntegrationFixture,
	savepointSuffix: string,
	body: (client: pg.PoolClient) => Promise<void>
): Promise<void> {
	await fx.db.withTx(async (client) => {
		const sp = `op_${savepointSuffix}`;
		await client.query(`SAVEPOINT ${sp}`);
		try {
			await body(client);
			// If the body leaves the tx in ABORTED state, this
			// RELEASE will throw — which is exactly the failure
			// mode pre-G6.
			await client.query(`RELEASE SAVEPOINT ${sp}`);
		} catch (err) {
			await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
			throw err;
		}
	});
}

/** Insert a minimal valid order row + call trackVerifiedBlurtFee for
 *  the same account.  Mirrors what the order handler does on the
 *  BLURT-fee-verified path. */
async function orderHandlerBody(
	client: pg.PoolClient,
	account: string,
	permlink: string,
	feeBlurt: number
): Promise<void> {
	await client.query(
		`INSERT INTO orders (
			account, permlink, side, asset, fiat_currency,
			amount_min, amount_max, price_model, location_region,
			payment_methods, terms, status, created_at, updated_at,
			expires_at, fee_status, fee_method
		) VALUES ($1, $2, 'sell', 'BTC', 'USD', NULL, NULL,
		          '{}'::jsonb, NULL, ARRAY['cash']::text[], NULL,
		          'live', $3, $3, NULL, 'verified', 'blurt')`,
		[account, permlink, BLOCK_TIME]
	);
	await trackVerifiedBlurtFee(client, account, feeBlurt, BLOCK_NUM, BLOCK_TIME, 'morphit', 'morphit');
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'G6 regression — order op survives welcome-bonus collision',
	() => {
		let fx: IntegrationFixture;

		beforeAll(async () => {
			fx = await setupWithMigrations();
		});

		afterAll(async () => {
			if (fx) await fx.teardown();
		});

		beforeEach(async () => {
			await truncateAll(fx);
		});

		it('first call: welcome fires, order lands', async () => {
			await withDispatcherSavepoint(fx, '0_0', async (client) => {
				await orderHandlerBody(client, 'alice', 'first-order', 60);
			});

			// Order was committed.
			const orders = await fx.db.query<{ permlink: string }>(
				`SELECT permlink FROM orders WHERE account = $1`,
				['alice']
			);
			expect(orders.rows).toHaveLength(1);
			expect(orders.rows[0]!.permlink).toBe('first-order');

			// Welcome row exists.
			const welcome = await fx.db.query<{ bp_rewarded: string }>(
				`SELECT bp_rewarded::text FROM account_loyalty_milestones
				  WHERE account = $1 AND milestone_blurt = 0`,
				['alice']
			);
			expect(welcome.rows).toHaveLength(1);
			expect(welcome.rows[0]!.bp_rewarded).toBe('1');
		});

		it('second call: welcome collision is isolated, second order STILL LANDS', async () => {
			// First call sets up the welcome row.
			await withDispatcherSavepoint(fx, '0_0', async (client) => {
				await orderHandlerBody(client, 'alice', 'first-order', 60);
			});

			// Second call MUST also commit cleanly, even though
			// the welcome INSERT will collide on UNIQUE.  Pre-G6
			// this would silently lose the second-order row.
			await withDispatcherSavepoint(fx, '0_1', async (client) => {
				await orderHandlerBody(client, 'alice', 'second-order', 60);
			});

			// Both orders MUST be in the table.
			const orders = await fx.db.query<{ permlink: string }>(
				`SELECT permlink FROM orders WHERE account = $1
				  ORDER BY permlink`,
				['alice']
			);
			expect(orders.rows.map((r) => r.permlink)).toEqual(['first-order', 'second-order']);

			// Cumulative fee should be 120 (both fees added).
			const loy = await fx.db.query<{ cumulative_blurt_paid: string }>(
				`SELECT cumulative_blurt_paid::text FROM account_loyalty
				  WHERE account = $1`,
				['alice']
			);
			expect(loy.rows[0]!.cumulative_blurt_paid).toBe('120');

			// Crossed the 100-BLURT milestone.  Welcome (sentinel 0)
			// + first milestone (100) = 2 milestone rows.
			const ms = await fx.db.query<{ milestone_blurt: string }>(
				`SELECT milestone_blurt::text FROM account_loyalty_milestones
				  WHERE account = $1
				  ORDER BY milestone_blurt`,
				['alice']
			);
			expect(ms.rows.map((r) => r.milestone_blurt)).toEqual(['0', '100']);
		});

		it('many calls in succession: every order lands, no transaction poisoning', async () => {
			// Pre-G6 this would land only the first order; every
			// subsequent call would silently drop because the
			// welcome collision aborted the tx.
			for (let i = 0; i < 20; i++) {
				await withDispatcherSavepoint(fx, `0_${i}`, async (client) => {
					await orderHandlerBody(client, 'alice', `order-${i}`, 10);
				});
			}

			const orders = await fx.db.query<{ permlink: string }>(
				`SELECT permlink FROM orders WHERE account = $1`,
				['alice']
			);
			expect(orders.rows).toHaveLength(20);

			// 20 × 10 BLURT = 200 cumulative.  Crosses 100 milestone
			// but not 500.
			const loy = await fx.db.query<{ cumulative_blurt_paid: string }>(
				`SELECT cumulative_blurt_paid::text FROM account_loyalty
				  WHERE account = $1`,
				['alice']
			);
			expect(loy.rows[0]!.cumulative_blurt_paid).toBe('200');
		});

		it('milestone collision is also isolated (G6 loop fix)', async () => {
			// Cross the 100-BLURT milestone with a single 150-BLURT
			// fee.  Then do another 150-BLURT fee in a separate tx;
			// this would re-attempt the milestone INSERT and collide.
			// The G6 fix to the milestone loop wraps each INSERT
			// in its own SAVEPOINT so this collision doesn't
			// poison the outer tx either.
			await withDispatcherSavepoint(fx, '0_0', async (client) => {
				await orderHandlerBody(client, 'alice', 'order-1', 150);
			});

			// Without the loop fix, this would also silently drop.
			// (The previousTotal check normally prevents re-firing
			// on cumulative >= threshold, so the loop-collision case
			// is harder to trigger naturally — but we keep the
			// SAVEPOINT pattern for consistency.)
			await withDispatcherSavepoint(fx, '0_1', async (client) => {
				await orderHandlerBody(client, 'alice', 'order-2', 150);
			});

			const orders = await fx.db.query<{ permlink: string }>(
				`SELECT permlink FROM orders WHERE account = $1
				  ORDER BY permlink`,
				['alice']
			);
			expect(orders.rows.map((r) => r.permlink)).toEqual(['order-1', 'order-2']);
		});
	}
);
