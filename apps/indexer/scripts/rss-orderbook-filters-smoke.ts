/**
 * RSS orderbook by-asset FILTER support — tsx smoke runner.
 *
 * The per-asset feed (/rss/orderbook/by-asset/<asset>.xml) accepts
 * optional order-property filters as query params so a feed can
 * mirror an orderbook search.  This smoke pins:
 *
 *   - each supported filter (side, fiat_currency, location_region,
 *     payment_methods, langs, min_trades) splices the EXPECTED WHERE
 *     clause + binds the EXPECTED params, and the whole WHERE is the one
 *     the orderbook's own builder (buildWhereClauses) produces;
 *   - the asset still binds as params[0] (rss-orderbook-smoke relies
 *     on it) and FEED_LIMIT still binds;
 *   - the BARE feed (no query) emits NONE of the filter clauses
 *     (backward compatibility with the pre-filter feed);
 *   - filters FAIL OPEN — a malformed value is dropped, never 400;
 *   - a filtered feed is self-describing (self URL carries the query
 *     string; description names the filter + uses the filtered
 *     privacy note); the bare feed does neither;
 *   - sort is NOT honored (a feed is recency-ordered).
 *
 * Row-level parity with the orderbook on real Postgres:
 * test/integration/rss-orderbook-parity.test.ts.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/rss-orderbook-filters-smoke.ts
 */

import type pg from 'pg';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { perAssetFeedHandler, globalFeedHandler } from '../src/api/rssOrderbookHandlers.ts';
import type { Database } from '../src/db/pool.ts';
import type { Config } from '../src/config/index.ts';
import { tradeCountJoin } from '$api/reputationJoin';
import { buildWhereClauses } from '$api/orderbookStreamHelpers';

/** The payment-method FILTER clause (the asset clause also unnests
 *  payment_methods, to match pay_<ticker>, so look for the filter's ANY). */
const PAYMENT_FILTER = 'lower(pm) = ANY(';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => console.log(`  ✓ ${name}`),
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function assertContains(haystack: string, needle: string, label: string): void {
	if (!haystack.includes(needle))
		throw new Error(`${label}: expected to contain ${JSON.stringify(needle)}`);
}
function assertNotContains(haystack: string, needle: string, label: string): void {
	if (haystack.includes(needle))
		throw new Error(`${label}: expected NOT to contain ${JSON.stringify(needle)}`);
}

interface MockDb {
	readonly db: Database;
	readonly queries: { text: string; params: readonly unknown[] }[];
}

function makeMockDb(rows: unknown[]): MockDb {
	const queries: { text: string; params: readonly unknown[] }[] = [];
	const db: Database = {
		query: async <R extends pg.QueryResultRow = pg.QueryResultRow>(
			text: string,
			params?: readonly unknown[]
		): Promise<pg.QueryResult<R>> => {
			queries.push({ text, params: params ?? [] });
			return { rows: rows as R[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
		},
		withTx: async () => {
			throw new Error('mock: withTx not used');
		},
		close: async () => {}
	};
	return { db, queries };
}

const FAKE_CONFIG: Config = { publicOrigin: 'https://indexer.example.com' } as Config;

console.log('\n── RSS orderbook by-asset filters ──────────────────');

// ─── Each filter splices the right clause + params ──────────────────

await scenario('side filter → o.side clause + bound param; asset still params[0]', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { side: 'buy' });
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, 'o.side =', 'side clause present');
	assertEqual(q.params[0], 'BTC', 'asset still params[0]');
	assertContains(JSON.stringify(q.params), '"buy"', 'side param bound');
});

await scenario('fiat_currency filter → ANY(...) clause + uppercased array param', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, {
		fiat_currency: 'usd,eur'
	});
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, 'o.fiat_currency = ANY(', 'fiat clause present');
	assertContains(JSON.stringify(q.params), '["USD","EUR"]', 'fiat array uppercased + bound');
});

await scenario('location_region filter → ILIKE substring + ESCAPE clause (as the orderbook)', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, {
		location_region: 'Querétaro'
	});
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, 'o.location_region ILIKE', 'region clause present');
	assertContains(q.text, 'ESCAPE', 'ESCAPE clause present');
	// NFC-normalized, '%' on both sides (escapeLike leaves plain text intact).
	assertContains(JSON.stringify(q.params), '"%Querétaro%"', 'region param is a substring match');
});

await scenario('region LIKE metacharacters are escaped (100% stays literal)', async () => {
	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { location_region: '100%' });
	const q = mock.queries[0]!;
	// escapeLike turns "100%" into "100\%"; param becomes "%100\%%".
	assertContains(JSON.stringify(q.params), '"%100\\\\%%"', 'percent escaped inside the wildcards');
});

await scenario('payment_methods filter → unnest EXISTS clause + lowercased tokens', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, {
		payment_methods: 'PayPal,Wise'
	});
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, PAYMENT_FILTER, 'payment clause present');
	assertContains(JSON.stringify(q.params), '["paypal","wise"]', 'payment tokens lowercased');
});

