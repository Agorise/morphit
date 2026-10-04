/**
 * One reviewer's opinion of a trader counts once (aggregate part), on
 * real Postgres: the profile summary, the orderbook card, the verifiable
 * receipt and the review list agree.
 *
 * A review must cite a fee-paid order of either party, and the unique key is
 * (reviewer, subject, order), so one counterparty could file a 1★ review per
 * order the victim ever posted: six of them took a 5.00 rating to 2.82.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { feedbackByAccountRoute } from '../../src/api/feedback';
import { reputationReceiptRoute } from '../../src/api/reputationReceipt';
import { orderbookRoute } from '../../src/api/orderbook';
import type { Poller } from '../../src/indexer/poller';

const poller = { getStatus: () => ({ indexedBlock: 1 }) } as unknown as Poller;

describe.skipIf(!INTEGRATION_ENABLED)('one review per (reviewer, subject)', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		await fx.db.query(`
			INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                    status, created_at, updated_at, fee_status)
			SELECT 'alice', 'deal' || g, 'sell', 'BTC', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
			       'live', NOW() - (g || ' days')::interval, NOW() - (g || ' days')::interval, 'verified'
			  FROM generate_series(1, 6) g`);
		const review = (reviewer: string, rating: number, permlink: string, hoursAgo: number) =>
			fx.db.query(
				`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
				 VALUES ($1, 'alice', $2, $3, NOW() - ($4 || ' hours')::interval, md5($1 || $3))`,
				[reviewer, rating, permlink, hoursAgo]
			);
		await review('carol', 5, 'deal1', 50);
		// mallory: one 1★ per order alice ever posted, then a final 2★.
		for (let g = 1; g <= 5; g++) await review('mallory', 1, `deal${g}`, 40 - g);
		await review('mallory', 2, 'deal6', 1);
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	it("the profile counts carol once and mallory once — mallory's latest", async () => {
		const res = await feedbackByAccountRoute(fx.db).request('/alice/feedback');
		const body = (await res.json()) as {
			summary: { count: number | string; by_rating: Record<string, number | string> };
			items: { reviewer: string; rating: number; suppressed: boolean }[];
		};
		expect(Number(body.summary.count)).toBe(2);
		const kept = body.items.filter((i) => !i.suppressed).map((i) => `${i.reviewer}:${i.rating}`);
		expect(kept.sort()).toEqual(['carol:5', 'mallory:2']);
	});

	it('the orderbook card and the receipt agree', async () => {
		const ob = await orderbookRoute(fx.db, poller, 'op').request('/');
		const card = (
			(await ob.json()) as { items: { account: string; feedback_count: number }[] }
		).items.find((i) => i.account === 'alice')!;
		expect(card.feedback_count).toBe(2);
		const rec = await reputationReceiptRoute(fx.db).request('/alice/reputation-receipt');
		const receipt = (await rec.json()) as { summary: { count_included: number } };
		expect(receipt.summary.count_included).toBe(2);
	});
});
