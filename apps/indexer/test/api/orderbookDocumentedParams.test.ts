/**
 * Every query parameter docs/API.md documents for GET /v1/orderbook is one the
 * route reads.
 *
 * The route's schema silently dropped unknown keys, and API.md documented two
 * it did not have: `asset_network` (so a USDT-on-TRC20 search also returned
 * ERC-20 offers — a wrong-chain send loses the funds) and `payment_method`. A
 * parameter the route reads refuses a malformed value; one it drops answers
 * 200 with the unfiltered book. That difference is what this checks, for every
 * row of the documented table.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

import { orderbookRoute } from '$api/orderbook';
import type { Database } from '$db/pool';
import type { Poller } from '$indexer/poller';

const API_MD = readFileSync(
	join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'API.md'),
	'utf8'
);

/** The parameter names in the table under "#### `GET /v1/orderbook`". */
function documentedParams(): string[] {
	const start = API_MD.indexOf('#### `GET /v1/orderbook`');
	const end = API_MD.indexOf('\n#### ', start + 10);
	const section = API_MD.slice(start, end);
	return [...section.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]!);
}

/** A value each documented parameter must refuse. */
const MALFORMED: Record<string, string> = {
	asset: 'NOPE',
	asset_network: 'Not A Network!',
	side: 'up',
	fiat_currency: 'us d',
	payment_method: '',
	payment_methods: '',
	location_region: '',
	langs: 'zz-not-a-lang',
	min_trades: '-1',
	sort: 'sideways',
	limit: '0',
	cursor: ''
};

const queries: { text: string; params: readonly unknown[] }[] = [];
const db = {
	async query<R extends pg.QueryResultRow>(text: string, params?: readonly unknown[]) {
		queries.push({ text, params: params ?? [] });
		return { rows: [] as R[], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
	}
} as unknown as Database;
const route = orderbookRoute(
	db,
	{ getStatus: () => ({ indexedBlock: 1 }) } as unknown as Poller,
	'op'
);

describe('GET /v1/orderbook reads every documented parameter', () => {
	const params = documentedParams();

	it('the documented table was found', () => {
		expect(params).toContain('asset');
		expect(params.length).toBeGreaterThan(5);
	});

	for (const name of params) {
		it(`${name}: a malformed value is refused, not ignored`, async () => {
			expect(MALFORMED, `no malformed sample for documented parameter ${name}`).toHaveProperty(
				name
			);
			const res = await route.request(`/?${name}=${encodeURIComponent(MALFORMED[name]!)}`);
			expect(res.status).toBe(400);
		});
	}

	it('asset_network narrows the query; a network the asset lacks is refused', async () => {
		queries.length = 0;
		expect((await route.request('/?asset=USDT&asset_network=trc20')).status).toBe(200);
		expect(queries[0]!.params).toContain('trc20');
		expect((await route.request('/?asset=USDT&asset_network=base')).status).toBe(400);
		expect((await route.request('/?asset=BTC&asset_network=mainnet')).status).toBe(400);
	});

	it('payment_method filters like payment_methods', async () => {
		queries.length = 0;
		await route.request('/?payment_method=PayPal');
		expect(queries[0]!.params).toContainEqual(['paypal']);
	});
});
