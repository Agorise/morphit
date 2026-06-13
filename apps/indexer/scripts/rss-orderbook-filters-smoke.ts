/**
 * RSS orderbook by-asset FILTER support — tsx smoke runner.
 *
 * The per-asset feed (/rss/orderbook/by-asset/<asset>.xml) accepts
 * optional order-property filters as query params so a feed can
 * mirror an orderbook search.  This smoke pins:
 *
 *   - each supported filter (side, fiat_currency, location_region,
 *     payment_methods) splices the EXPECTED WHERE clause + binds the
 *     EXPECTED params, byte-matching the live orderbook (orderbook.ts);
 *   - the asset still binds as params[0] (rss-orderbook-smoke relies
 *     on it) and FEED_LIMIT still binds;
 *   - the BARE feed (no query) emits NONE of the filter clauses
 *     (backward compatibility with the pre-filter feed);
 *   - filters FAIL OPEN — a malformed value is dropped, never 400;
 *   - a filtered feed is self-describing (self URL carries the query
 *     string; description names the filter + uses the filtered
 *     privacy note); the bare feed does neither;
 *   - min_trades + sort are NOT honored (deliberately omitted).
 *
 * Usage (from apps/indexer):
 *   tsx scripts/rss-orderbook-filters-smoke.ts
 */

import type pg from 'pg';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { perAssetFeedHandler } from '../src/api/rssOrderbookHandlers.ts';
import type { Database } from '../src/db/pool.ts';
import type { Config } from '../src/config/index.ts';

/** Sock-puppet NOT-EXISTS table set referenced in a feedback aggregate.
 *  Used to assert the feed's min_trades count and the orderbook's use
 *  the identical exclusion set. */
function exclusionTables(sql: string): string[] {
	const re = /NOT EXISTS\s*\(\s*SELECT 1 FROM (\w+)/g;
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(sql)) !== null) out.push(m[1]!);
	return [...new Set(out)].sort();
}

/** Isolate just the feedback-aggregate body (`FROM feedback fb` …
 *  `GROUP BY subject`) so the table extraction sees ONLY the
 *  reputation exclusions, not unrelated NOT-EXISTS clauses elsewhere in
 *  the query (e.g. the operator_blocks guard in the outer WHERE). */
function feedbackBlock(sql: string): string {
	const s = sql.indexOf('FROM feedback fb');
	const e = sql.indexOf('GROUP BY subject', s);
	if (s < 0 || e < 0) throw new Error('could not locate feedback aggregate body');
	return sql.slice(s, e);
}

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

await scenario('location_region filter → ILIKE prefix + ESCAPE clause', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, {
		location_region: 'Querétaro'
	});
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, 'o.location_region ILIKE', 'region clause present');
	assertContains(q.text, 'ESCAPE', 'ESCAPE clause present');
	// NFC-normalized + prefix '%' appended (escapeLike leaves plain text intact).
	assertContains(JSON.stringify(q.params), 'Querétaro%', 'region param prefixed');
});

await scenario('region LIKE metacharacters are escaped (100% stays literal)', async () => {
	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { location_region: '100%' });
	const q = mock.queries[0]!;
	// escapeLike turns "100%" into "100\%"; param becomes "100\%%".
	assertContains(JSON.stringify(q.params), '100\\\\%%', 'percent escaped before prefix');
});

await scenario('payment_methods filter → unnest EXISTS clause + lowercased tokens', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, {
		payment_methods: 'PayPal,Wise'
	});
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, 'unnest(o.payment_methods)', 'payment clause present');
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
	assertContains(q.text, 'unnest(o.payment_methods)', 'payment');
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
	assertNotContains(q.text, 'unnest(o.payment_methods)', 'no payment clause');
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
	assertNotContains(mock.queries[0]!.text, 'unnest(o.payment_methods)', 'whitespace → no clause');
});

await scenario('duplicate fiat codes are deduped', async () => {
	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { fiat_currency: 'USD,usd,USD' });
	assertContains(JSON.stringify(mock.queries[0]!.params), '["USD"]', 'deduped to single USD');
});

// ─── min_trades honored (feedback-count aggregate); sort not ────────

await scenario('min_trades → feedback-count join + COALESCE clause + bound param', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { min_trades: '5' });
	assertEqual(r.status, 200, 'status');
	const q = mock.queries[0]!;
	assertContains(q.text, 'LEFT JOIN', 'feedback-count join present');
	assertContains(q.text, 'COUNT(*)::int AS c', 'count aggregate present');
	assertContains(q.text, 'COALESCE(f.c, 0) >= ', 'min-trades clause present');
	assertContains(JSON.stringify(q.params), '5', 'threshold bound');
	assertEqual(q.params[0], 'BTC', 'asset still params[0]');
});

await scenario('min_trades OMITTED → no feedback join (no cost, backward compat)', async () => {
	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { side: 'buy' });
	const q = mock.queries[0]!;
	assertNotContains(q.text, 'LEFT JOIN', 'no feedback join when min_trades absent');
	assertNotContains(q.text, 'COALESCE(f.c', 'no min-trades clause');
});

await scenario('min_trades fail-open (0 / negative / >100 / non-numeric → no clause)', async () => {
	for (const bad of ['0', '-3', '101', 'lots', '3.5']) {
		const mock = makeMockDb([]);
		await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { min_trades: bad });
		assertNotContains(mock.queries[0]!.text, 'COALESCE(f.c', `min_trades="${bad}" → no clause`);
	}
});

await scenario('PARITY: feed min_trades uses the SAME exclusion tables as orderbook.ts', async () => {
	// Extract the sock-puppet NOT-EXISTS table set from orderbook.ts's
	// `f` aggregate and from the feed's generated min_trades SQL; they
	// MUST match, or the feed's reputation count would disagree with the
	// orderbook's (a trader hidden by one could leak into the other).
	const obSrc = readFileSync(
		join(import.meta.dirname, '..', 'src', 'api', 'orderbook.ts'),
		'utf-8'
	);
	const obTables = exclusionTables(feedbackBlock(obSrc));
	if (obTables.length === 0) throw new Error('extracted no exclusion tables from orderbook.ts');

	const mock = makeMockDb([]);
	await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG, { min_trades: '5' });
	const feedTables = exclusionTables(feedbackBlock(mock.queries[0]!.text));

	assertEqual(feedTables, obTables, 'feed exclusion tables == orderbook exclusion tables');
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
