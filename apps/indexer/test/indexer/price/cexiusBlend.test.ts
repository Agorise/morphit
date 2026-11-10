/**
 * v1.24.0 — Cexius (cexius.com) BLURT/USDT as half of BLURT's primary price:
 * averaged with Blurt's own feed (api.blurt.blog) when both answer, either
 * alone when the other is down, the aggregators only when both are down.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BLEND_MAX_SPREAD, CompositeCachedPriceSource } from '$indexer/price/compositeSource';
import { createCexiusFetcher, parseCexiusTicker } from '$indexer/price/cexiusFetcher';
import {
	createPriceSource,
	createAssetPriceSource,
	CP130_ASSET_DEFAULTS
} from '$indexer/price/factory';
import { DisagreementMonitor, runDisagreementCheckCycle } from '$indexer/price/disagreementMonitor';
import type { PriceFetch } from '$indexer/price/source';
import { fakeConfig } from '../../testutils/context';

/** The answer cexius.com gave for BLURT-USDT on 2026-11-09. */
const REAL = {
	ticker: {
		amount: '455959.9322',
		ask: '0.00081606',
		base: 'BLURT',
		base_unit: 'BLURT',
		bid: '0.00080794',
		last: '0.00080818',
		market: 'BLURT-USDT',
		quote_unit: 'USDT',
		timestamp: 1794258580,
		type: 'spot'
	}
};

afterEach(() => vi.unstubAllGlobals());

