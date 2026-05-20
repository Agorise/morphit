/**
 * RSS orderbook handlers — tsx smoke runner.
 *
 * Tests the three plain async feed handlers (no Hono needed)
 * exported by src/api/rssOrderbook.ts. The Hono route is a
 * thin wrapper over these, so the routing surface that matters
 * (URL-segment validation, XML escaping, query parameter
 * passing, empty-result handling) is fully exercised here.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/rss-orderbook-smoke.ts
 */

import type pg from 'pg';

import {
	globalFeedHandler,
	perAssetFeedHandler,
	perAccountFeedHandler
} from '../src/api/rssOrderbookHandlers.ts';
import type { Database } from '../src/db/pool.ts';
import type { Config } from '../src/config/index.ts';

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
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

function assertContains(haystack: string, needle: string, label: string): void {
	if (!haystack.includes(needle)) {
		throw new Error(`${label}: expected to contain ${JSON.stringify(needle)}`);
	}
}

function assertNotContains(haystack: string, needle: string, label: string): void {
	if (haystack.includes(needle)) {
		throw new Error(`${label}: expected NOT to contain ${JSON.stringify(needle)}`);
	}
}

interface MockDb {
	readonly db: Database;
	readonly queries: { text: string; params: readonly unknown[] }[];
}

function makeMockDb(rowsByMatch: { match: string; rows: unknown[] }[]): MockDb {
	const queries: { text: string; params: readonly unknown[] }[] = [];

	const db: Database = {
		query: async <R extends pg.QueryResultRow = pg.QueryResultRow>(
			text: string,
			params?: readonly unknown[]
		): Promise<pg.QueryResult<R>> => {
			queries.push({ text, params: params ?? [] });
			for (const r of rowsByMatch) {
				if (text.includes(r.match)) {
					return {
						rows: r.rows as R[],
						rowCount: r.rows.length,
						command: 'SELECT',
						oid: 0,
						fields: []
					};
				}
			}
			return {
				rows: [],
				rowCount: 0,
				command: 'SELECT',
				oid: 0,
				fields: []
			};
		},
		withTx: async () => {
			throw new Error('mock: withTx not used by RSS routes');
		},
		close: async () => {}
	};

	return { db, queries };
}

const FAKE_CONFIG: Config = {
	publicOrigin: 'https://indexer.example.com'
} as Config;

const SAMPLE_ROW = {
	account: 'alice',
	permlink: 'sell-btc-eur-12345',
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'EUR',
	amount_min: '100',
	amount_max: '500',
	location_region: 'EU',
	payment_methods: ['SEPA', 'Revolut'],
	fee_method: 'BLURT',
	created_at: new Date('2026-04-20T12:00:00Z'),
	updated_at: new Date('2026-04-20T13:00:00Z')
};

console.log('\n── RSS orderbook handlers ──────────────────────────');

// ─── Global feed ────────────────────────────────────────────

await scenario('global feed returns 200 with well-formed RSS', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [SAMPLE_ROW] }]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status');
	assertEqual(r.headers['content-type'], 'application/rss+xml; charset=utf-8', 'content-type');
	assertContains(r.body, '<?xml version="1.0" encoding="UTF-8"?>', 'xml prolog');
	assertContains(r.body, '<rss version="2.0"', 'rss root');
	assertContains(r.body, '<title>Morphit — New orderbook entries</title>', 'channel title');
	assertContains(r.body, '<title>Sell BTC for EUR · EU</title>', 'item title');
	assertContains(r.body, 'morphit:order:alice:sell-btc-eur-12345', 'guid');
});

await scenario('global feed sets Cache-Control', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [SAMPLE_ROW] }]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG);
	assertEqual(r.headers['cache-control'], 'public, max-age=60', 'cache-control');
});

await scenario('global feed handles empty result with lastBuildDate=now', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [] }]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status');
	assertContains(r.body, '<channel>', 'channel');
	assertContains(r.body, '<lastBuildDate>', 'has lastBuildDate');
	assertNotContains(r.body, '<item>', 'no items');
});

await scenario('global feed item description has expected fields', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [SAMPLE_ROW] }]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG);
	assertContains(r.body, 'Selling BTC for EUR', 'description side+asset');
	assertContains(r.body, 'Amount: 100 – 500 EUR', 'amount range');
	assertContains(r.body, 'Payment: SEPA, Revolut', 'payment methods');
	assertContains(r.body, 'Posted by @alice', 'attribution');
});

// ─── Per-asset feed ─────────────────────────────────────────

