/**
 * Kraken crypto→USD price fetcher (additional external source for
 * the multi-source average).
 *
 * Free, no-key public ticker.  Covers BTC + XMR USD pairs (Kraken
 * does not list BLURT, so it's only wired for BTC/XMR in the
 * factory).  The last-trade price (`c[0]`) is used.
 *
 * Endpoint: GET /0/public/Ticker?pair={pair}   (e.g. XBTUSD, XMRUSD)
 * Response: { "error":[], "result": { "<KEY>": { "c":["65000.1","0.01"], … } } }
 *   — the result key is Kraken-internal (e.g. XXBTZUSD) and varies,
 *   so we read the single (first) entry rather than hardcoding it.
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

const log = logger('price-kraken');

export interface KrakenConfig {
	/** Base URL. Default: https://api.kraken.com/0/public */
	readonly baseUrl: string;
	/** Kraken pair, e.g. 'XBTUSD' (BTC), 'XMRUSD'. */
	readonly pair: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createKrakenFetcher(config: KrakenConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const url = `${config.baseUrl.replace(/\/+$/, '')}/Ticker?pair=${encodeURIComponent(config.pair)}`;
	return async function fetchKraken(): Promise<number | null> {
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
			const obj = body as Record<string, unknown>;
			// Kraken signals errors in a non-empty `error` array.
			if (Array.isArray(obj.error) && obj.error.length > 0) {
				log.warn('kraken_error', { url, error: obj.error });
				return null;
			}
			const result = obj.result;
			if (typeof result !== 'object' || result === null) return null;
			const keys = Object.keys(result as Record<string, unknown>);
			if (keys.length === 0) return null;
			const entry = (result as Record<string, unknown>)[keys[0]!];
			if (typeof entry !== 'object' || entry === null) return null;
			const c = (entry as Record<string, unknown>).c;
			if (!Array.isArray(c) || c.length === 0) return null;
			const price = Number(c[0]);
			if (!Number.isFinite(price) || price <= 0) return null;
			return price;
		} catch (err) {
			log.warn('fetch_error', { url }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
