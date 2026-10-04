// @vitest-environment jsdom
/**
 * In-app prices come from this instance's indexer (/v1/listing-fee carries
 * the live BLURT, BTC and XMR prices it holds, and only while they are fresh).
 * Where it has no live price the app says "unknown": no bundled constant is
 * ever presented as a price, so a market order's pay amount stays blank
 * rather than seeding a transfer from a guess.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

import { computeOrderPayAmount } from '$lib/orders/payAmount';

let body: Record<string, unknown> = {};
let status = 200;
let calls = 0;
beforeEach(() => {
	vi.resetModules();
	calls = 0;
	status = 200;
	body = { base_fee_blurt: 60, feature_fee_blurt_per_hour: 50, quote_ttl_seconds: 300 };
	vi.stubGlobal('fetch', async (url: string) => {
		calls++;
		expect(String(url)).toMatch(/\/v1\/listing-fee$/);
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	});
});
afterEach(() => vi.unstubAllGlobals());

const marketOrder = {
	price_model: { kind: 'spread', percent: 0 },
	fiat_currency: 'USD',
	amount_min: 10
} as never;

describe('prices', () => {
	it('no live price on the indexer → unknown, and a market pay amount stays blank', async () => {
		const { getPrice } = await import('$lib/prices');
		const q = await getPrice('BLURT');
		expect(q).toBeNull();
		expect(computeOrderPayAmount(marketOrder, null, q?.usd ?? null)).toBeNull();
	});

	it('the indexer’s live USD prices are used, labelled with their source', async () => {
		body = {
			...body,
			denomination_fiat: 'USD',
			blurt_price_fiat: 0.004,
			btc_price_fiat: 60_000,
			xmr_price_fiat: 150
		};
		const { getPrice } = await import('$lib/prices');
		const blurt = await getPrice('BLURT');
		expect(blurt?.usd).toBe(0.004);
		expect(blurt?.source).toBe('indexer');
		expect((await getPrice('BTC'))?.usd).toBe(60_000);
		expect((await getPrice('XMR'))?.usd).toBe(150);
		// One read of the indexer serves all three.
		expect(calls).toBe(1);
	});

	it('a non-USD denomination or an asset the indexer does not price is unknown', async () => {
		body = { ...body, denomination_fiat: 'EUR', blurt_price_fiat: 0.004 };
		const { getPrice } = await import('$lib/prices');
		expect(await getPrice('BLURT')).toBeNull();
		expect(await getPrice('USDT')).toBeNull();
		expect(await getPrice('LTC')).toBeNull();
	});

	it('a failed read is unknown, not a constant', async () => {
		status = 503;
		const { getPrice, symbolAmountToUsd } = await import('$lib/prices');
		expect(await getPrice('BTC')).toBeNull();
		expect(await symbolAmountToUsd(1, 'BLURT')).toBeNull();
	});

	it('a quote older than the staleness bound is not a live price', async () => {
		const { liveUsd, MAX_QUOTE_AGE_MS } = await import('$lib/prices');
		const now = Date.now();
		const q = { symbol: 'BTC' as const, usd: 60_000, fetchedAt: now, source: 'indexer' };
		expect(liveUsd(q, now)).toBe(60_000);
		expect(liveUsd({ ...q, fetchedAt: now - MAX_QUOTE_AGE_MS - 1 }, now)).toBeNull();
		expect(liveUsd(null, now)).toBeNull();
	});
});
