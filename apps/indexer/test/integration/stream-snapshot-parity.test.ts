/**
 * The live stream's snapshot is the REST page it replaces, on real
 * Postgres.
 *
 * The orderbook page renders GET /v1/orderbook, then swaps in the stream's
 * snapshot. The snapshot ignored `langs` and `sort` and dropped asset_network,
 * lang and the inline identity (display name, avatar metadata) — so a filtered
 * or sorted page reshuffled a moment after load and cards lost their names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { orderbookRoute } from '../../src/api/orderbook';
import { orderbookStreamRoute } from '../../src/api/orderbookStream';
import { _resetStreamCapsForTest } from '../../src/api/streamCaps';
import type { Poller } from '../../src/indexer/poller';

const poller = { getStatus: () => ({ indexedBlock: 1 }) } as unknown as Poller;

describe.skipIf(!INTEGRATION_ENABLED)('stream snapshot == REST page', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		_resetStreamCapsForTest();
		const order = (
			account: string,
			minutesAgo: number,
			lang: string | null,
			network: string | null
		) =>
			fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, asset_network, fiat_currency, price_model,
				                     payment_methods, status, created_at, updated_at, fee_status, lang)
				 VALUES ($1, 'o', 'sell', $2, $3, 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'], 'live',
				         NOW(), NOW() - ($4 || ' minutes')::interval, 'verified', $5)`,
				[account, network ? 'USDT' : 'BTC', network, minutesAgo, lang]
			);
		await order('newest', 1, 'en', null);
		await order('rated', 5, 'es', 'trc20');
		await order('untagged', 9, null, null);
		await fx.db.query(
			`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
			 VALUES ('someone', 'rated', 5, 'o', NOW(), 'f1')`
		);
		await fx.db.query(
			`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id)
			 VALUES ('rated', 'c', 1, NOW(), 't1')`
		);
		await fx.db.query(
			`INSERT INTO profiles (account, display_name, json_metadata, source_block_num, source_trx_id, updated_at)
			 VALUES ('rated', 'Rated Trader', '{"profile":{"name":"Rated Trader"}}'::jsonb, 1, 'p1', NOW())`
		);
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	async function snapshot(query: string): Promise<Record<string, unknown>[]> {
		const res = await orderbookStreamRoute(fx.db, poller, 'op').request(
			`/${query}`,
			{},
			{ incoming: { socket: { remoteAddress: '127.0.0.1' } } }
		);
		const reader = res.body!.getReader();
		let text = '';
		while (!/event: snapshot\ndata: .*\n\n/.test(text)) {
			const { value, done } = await reader.read();
			if (done) break;
			text += new TextDecoder().decode(value);
		}
		await reader.cancel();
		const data = /event: snapshot\ndata: (.*)\n\n/.exec(text)![1]!;
		return (JSON.parse(data) as { items: Record<string, unknown>[] }).items;
	}
	async function restPage(query: string): Promise<Record<string, unknown>[]> {
		const res = await orderbookRoute(fx.db, poller, 'op').request(`/${query}`);
		return ((await res.json()) as { items: Record<string, unknown>[] }).items;
	}

	// v1.21.1 — a language filter lists only orders in that language: the
	// untagged order (posted before v1.15.0) no longer slips through.
	it('?langs=es lists only the Spanish order, on the page and in the live snapshot', async () => {
		const [rest, live] = await Promise.all([restPage('?langs=es'), snapshot('?langs=es')]);
		expect(rest.map((o) => o.account)).toEqual(['rated']);
		expect(live.map((o) => o.account)).toEqual(['rated']);
		expect((await restPage('')).map((o) => o.account).sort()).toEqual([
			'newest',
			'rated',
			'untagged'
		]);
	});

	it("the database's description of orders.lang says what the filter does (migration v67)", async () => {
		const r = await fx.db.query<{ d: string | null }>(
			`SELECT col_description('orders'::regclass, a.attnum) AS d
			   FROM pg_attribute a WHERE a.attrelid = 'orders'::regclass AND a.attname = 'lang'`
		);
		expect(r.rows[0]?.d).toMatch(/lists only orders tagged with one of its languages/);
		expect(r.rows[0]?.d).not.toMatch(/NEVER hidden/i);
	});

	for (const query of ['', '?sort=rating', '?langs=es']) {
		it(`same orders, same order, same fields: "${query || 'bare'}"`, async () => {
			const [rest, live] = await Promise.all([restPage(query), snapshot(query)]);
			expect(live.map((o) => o.account)).toEqual(rest.map((o) => o.account));
			expect(live).toEqual(rest);
		});
	}
});