await scenario('combined filters all splice together', async () => {
	const mock = makeMockDb([]);
	await perAssetFeedHandler('xmr.xml', mock.db, FAKE_CONFIG, {
		side: 'sell',
		fiat_currency: 'USD',
		location_region: 'EU',
		payment_methods: 'sepa'
	});
	const q = mock.queries[0]!;
	assertEqual(q.params[0], 'XMR', 'asset still params[0]');
	assertContains(q.text, 'o.side =', 'side');
	assertContains(q.text, 'o.fiat_currency = ANY(', 'fiat');
	assertContains(q.text, 'o.location_region ILIKE', 'region');
	assertContains(q.text, PAYMENT_FILTER, 'payment');
});

// ─── Bare feed (no filters): backward compatible ────────────────────

await scenario('bare feed emits NONE of the filter clauses', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertEqual(q.params[0], 'BTC', 'asset params[0]');
	assertNotContains(q.text, 'o.side =', 'no side clause');
	assertNotContains(q.text, 'o.fiat_currency = ANY(', 'no fiat clause');
	assertNotContains(q.text, 'o.location_region ILIKE', 'no region clause');
	assertNotContains(q.text, PAYMENT_FILTER, 'no payment clause');
});

// ─── Fail-open on malformed values (never 400) ──────────────────────

await scenario('invalid side value is dropped (fail-open, still 200)', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { side: 'banana' });
	assertEqual(r.status, 200, 'status');
	assertNotContains(mock.queries[0]!.text, 'o.side =', 'bogus side dropped');
});

await scenario('over-long payment token is dropped; valid sibling kept', async () => {
	const mock = makeMockDb([]);
	const tooLong = 'x'.repeat(40);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, {
		payment_methods: `${tooLong},cash`
	});
	const params = JSON.stringify(mock.queries[0]!.params);
	assertContains(params, '["cash"]', 'valid token kept, lowercased');
	assertNotContains(params, tooLong, 'over-long token dropped');
});

await scenario('empty payment_methods value adds no clause', async () => {
	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { payment_methods: '   ' });
	assertNotContains(mock.queries[0]!.text, PAYMENT_FILTER, 'whitespace → no clause');
});

await scenario('duplicate fiat codes are deduped', async () => {
	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { fiat_currency: 'USD,usd,USD' });
	assertContains(JSON.stringify(mock.queries[0]!.params), '["USD"]', 'deduped to single USD');
});

// ─── min_trades honored (completed-trade count, as the orderbook); sort not ─

await scenario('min_trades → the orderbook trade-count join + COALESCE(tc.c) clause + bound param', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { min_trades: '5' });
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, tradeCountJoin('o'), 'the orderbook trade-count join, verbatim');
	assertContains(q.text, 'COALESCE(tc.c, 0) >= ', 'min-trades clause present');
	assertContains(JSON.stringify(q.params), '5', 'threshold bound');
	assertEqual(q.params[0], 'BTC', 'asset still params[0]');
});

await scenario('min_trades OMITTED → no trade-count join (no cost, backward compat)', async () => {
	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { side: 'buy' });
	const q = mock.queries[0]!;
	assertNotContains(q.text, 'LEFT JOIN', 'no trade-count join when min_trades absent');
	assertNotContains(q.text, 'COALESCE(tc.c', 'no min-trades clause');
});

await scenario('min_trades fail-open (0 / negative / >100 / non-numeric → no clause)', async () => {
	for (const bad of ['0', '-3', '101', 'lots', '3.5']) {
		const mock = makeMockDb([]);
		await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { min_trades: bad });
		assertNotContains(mock.queries[0]!.text, 'COALESCE(tc.c', `min_trades="${bad}" → no clause`);
	}
});

await scenario('PARITY: the feed WHERE is the orderbook builder output for the same filters', async () => {
	const cfg = { ...FAKE_CONFIG, operatorAccountName: 'op' } as Config;
	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, cfg, {
		side: 'buy',
		fiat_currency: 'usd',
		location_region: 'Pokhara',
		payment_methods: 'Cash',
		langs: 'es,xx',
		min_trades: '3'
	});
	const want = buildWhereClauses(
		{
			asset: 'BTC',
			side: 'buy',
			fiat_currency: 'USD',
			location_region: 'Pokhara',
			payment_methods: 'cash',
			langs: 'es',
			min_trades: 3
		},
		0,
		'op'
	);
	const q = mock.queries[0]!;
	assertContains(q.text, `WHERE ${want.where.join(' AND ')}`, 'same WHERE text');
	assertEqual(q.params.slice(0, want.params.length), want.params, 'same bound params');
	assertContains(q.text, "o.expires_at > NOW()", 'expired orders excluded, as on the orderbook');
});

await scenario('sort is ignored — feed stays recency-ordered', async () => {
	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { sort: 'rating' });
	const q = mock.queries[0]!;
	assertContains(q.text, 'ORDER BY o.updated_at DESC', 'still recency-ordered');
	assertNotContains(q.text, 'f.r DESC', 'no rating sort');
});

