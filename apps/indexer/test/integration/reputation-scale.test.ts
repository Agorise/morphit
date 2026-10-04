/**
 * The orderbook stays fast with 50,000 reviews, and the rating it shows is the
 * one the verifiable receipt re-derives in JavaScript, on real Postgres.
 *
 * Every orderbook page aggregated the whole feedback table with NUMERIC POWER
 * for the time decay — about 20 µs a call, twice per review — so 50,000
 * reviews cost over a second per request before anything else ran.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { orderbookRoute } from '../../src/api/orderbook';
import { reputationReceiptRoute } from '../../src/api/reputationReceipt';
import type { Poller } from '../../src/indexer/poller';

const poller = { getStatus: () => ({ indexedBlock: 1 }) } as unknown as Poller;

describe.skipIf(!INTEGRATION_ENABLED)('reputation at 50,000 reviews', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		await fx.db.query(`
			INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                    status, created_at, updated_at, fee_status)
			SELECT 'acct' || (g % 2000), 'live' || g, 'sell', 'BTC', 'USD', '{"kind":"fixed","price":1}'::jsonb,
			       ARRAY['cash'], 'live', NOW() - (g || ' minutes')::interval, NOW() - (g || ' minutes')::interval,
			       'verified'
			  FROM generate_series(1, 3000) g`);
		await fx.db.query(`
			INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                    status, created_at, updated_at, fee_status, completed_counterparty)
			SELECT 'acct' || (g % 5000), 'done' || g, 'sell', 'BTC', 'USD', '{"kind":"fixed","price":1}'::jsonb,
			       ARRAY['cash'], 'completed', NOW(), NOW(), 'verified', 'acct' || ((g * 7) % 5000)
			  FROM generate_series(1, 20000) g`);
		await fx.db.query(`
			INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
			SELECT 'acct' || ((g * 13) % 5000), 'acct' || (g % 5000), 1 + (g % 5), 'done' || g,
			       NOW() - ((g % 700) || ' days')::interval, md5(g::text)
			  FROM generate_series(1, 50000) g`);
		await fx.db.query(`
			INSERT INTO suspicious_reciprocity (account_a, account_b, mutual_review_count, avg_rating)
			SELECT LEAST('acct' || g, 'acct' || (g + 1000)), GREATEST('acct' || g, 'acct' || (g + 1000)), 3, 5
			  FROM generate_series(1, 300) g`);
		await fx.db.query('ANALYZE');
	}, 120_000);

	afterAll(async () => {
		await fx?.teardown();
	});

	const page = async (): Promise<{
		ms: number;
		items: { account: string; weighted_rating: string | null }[];
	}> => {
		const t = performance.now();
		const res = await orderbookRoute(fx.db, poller, 'morphit').request('/?sort=rating');
		const body = (await res.json()) as {
			items: { account: string; weighted_rating: string | null }[];
		};
		return { ms: performance.now() - t, items: body.items };
	};

	it('an orderbook page takes well under a second', async () => {
		await page();
		const times: number[] = [];
		for (let i = 0; i < 3; i++) times.push((await page()).ms);
		times.sort((a, b) => a - b);
		expect(times[1], `median ${times[1]!.toFixed(0)} ms`).toBeLessThan(600);
	}, 60_000);

	it('the rating shown is the one the receipt re-derives in JavaScript', async () => {
		const { items } = await page();
		const cards = items.filter((i) => i.weighted_rating !== null).slice(0, 5);
		expect(cards.length).toBeGreaterThan(0);
		for (const card of cards) {
			const res = await reputationReceiptRoute(fx.db).request(
				`/${card.account}/reputation-receipt`
			);
			const receipt = (await res.json()) as { summary: { weighted_rating: number | null } };
			expect(Number(card.weighted_rating), card.account).toBeCloseTo(
				receipt.summary.weighted_rating!,
				2
			);
		}
	}, 60_000);
});
