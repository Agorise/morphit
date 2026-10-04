/**
 * morphit_search_orders reads the indexer's real response shape.
 *
 * `/v1/orderbook` answers `{ items, next_cursor }` (apps/indexer/src/api/
 * orderbook.ts). The tool read `rows`, a key the indexer never sends, so every
 * search an AI agent ran came back empty — found by the v1.18.0 deep audit
 * while fixing morphit_get_listing, which had the same mismatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchOrders } from '../src/tools/searchOrders';

const order = {
	account: 'alice',
	permlink: 'sell-btc-usd-1',
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	payment_methods: ['cash'],
	status: 'live'
};

describe('morphit_search_orders', () => {
	beforeEach(() => {
		process.env.MORPHIT_MCP_INSTANCE_URL = 'https://morphit.example';
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ items: [order], next_cursor: null }), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			)
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	it('returns the orders the indexer sent', async () => {
		const r = await searchOrders({ asset: 'BTC' } as Parameters<typeof searchOrders>[0]);
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0]).toMatchObject({ account: 'alice' });
	});
});