describe('the Cexius ticker', () => {
	it('reads the last price of the market asked for', () => {
		expect(parseCexiusTicker(REAL, 'BLURT-USDT')).toBe(0.00080818);
	});
	it('refuses another market, another quote, and anything but a positive price', () => {
		expect(parseCexiusTicker(REAL, 'BTC-USDT')).toBeNull();
		expect(
			parseCexiusTicker({ ticker: { ...REAL.ticker, quote_unit: 'BTC' } }, 'BLURT-USDT')
		).toBeNull();
		for (const last of ['0', '-1', 'abc', '', null, undefined, {}])
			expect(
				parseCexiusTicker({ ticker: { ...REAL.ticker, last } }, 'BLURT-USDT'),
				String(last)
			).toBeNull();
		for (const body of [null, [], 'x', 1, {}, { ticker: [] }, { ticker: null }])
			expect(parseCexiusTicker(body, 'BLURT-USDT')).toBeNull();
	});
	it('asks /markets/BLURT-USDT/tickers and never throws', async () => {
		const urls: string[] = [];
		const ok = createCexiusFetcher({
			baseUrl: 'https://cexius.com/api/v2/',
			market: 'BLURT-USDT',
			timeoutMs: 1000,
			fetchImpl: (async (u: string) => {
				urls.push(u);
				return new Response(JSON.stringify(REAL), { status: 200 });
			}) as unknown as typeof fetch
		});
		expect(await ok()).toBe(0.00080818);
		expect(urls).toEqual(['https://cexius.com/api/v2/markets/BLURT-USDT/tickers']);
		const down = createCexiusFetcher({
			baseUrl: 'https://cexius.com/api/v2',
			market: 'BLURT-USDT',
			timeoutMs: 1000,
			fetchImpl: (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch
		});
		expect(await down()).toBeNull();
		const broken = createCexiusFetcher({
			baseUrl: 'https://cexius.com/api/v2',
			market: 'BLURT-USDT',
			timeoutMs: 1000,
			fetchImpl: (async () => {
				throw new Error('ECONNRESET');
			}) as unknown as typeof fetch
		});
		expect(await broken()).toBeNull();
	});
});

const ok =
	(v: number): PriceFetch =>
	async () =>
		v;
const down: PriceFetch = async () => null;

function source(
	blend: Array<{ name: string; fetch: PriceFetch }>,
	external: PriceFetch = ok(0.0009)
) {
	const calls = { external: 0 };
	const s = new CompositeCachedPriceSource({
		primaryBlend: blend,
		upstreams: [
			{
				name: 'coingecko',
				fetch: async () => {
					calls.external++;
					return external();
				}
			}
		],
		staticFloor: 0.002,
		refreshIntervalMs: 60_000,
		setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
		clearInterval: () => undefined
	});
	return { s, calls };
}

describe('BLURT’s primary blend', () => {
	it('averages Blurt’s feed and Cexius when both answer, and skips the aggregators', async () => {
		const { s, calls } = source([
			{ name: 'blurt_price_feed', fetch: ok(0.000714) },
			{ name: 'cexius', fetch: ok(0.000808) }
		]);
		await s.refreshOnce();
		const d = s.currentDetailed();
		expect(d.source).toBe('primary_avg');
		expect(d.price).toBeCloseTo(0.000761, 9);
		expect(calls.external).toBe(0);
		// 13% apart: both counted (their midpoint), no "outlier dropped"
		// warning — each one's own price is on the health view
		expect(s.outlierRejected()).toBe(false);
		expect(s.sourceStatus().map((x) => x.lastValue)).toEqual([0.000714, 0.000808, null]);
		expect(s.sourceStatus().map((x) => [x.name, x.ok])).toEqual([
			['blurt_price_feed', true],
			['cexius', true],
			['coingecko', false]
		]);
	});
	it('agreeing answers are averaged too', async () => {
		const { s } = source([
			{ name: 'blurt_price_feed', fetch: ok(0.0008) },
			{ name: 'cexius', fetch: ok(0.00082) }
		]);
		await s.refreshOnce();
		expect(s.currentDetailed().price).toBeCloseTo(0.00081, 9);
		expect(s.outlierRejected()).toBe(false);
	});
	it('v1.24.0 review: far apart (one odd trade on a thin market), Blurt’s feed alone, not their midpoint', async () => {
		const { s, calls } = source([
			{ name: 'blurt_price_feed', fetch: ok(0.0008) },
			{ name: 'cexius', fetch: ok(0.008) }
		]);
		await s.refreshOnce();
		expect(s.currentDetailed().source).toBe('blurt_price_feed');
		expect(s.currentDetailed().price).toBeCloseTo(0.0008, 9);
		expect(calls.external).toBe(0);
		// Just inside the limit: still averaged.
		const near = source([
			{ name: 'blurt_price_feed', fetch: ok(0.0008) },
			{ name: 'cexius', fetch: ok(0.0008 * (1 + BLEND_MAX_SPREAD) * 0.999) }
		]);
		await near.s.refreshOnce();
		expect(near.s.currentDetailed().source).toBe('primary_avg');
	});
	it('uses either one alone, under its own name, when the other is down or implausible', async () => {
		const a = source([
			{ name: 'blurt_price_feed', fetch: ok(0.000714) },
			{ name: 'cexius', fetch: down }
		]);
		await a.s.refreshOnce();
		expect(a.s.currentDetailed()).toMatchObject({ source: 'blurt_price_feed', price: 0.000714 });
		const b = source([
			{ name: 'blurt_price_feed', fetch: ok(5) }, // above the plausible maximum
			{ name: 'cexius', fetch: ok(0.000808) }
		]);
		await b.s.refreshOnce();
		expect(b.s.currentDetailed()).toMatchObject({ source: 'cexius', price: 0.000808 });
		expect(b.calls.external).toBe(0);
	});
	it('falls to the aggregators only when both are down', async () => {
		const { s, calls } = source([
			{ name: 'blurt_price_feed', fetch: down },
			{
				name: 'cexius',
				fetch: async () => {
					throw new Error('bug');
				}
			}
		]);
		await s.refreshOnce();
		expect(s.currentDetailed()).toMatchObject({ source: 'external_avg', price: 0.0009 });
		expect(calls.external).toBe(1);
	});
	it('a source that is neither (BTC/XMR’s pricenodes) is still asked one by one, after the blend', async () => {
		const seen: string[] = [];
		const s = new CompositeCachedPriceSource({
			primaryBlend: [],
			primaryUpstreams: [
				{ name: 'pricenodes', fetch: async () => (seen.push('pricenodes'), null) },
				{ name: 'federated', fetch: async () => (seen.push('federated'), 70_000) }
			],
			upstreams: [],
			plausibleMin: 1_000,
			plausibleMax: 10_000_000,
			staticFloor: 60_000,
			refreshIntervalMs: 60_000,
			setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
			clearInterval: () => undefined
		});
		await s.refreshOnce();
		expect(seen).toEqual(['pricenodes', 'federated']);
		expect(s.currentDetailed()).toMatchObject({ source: 'federated', price: 70_000 });
	});
});

describe('the factory', () => {
	function stubFetch(prices: { blurt?: number | null; cexius?: number | null }) {
		const asked: string[] = [];
		vi.stubGlobal('fetch', async (u: string) => {
			asked.push(String(u));
			if (String(u).startsWith('https://api.blurt.blog/') && prices.blurt != null)
				return new Response(JSON.stringify({ price_usd: prices.blurt }), { status: 200 });
			if (String(u).startsWith('https://cexius.com/') && prices.cexius != null)
				return new Response(
					JSON.stringify({ ticker: { ...REAL.ticker, last: String(prices.cexius) } }),
					{ status: 200 }
				);
			throw new Error('connect ETIMEDOUT');
		});
		return asked;
	}
	const urls = {
		blurtPriceFeedUrl: 'https://api.blurt.blog/price_info',
		cexiusBaseUrl: 'https://cexius.com/api/v2'
	};

	it('blends api.blurt.blog and Cexius for BLURT on a USD instance', async () => {
		const asked = stubFetch({ blurt: 0.000714, cexius: 0.000808 });
		const s = createPriceSource(fakeConfig(urls));
		await (s as unknown as { refreshOnce(): Promise<void> }).refreshOnce();
		expect(s.currentDetailed().source).toBe('primary_avg');
		expect(s.currentDetailed().price).toBeCloseTo(0.000761, 9);
		expect(asked).toContain('https://cexius.com/api/v2/markets/BLURT-USDT/tickers');
	});
	it('leaves Cexius out when its URL is blank, and on a non-USD instance', async () => {
		stubFetch({ blurt: 0.000714, cexius: 0.000808 });
		const s = createPriceSource(fakeConfig({ ...urls, cexiusBaseUrl: '' }));
		await (s as unknown as { refreshOnce(): Promise<void> }).refreshOnce();
		expect(s.currentDetailed().source).toBe('blurt_price_feed');
		const eur = createPriceSource(fakeConfig({ ...urls, priceFeedDenominationFiat: 'EUR' }));
		const names = (eur as unknown as { sourceStatus(): { name: string }[] })
			.sourceStatus()
			.map((x) => x.name);
		expect(names).not.toContain('cexius');
		expect(names).not.toContain('blurt_price_feed');
	});
	it('asks Cexius for BLURT only', () => {
		const btc = createAssetPriceSource(fakeConfig(urls), { ...CP130_ASSET_DEFAULTS.BTC! });
		const names = (btc as unknown as { sourceStatus(): { name: string }[] })
			.sourceStatus()
			.map((x) => x.name);
		expect(names).not.toContain('cexius');
	});
});

describe('the disagreement monitor', () => {
	it('compares native against a price from the primary sources (it stayed inactive before)', async () => {
		for (const src of ['primary_avg', 'blurt_price_feed', 'cexius', 'pricenodes']) {
			const r = await runDisagreementCheckCycle(
				{
					monitor: new DisagreementMonitor('BLURT', 'USD'),
					nativeFetch: async () => 0.002,
					priceSource: {
						current: () => 0.0008,
						currentDetailed: () => ({
							price: 0.0008,
							source: src,
							updated_at: new Date(),
							stale: false
						})
					} as never
				},
				new Date('2026-11-09T00:00:00Z')
			);
			expect(r.external_source, src).toBe(src);
			expect(r.active, src).toBe(true);
		}
	});
});