await scenario('per-asset feed accepts btc.xml and queries with BTC', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [SAMPLE_ROW] }]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status');
	assertContains(r.body, 'Morphit — New BTC orderbook entries', 'channel title');
	if (mock.queries.length === 0 || mock.queries[0]!.params[0] !== 'BTC') {
		throw new Error(`expected first param 'BTC', got ${JSON.stringify(mock.queries[0]?.params)}`);
	}
});

await scenario('per-asset feed accepts xmr.xml and queries with XMR', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [] }]);
	const r = await perAssetFeedHandler('xmr.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status');
	if (mock.queries[0]!.params[0] !== 'XMR') {
		throw new Error(`expected XMR, got ${mock.queries[0]?.params[0]}`);
	}
});

await scenario('per-asset feed accepts blurt.xml and queries with BLURT', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [] }]);
	const r = await perAssetFeedHandler('blurt.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status');
	if (mock.queries[0]!.params[0] !== 'BLURT') {
		throw new Error(`expected BLURT, got ${mock.queries[0]?.params[0]}`);
	}
});

await scenario('per-asset feed rejects unknown asset with 400', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('fake.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 400, 'status');
	assertEqual(mock.queries.length, 0, 'no DB query for invalid asset');
});

await scenario('per-asset feed rejects uppercase asset (URL convention is lowercase)', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('BTC.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 400, 'status');
});

await scenario('per-asset feed rejects missing .xml extension', async () => {
	const mock = makeMockDb([]);
	const r = await perAssetFeedHandler('btc', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 400, 'status');
});

await scenario('per-asset feed self-URL points back at itself', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [] }]);
	const r = await perAssetFeedHandler('btc.xml', mock.db, FAKE_CONFIG);
	assertContains(
		r.body,
		'href="https://indexer.example.com/rss/orderbook/by-asset/btc.xml"',
		'atom self link'
	);
});

// ─── Per-account feed ───────────────────────────────────────

await scenario('per-account feed accepts @alice.xml and queries with alice', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [SAMPLE_ROW] }]);
	const r = await perAccountFeedHandler('@alice.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status');
	assertContains(r.body, 'Morphit — Orders by @alice', 'channel title');
	assertContains(r.body, 'polling a per-trader URL reveals', 'privacy note');
	if (mock.queries[0]!.params[0] !== 'alice') {
		throw new Error(`expected alice, got ${mock.queries[0]?.params[0]}`);
	}
});

await scenario('per-account feed accepts bare alice.xml (no @) — lenient', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [] }]);
	const r = await perAccountFeedHandler('alice.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status');
	if (mock.queries[0]!.params[0] !== 'alice') {
		throw new Error(`expected alice, got ${mock.queries[0]?.params[0]}`);
	}
});

await scenario('per-account feed lowercases account before validation', async () => {
	const mock = makeMockDb([{ match: 'FROM orders', rows: [] }]);
	const r = await perAccountFeedHandler('@Alice.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status');
	if (mock.queries[0]!.params[0] !== 'alice') {
		throw new Error(`expected alice, got ${mock.queries[0]?.params[0]}`);
	}
});

await scenario('per-account feed rejects too-short account', async () => {
	const mock = makeMockDb([]);
	const r = await perAccountFeedHandler('@ab.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 400, 'status');
	assertEqual(mock.queries.length, 0, 'no DB query');
});

await scenario('per-account feed rejects invalid characters', async () => {
	const mock = makeMockDb([]);
	const r = await perAccountFeedHandler('@alice_bob.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 400, 'status');
});

await scenario('per-account feed returns empty feed for nonexistent account (no 404)', async () => {
	// Critical privacy property: identical response to "no orders by alice"
	// and "alice doesn't exist." We don't act as an account-existence oracle.
	const mock = makeMockDb([{ match: 'FROM orders', rows: [] }]);
	const r = await perAccountFeedHandler('@nobody.xml', mock.db, FAKE_CONFIG);
	assertEqual(r.status, 200, 'status — must NOT 404');
	assertContains(r.body, '<channel>', 'has channel');
	assertNotContains(r.body, '<item>', 'no items');
});

// ─── XML escaping defense-in-depth ──────────────────────────

await scenario('hostile row data is escaped, not emitted raw', async () => {
	const hostile = {
		...SAMPLE_ROW,
		account: 'a<script>alert(1)</script>',
		fiat_currency: 'X&Y'
	};
	const mock = makeMockDb([{ match: 'FROM orders', rows: [hostile] }]);
	const r = await globalFeedHandler(mock.db, FAKE_CONFIG);
	assertNotContains(r.body, '<script>alert', 'raw script tag');
	assertContains(r.body, '&lt;script&gt;alert', 'script escaped');
	assertContains(r.body, 'X&amp;Y', 'ampersand escaped');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
