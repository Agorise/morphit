/**
 * Cexius public market-ticker price fetcher (v1.24.0) — BLURT/USDT.
 *
 * Cexius (cexius.com) is a centralized exchange that lists BLURT/USDT. Its
 * last trade price is averaged with Blurt's own feed (api.blurt.blog) as the
 * primary BLURT/USD source (factory.ts, compositeSource.ts `primaryBlend`).
 * Free, no key. Quoted in USDT (USDT≈USD), so it joins only when the
 * instance prices in USD.
 *
 * Endpoint: GET {base}/markets/{market}/tickers   (base https://cexius.com/api/v2,
 *           market e.g. BLURT-USDT; cexius.com/api-docs)
 * Response: { "ticker": { "market": "BLURT-USDT", "last": "0.00080818",
 *             "bid": "…", "ask": "…", "quote_unit": "USDT", "timestamp": 1794258580, … } }
 *
 * The answer counts only when it names the market asked for and quotes
 * USDT, with a positive last price. Contract: never throws; returns a
 * positive number or null.
 */

import { logger } from '$log';
import type { PriceFetch } from '$indexer/price/source';
import {
	priceUpstreamFetchInit,
	priceUpstreamHeaders,
	readPriceBodyCapped
} from '$indexer/price/priceFetchUtil';

const log = logger('price-cexius');

export interface CexiusConfig {
	/** Base URL. Default: https://cexius.com/api/v2 */
	readonly baseUrl: string;
	/** Market id, e.g. 'BLURT-USDT'. */
	readonly market: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

/** The last price in a Cexius ticker answer for `market`, or null. PURE. */
export function parseCexiusTicker(body: unknown, market: string): number | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const ticker = (body as Record<string, unknown>).ticker;
	if (typeof ticker !== 'object' || ticker === null || Array.isArray(ticker)) return null;
	const t = ticker as Record<string, unknown>;
	if (t.market !== market) return null;
	if (t.quote_unit !== undefined && t.quote_unit !== 'USDT') return null;
	if (typeof t.last !== 'string' && typeof t.last !== 'number') return null;
	const price = Number(t.last);
	return Number.isFinite(price) && price > 0 ? price : null;
}

export function createCexiusFetcher(config: CexiusConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const base = config.baseUrl.replace(/\/+$/, '');
	const url = `${base}/markets/${encodeURIComponent(config.market)}/tickers`;
	return async function fetchCexius(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers: priceUpstreamHeaders()
			});
			if (!res.ok) {
				log.warn(res.status === 429 ? 'rate_limited' : 'http_not_ok', {
					market: config.market,
					status: res.status
				});
				await res.body?.cancel().catch(() => undefined);
				return null;
			}
			const price = parseCexiusTicker(
				JSON.parse(await readPriceBodyCapped(res, ac, url)) as unknown,
				config.market
			);
			if (price === null) log.warn('unexpected_shape', { market: config.market });
			return price;
		} catch (err) {
			log.warn('fetch_error', { market: config.market }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
