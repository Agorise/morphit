/**
 * CoinPaprika crypto→USD price fetcher (additional external source
 * for the multi-source average).
 *
 * Free, no-key, generous limits.  Per-coin ticker endpoint with a
 * USD quote.  Covers BTC, XMR, and many small caps (including BLURT
 * via 'blurt-blurt' when listed).
 *
 * Endpoint: GET /v1/tickers/{coinId}?quotes=USD
 * Response: { ..., "quotes": { "USD": { "price": 65000.1, ... } } }
 *
 * Contract: never throws; returns a positive number or null.
 */

import { logger } from '$log';
import type { PriceFetch } from '$indexer/price/source';
import {
	priceUpstreamFetchInit,
	priceUpstreamHeaders,
	readPriceBodyCapped
} from '$indexer/price/priceFetchUtil';

const log = logger('price-coinpaprika');

export interface CoinpaprikaConfig {
	/** Base URL. Default: https://api.coinpaprika.com/v1 */
	readonly baseUrl: string;
	/** CoinPaprika coin id, e.g. 'btc-bitcoin', 'xmr-monero'. */
	readonly coinId: string;
	/** Quote currency code (uppercase), e.g. 'USD'. */
	readonly vsCurrency: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createCoinpaprikaFetcher(config: CoinpaprikaConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const vs = config.vsCurrency.toUpperCase();
	const url = `${config.baseUrl.replace(/\/+$/, '')}/tickers/${encodeURIComponent(config.coinId)}?quotes=${encodeURIComponent(vs)}`;
	return async function fetchCoinpaprika(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers: priceUpstreamHeaders()
			});
			if (res.status === 429) {
				log.warn('rate_limited', { url });
				return null;
			}
			if (!res.ok) {
				log.warn('http_not_ok', { url, status: res.status });
				return null;
			}
			const text = await readPriceBodyCapped(res, ac, url);
			const body = JSON.parse(text) as unknown;
			if (typeof body !== 'object' || body === null) return null;
			const quotes = (body as Record<string, unknown>).quotes;
			if (typeof quotes !== 'object' || quotes === null) return null;
			const q = (quotes as Record<string, unknown>)[vs];
			if (typeof q !== 'object' || q === null) return null;
			const price = (q as Record<string, unknown>).price;
			if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
			return price;
		} catch (err) {
			log.warn('fetch_error', { url }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