// ─── Self-describing filtered feed ──────────────────────────────────

await scenario('filtered feed self URL carries the query string', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { side: 'buy' });
	assertContains(r.body, 'by-asset/btc.xml?side=buy', 'self URL has query');
	assertContains(r.body, 'matching your selected filters', 'description names filter');
	assertContains(r.body, 'encodes your search filters', 'filtered privacy note');
});

await scenario('bare feed self URL has NO query string + global note', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG);
	assertNotContains(r.body, 'btc.xml?', 'no query in self URL');
	assertNotContains(r.body, 'matching your selected filters', 'no filter phrase');
	assertContains(r.body, 'Blurt is a public chain', 'global privacy note');
});

await scenario('filters work across all three formats (atom self URL)', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.atom', mock.db, FAKE_CONFIG, { side: 'sell' });
	assertEqual(r.headers['content-type'], 'application/atom+xml; charset=utf-8', 'atom content-type');
	assertContains(r.body, 'by-asset/btc.atom?side=sell', 'atom self URL has query');
});

// ─── Invalid asset still rejected (filters don't bypass validation) ─

await scenario('invalid asset still 400 even with filters', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('fake.xml', mock.db, FAKE_CONFIG, { side: 'buy' });
	assertEqual(r.status, 400, 'status');
	assertEqual(mock.queries.length, 0, 'no DB query for invalid asset');
});

// ─── GLOBAL (cross-asset) feed honors the same filters ──────────────
// The orderbook page surfaces an RSS pill for a side/region/experience
// search even when NO asset is chosen; it points at /rss/orderbook with
// the filter query, so globalFeedHandler must apply the same clauses the
// per-asset feed does (minus the asset predicate).

console.log('\n── RSS GLOBAL feed filters (cross-asset) ───────────');

await scenario('global bare feed → no filter clauses, no asset clause, no query in self URL', async () => {
	const mock = makeMockDb([]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG, 'rss');
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertNotContains(q.text, 'o.side =', 'no side clause when bare');
	// The asset FILTER binds the ticker as a param → `o.asset = $N`. We check
	// that exact shape rather than the bare `o.asset =` substring, because the
	// crypto-facing side clause now legitimately contains the LITERAL
	// `o.asset = 'BARTER'` (the barter-flip branch), which is not an asset filter
	// (cryptoFacingSideWhere).
	assertNotContains(q.text, 'o.asset = $', 'global feed has NO asset filter clause');
	assertNotContains(r.body, 'orderbook.xml?', 'no query in self URL');
	assertNotContains(r.body, 'matching your selected filters', 'no filter phrase');
	assertContains(r.body, 'Blurt is a public chain', 'global privacy note');
});

await scenario('global side filter → o.side clause + bound param, still no asset clause', async () => {
	const mock = makeMockDb([]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG, 'rss', { side: 'buy' });
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, 'o.side =', 'side clause present');
	// `o.asset = $N` = asset FILTER; the literal `o.asset = 'BARTER'` inside the
	// side clause is the barter-flip branch, not an asset filter (see above).
	assertNotContains(q.text, 'o.asset = $', 'no asset filter clause');
	assertContains(JSON.stringify(q.params), '"buy"', 'side param bound');
});

await scenario('global fiat+region filters → clauses + filtered self URL + filtered note', async () => {
	const mock = makeMockDb([]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG, 'rss', {
		fiat_currency: 'usd,eur',
		location_region: 'Berlin'
	});
	const q = mock.queries[0]!;
	assertContains(q.text, 'o.fiat_currency = ANY(', 'fiat clause present');
	assertContains(q.text, 'o.location_region ILIKE', 'region clause present');
	assertContains(JSON.stringify(q.params), '["USD","EUR"]', 'fiat array uppercased + bound');
	assertContains(r.body, 'orderbook.xml?', 'filtered self URL carries query');
	assertContains(r.body, 'matching your selected filters', 'filtered phrase present');
});

await scenario('global min_trades → the orderbook trade-count join', async () => {
	const mock = makeMockDb([]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG, 'rss', { min_trades: '5' });
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, tradeCountJoin('o'), 'trade-count join present');
	assertContains(q.text, 'COALESCE(tc.c, 0) >=', 'min_trades threshold clause');
});

await scenario('global sort param ignored (recency order, not a feed filter)', async () => {
	const mock = makeMockDb([]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG, 'rss', { sort: 'rating' });
	const q = mock.queries[0]!;
	assertContains(q.text, 'ORDER BY o.updated_at DESC', 'recency order');
	assertNotContains(r.body, 'orderbook.xml?', 'sort produces no query in self URL');
});

console.log('');
if (failures === 0) {
	console.log('──────────────────────────────────────────────────────');
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log('──────────────────────────────────────────────────────');
	console.log(`✗ ${failures} of ${scenarios} scenarios failed`);
	process.exit(1);
}
