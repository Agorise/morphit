/**
 * completed-trade count must only count orders whose
 * listing fee was actually paid.
 *
 * rv6 A3: post an order with NO fee transfer (row lands fee_status='missing'),
 * send order_complete for it, and trade_count goes up by one — ten times for
 * ten free ops. That removes the "new trader" chip and lifts the account under
 * sort=trades, while the code comment promised "a real listing fee per fake
 * trade". Runs the real order + order_complete handlers and the real
 * TRADE_COUNT_SQL against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import orderCompleteHandler from '../../src/indexer/handlers/orderComplete';
import { TRADE_COUNT_SQL, tradeCountSql } from '../../src/api/reputationJoin';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

const NOW = new Date('2026-09-24T12:00:00Z');

function unpaidOrder(permlink: string) {
	return {
		permlink,
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'USD',
		amount_min: 100,
		amount_max: 1000,
		price_model: { kind: 'spread', percent: 0 },
		payment_methods: ['cash']
	};
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'M2 — trade_count counts only fee-verified completed orders',
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

		async function postAndComplete(signer: string, permlink: string): Promise<void> {
			await fx.db.withTx((c) =>
				orderHandler(makeCtx({ signer, blockTime: NOW, payload: unpaidOrder(permlink) }), c)
			);
			const r = await fx.db.withTx((c) =>
				orderCompleteHandler(makeCtx({ signer, blockTime: NOW, payload: { permlink } }), c)
			);
			expect(r).toEqual({ ok: true });
		}
		async function counts(): Promise<Record<string, number>> {
			const r = await fx.db.query<{ account: string; c: number }>(TRADE_COUNT_SQL);
			return Object.fromEntries(r.rows.map((x) => [x.account, x.c]));
		}

		it('ten unpaid orders completed earn no trade credit', async () => {
			for (let i = 0; i < 10; i++) await postAndComplete('mallory', `sell-nofee-${i}`);
			const fs = await fx.db.query<{ fee_status: string }>(
				`SELECT DISTINCT fee_status FROM orders`
			);
			expect(fs.rows).toEqual([{ fee_status: 'missing' }]);
			expect(await counts()).toEqual({});
		});

		it('a completed order whose fee IS verified still counts (both sides)', async () => {
			await postAndComplete('alice', 'sell-paid-1');
			await fx.db.query(
				`UPDATE orders SET fee_status = 'verified', completed_counterparty = 'bob' WHERE permlink = 'sell-paid-1'`
			);
			expect(await counts()).toEqual({ alice: 1, bob: 1 });
		});

		it('pending_external / underpaid / reused completions do not count', async () => {
			const statuses = ['pending_external', 'underpaid', 'reused'];
			for (const [i, st] of statuses.entries()) {
				await postAndComplete('mallory', `sell-x-${i}`);
				await fx.db.query(`UPDATE orders SET fee_status = $1 WHERE permlink = $2`, [
					st,
					`sell-x-${i}`
				]);
			}
			expect(await counts()).toEqual({});
		});

		it('a free first-buy waiver order credits its owner but never a named counterparty', async () => {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model,
			                     payment_methods, status, created_at, updated_at,
			                     fee_status, fee_method, completed_counterparty)
			 VALUES ('sock1', 'buy-w', 'buy', 'BLURT', 'USD', '{}'::jsonb, ARRAY['cash'],
			         'completed', $1, $1, 'verified', 'waived_first_buy', 'target')`,
				[NOW]
			);
			expect(await counts()).toEqual({ sock1: 1 });
		});

		it('the scoped variant (featured strip / receipt) applies the same filter', async () => {
			await postAndComplete('mallory', 'sell-nofee-s');
			const r = await fx.db.query<{ c: number }>(
				`SELECT COALESCE((SELECT t.c FROM (${tradeCountSql(`SELECT $1::text`)}) t), 0)::int AS c`,
				['mallory']
			);
			expect(r.rows[0]!.c).toBe(0);
		});
	}
);
