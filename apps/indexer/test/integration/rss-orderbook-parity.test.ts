/**
 * The RSS/Atom/JSON feeds select the same orders as the orderbook page they
 * are subscribed from, on real Postgres.
 *
 * The feeds built their own WHERE clause and drifted from the orderbook: an
 * order past its expires_at stayed in every feed, location_region matched as
 * a prefix where the orderbook matches a substring, min_trades counted
 * REVIEWS where the orderbook counts completed trades, an asset feed missed
 * orders that pay in or accept that asset, and `langs` was ignored. Separately,
 * one order whose text carried U+FFFF made every XML feed ill-formed, so
 * readers dropped the whole feed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig } from '../testutils/context';
import { orderbookRoute } from '../../src/api/orderbook';
import { globalFeedHandler, perAssetFeedHandler } from '../../src/api/rssOrderbookHandlers';
import type { Poller } from '../../src/indexer/poller';

const config = fakeConfig();
const poller = { getStatus: () => ({ indexedBlock: 1 }) } as unknown as Poller;

describe.skipIf(!INTEGRATION_ENABLED)('feeds and orderbook select the same orders', () => {
	let fx: IntegrationFixture;

	const ins = (o: {
		account: string;
		permlink: string;
		asset?: string;
		region?: string;
		expires?: string;
		status?: string;
		counterparty?: string;
		payment?: string[];
		lang?: string | null;
	}) =>
		fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, created_at, updated_at, expires_at, fee_status, location_region,
			                     completed_counterparty, lang)
			 VALUES ($1, $2, 'sell', $3, 'NPR', '{"kind":"fixed","price":1}'::jsonb, $4, $5, NOW(), NOW(),
			         ${o.expires ?? 'NULL'}, 'verified', $6, $7, $8)`,
			[
				o.account,
				o.permlink,
				o.asset ?? 'DOGE',
				o.payment ?? ['cash'],
				o.status ?? 'live',
				o.region ?? 'Lalitpur',
				o.counterparty ?? null,
				o.lang ?? null
			]
		);

	beforeAll(async () => {
		fx = await setupWithMigrations();
		// Expired three days ago: the orderbook hides it.
		await ins({
			account: 'expired',
			permlink: 'old',
			region: 'Kathmandu',
			expires: `NOW() - interval '3 days'`
		});
		// "Pokhara" in the middle of the region string.
		await ins({
			account: 'midregion',
			permlink: 'p',
			region: 'Greater Pokhara',
			expires: `NOW() + interval '3 days'`
		});
		// Three completed, fee-paid trades and no reviews.
		await ins({ account: 'veteran', permlink: 'p' });
		for (const k of ['a', 'b', 'c'])
			await ins({
				account: 'veteran',
				permlink: `done${k}`,
				status: 'completed',
				counterparty: `buyer${k}`
			});
		// Three reviews and no completed trade.
		await ins({ account: 'reviewed', permlink: 'p' });
		// A BTC order that pays in DOGE: the DOGE orderbook shows it.
		await ins({ account: 'paysdoge', permlink: 'p', asset: 'BTC', payment: ['pay_doge'] });
		// Declared Spanish.
		await ins({ account: 'spanish', permlink: 'p', lang: 'es' });
		await ins({ account: 'english', permlink: 'p', lang: 'en' });
		for (const k of ['a', 'b', 'c']) {
			await fx.db.query(
				`INSERT INTO feedback (reviewer, subject, rating, order_permlink, source_trx_id, created_at)
				 VALUES ($1, 'reviewed', 5, 'p', $2, NOW())`,
				[`rev${k}`, `t${k}`.padEnd(40, '0')]
			);
		}
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	const rest = async (query: string): Promise<string[]> => {
		const res = await orderbookRoute(fx.db, poller, config.operatorAccountName).request(
			`/?fiat_currency=NPR${query}`
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { account: string }[] };
		return [...new Set(body.items.map((o) => o.account))].sort();
	};
	const feedAccounts = (json: string): string[] =>
		[
			...new Set(
				(
					JSON.parse(json) as {
						items: { title: string; content_text?: string; summary?: string }[];
					}
				).items.map(
					(i) => /@([a-z0-9.-]+)/.exec(`${i.content_text ?? ''} ${i.summary ?? ''} ${i.title}`)![1]!
				)
			)
		].sort();

	const CASES: [string, Record<string, string>][] = [
		['bare', {}],
		['region substring', { location_region: 'Pokhara' }],
		['min_trades=3', { min_trades: '3' }],
		['langs=es', { langs: 'es' }]
	];

	for (const [name, filters] of CASES) {
		it(`global feed == orderbook: ${name}`, async () => {
			const qs = Object.entries(filters)
				.map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
				.join('');
			const feed = await globalFeedHandler(fx.db, config, 'json', {
				fiat_currency: 'NPR',
				...filters
			});
			expect(feedAccounts(feed.body)).toEqual(await rest(qs));
		});
	}

	it('per-asset feed == orderbook for that asset (orders paying in it included)', async () => {
		const feed = await perAssetFeedHandler('doge.json', fx.db, config, { fiat_currency: 'NPR' });
		const ob = await rest('&asset=DOGE');
		expect(ob).toContain('paysdoge');
		expect(feedAccounts(feed.body)).toEqual(ob);
	});

	it('an order carrying U+FFFF leaves every XML feed well-formed', async () => {
		await fx.db.query(
			`UPDATE orders SET location_region = 'Pokhara' || chr(65535) || chr(65534) WHERE account = 'midregion'`
		);
		for (const format of ['rss', 'atom'] as const) {
			const feed = await globalFeedHandler(fx.db, config, format, {});
			expect(feed.body).toContain('Pokhara');
			expect(/[￾￿]/.test(feed.body), `${format}: a non-XML character reached the feed`).toBe(false);
			if (existsSync('/usr/bin/xmllint')) {
				const file = join(mkdtempSync(join(tmpdir(), 'feed-')), `feed.${format}.xml`);
				writeFileSync(file, feed.body);
				expect(() =>
					execFileSync('/usr/bin/xmllint', ['--noout', file], { stdio: 'pipe' })
				).not.toThrow();
			}
		}
	});
});
