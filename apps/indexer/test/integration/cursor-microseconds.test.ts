/**
 * Paging through the orderbook and an account's orders returns every order
 * once, even when several were updated within one millisecond, on
 * real Postgres.
 *
 * The cursor carried updated_at cut to milliseconds; the next page asked for
 * rows older than that, so orders updated later within the same millisecond
 * as a page's last row were skipped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { orderbookRoute } from '../../src/api/orderbook';
import { ordersByAccountRoute } from '../../src/api/orders';
import type { Poller } from '../../src/indexer/poller';

const poller = { getStatus: () => ({ indexedBlock: 1 }) } as unknown as Poller;

describe.skipIf(!INTEGRATION_ENABLED)('cursors keep microseconds', () => {
	let fx: IntegrationFixture;
	const ALL = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];

	beforeAll(async () => {
		fx = await setupWithMigrations();
		// Six orders updated 100 µs apart, all within one millisecond.
		for (const [i, p] of ALL.entries()) {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status)
				 VALUES ('alice', $1, 'sell', 'BTC', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
				         'live', NOW(), '2026-10-01T12:00:00.000100Z'::timestamptz + ($2 || ' microseconds')::interval,
				         'verified')`,
				[p, i * 100]
			);
		}
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	type Page = { items: { permlink: string }[]; next_cursor: string | null };
	async function walk(get: (cursor: string | null) => Promise<Page>) {
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 20; i++) {
			const page = await get(cursor);
			seen.push(...page.items.map((o) => o.permlink));
			if (page.next_cursor === null) break;
			cursor = page.next_cursor;
		}
		return seen.sort();
	}

	it('the orderbook, every sort', async () => {
		const app = orderbookRoute(fx.db, poller, 'op');
		for (const sort of ['recent', 'rating', 'trades']) {
			const seen = await walk(
				async (c) =>
					(
						await app.request(
							`/?limit=2&sort=${sort}${c ? `&cursor=${encodeURIComponent(c)}` : ''}`
						)
					).json() as Promise<Page>
			);
			expect(seen, sort).toEqual(ALL);
		}
	});

	it('an account’s orders', async () => {
		const app = ordersByAccountRoute(fx.db, 'op');
		const seen = await walk(
			async (c) =>
				(
					await app.request(`/alice?limit=2${c ? `&cursor=${encodeURIComponent(c)}` : ''}`)
				).json() as Promise<Page>
		);
		expect(seen).toEqual(ALL);
	});
});
