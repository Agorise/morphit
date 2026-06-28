/**
 * CryptoCompare (CCData) crypto→USD price fetcher — an additional
 * external source for the multi-source median.
 *
 * Free public price endpoint (no key required for basic price;
 * an optional key raises the rate limit and is sent as the
 * documented `authorization: Apikey <key>` header when present).
 * Symbol-keyed (no per-provider numeric id lookup), so it covers
 * BLURT + BTC + XMR with the asset's plain ticker.
 *
 * Endpoint: GET /data/price?fsym={SYM}&tsyms=USD
 * Success:  { "USD": 90000.12 }
 * Error:    { "Response": "Error", "Message": "...", "USD": ... absent }
 *   — CryptoCompare returns HTTP 200 with a Response:"Error" body on
 *     an unknown symbol, so we must check for that, not just res.ok.
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

const log = logger('price-cryptocompare');

export interface CryptocompareConfig {
	/** Base URL. Default: https://min-api.cryptocompare.com */
	readonly baseUrl: string;
	/** Asset ticker symbol, e.g. 'BTC', 'XMR', 'BLURT'. */
	readonly symbol: string;
	/** Optional API key (raises rate limit; basic price works without). */
	readonly apiKey?: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createCryptocompareFetcher(config: CryptocompareConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const base = config.baseUrl.replace(/\/+$/, '');
	const url = `${base}/data/price?fsym=${encodeURIComponent(config.symbol)}&tsyms=USD`;
	return async function fetchCryptocompare(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const headers = priceUpstreamHeaders();
			if (config.apiKey) headers.authorization = `Apikey ${config.apiKey}`;
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers
			});
			if (res.status === 429) {
				log.warn('rate_limited', { symbol: config.symbol });
				return null;
			}
			if (!res.ok) {
				log.warn('http_not_ok', { symbol: config.symbol, status: res.status });
				return null;
			}
			const text = await readPriceBodyCapped(res, ac, url);
			const body = JSON.parse(text) as unknown;
			if (typeof body !== 'object' || body === null) return null;
			const obj = body as Record<string, unknown>;
			// CryptoCompare reports a bad symbol as a 200 with Response:"Error".
			if (obj.Response === 'Error') {
				log.warn('cryptocompare_error', { symbol: config.symbol });
				return null;
			}
			const price = Number(obj.USD);
			if (!Number.isFinite(price) || price <= 0) return null;
			return price;
		} catch (err) {
			log.warn('fetch_error', { symbol: config.symbol }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
