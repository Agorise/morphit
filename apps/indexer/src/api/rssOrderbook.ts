/**
 * Morphit indexer — /rss/orderbook* endpoints.
 *
 * Thin Hono adapter over the three feed handlers in
 * rssOrderbookHandlers.ts (split out so smoke tests can
 * import the handlers without a Hono dep).
 *
 * Three RSS 2.0 feeds of live, fee-verified orders:
 *
 *   /rss/orderbook.xml
 *     The original global feed. 50 most recent orders.
 *
 *   /rss/orderbook/by-asset/<asset>.xml
 *     Same shape, filtered to a single asset
 *     (BTC | XMR | BLURT | USDT | USDC | DAI | BCH | LTC | DASH
 *     | DOGE | ZEC | ARRR | DCR | SOL). Lets a subscriber follow only the trades they
 *     care about. The set of valid URLs is fixed and
 *     enumerable — fourteen of them. A subscriber polling
 *     /rss/orderbook/by-asset/btc.xml reveals "I care about
 *     BTC" and nothing more granular than that.
 *
 *   /rss/orderbook/by-account/@<account>.xml
 *     Filtered to a single trader's orders. Lets a subscriber
 *     follow a "favorite trader" they trust. PRIVACY-AWARE
 *     because one URL maps to one identified subject of
 *     interest: the polling pattern reveals "I'm watching
 *     @alice." Documented in the channel description and the
 *     FAQ. Subscribers concerned about timing correlation
 *     should poll over Tor — same advice the global feed
 *     already gives.
 *
 * Shared design choices:
 *   - Fixed limit of 50 entries. No `?limit=` — fixed cap
 *     keeps cache behaviour predictable and removes one more
 *     way for an observer to fingerprint a subscriber.
 *   - Item content is strictly a subset of /v1/orderbook.
 *   - Cache-Control max-age=60s.
 *   - Empty result → 200 with a valid empty feed (so the
 *     endpoint isn't an account-existence oracle).
 *   - Account names validated with the standard regex; assets
 *     validated against a fixed whitelist. Invalid → 400.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import type { Config } from '$config/index';
import {
	globalFeedHandler,
	perAssetFeedHandler,
	perAccountFeedHandler,
	type HandlerResult
} from '$api/rssOrderbookHandlers';

/** Apply a HandlerResult to a Hono context. */
function applyResult(
	c: {
		status: (n: number) => void;
		header: (k: string, v: string) => void;
		body: (s: string) => Response;
	},
	r: HandlerResult
): Response {
	c.status(r.status);
	// Object.entries widens Record<string,string> values to
	// unknown in strict mode (a known TS pessimism — Records
	// can theoretically hold keys outside the declared shape).
	// The runtime value is always a string here because we
	// control the HandlerResult producer, so narrow explicitly.
	for (const [k, v] of Object.entries(r.headers) as [string, string][]) {
		c.header(k, v);
	}
	return c.body(r.body);
}

export function rssOrderbookRoute(db: Database, config: Config): Hono {
	const app = new Hono();

	app.get('/orderbook.xml', async (c) => {
		const r = await globalFeedHandler(db, config);
		return applyResult(c as never, r);
	});

	app.get('/orderbook/by-asset/:asset', async (c) => {
		const r = await perAssetFeedHandler(c.req.param('asset'), db, config);
		return applyResult(c as never, r);
	});

	app.get('/orderbook/by-account/:account', async (c) => {
		const r = await perAccountFeedHandler(c.req.param('account'), db, config);
		return applyResult(c as never, r);
	});

	return app;
}
