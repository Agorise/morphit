/**
 * Bybit v5 public spot-ticker price fetcher — an additional
 * external source for the multi-source median.
 *
 * Free, no-key public ticker.  Quoted in USDT (USDT≈USD; the
 * composite median absorbs the basis).  Bybit delisted XMR, so the
 * factory wires it for BTC (and any future major it lists).  Does
 * not list BLURT.
 *
 * Endpoint: GET /v5/market/tickers?category=spot&symbol={SYMBOL}
 * Response: { "retCode":0, "result":{ "list":[ { "lastPrice":"90000.1", ... } ] } }
 * Bad symbol: { "retCode":0, "result":{ "list":[] } }  (empty list)
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

const log = logger('price-bybit');

export interface BybitConfig {
	/** Base URL. Default: https://api.bybit.com */
	readonly baseUrl: string;
	/** Spot symbol, e.g. 'BTCUSDT'. */
	readonly symbol: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createBybitFetcher(config: BybitConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const base = config.baseUrl.replace(/\/+$/, '');
	const url = `${base}/v5/market/tickers?category=spot&symbol=${encodeURIComponent(config.symbol)}`;
	return async function fetchBybit(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers: priceUpstreamHeaders()
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
			if (obj.retCode !== 0) {
				log.warn('bybit_error', { symbol: config.symbol, retCode: obj.retCode });
				return null;
			}
			const result = obj.result;
			if (typeof result !== 'object' || result === null) return null;
			const list = (result as Record<string, unknown>).list;
			if (!Array.isArray(list) || list.length === 0) return null;
			const entry = list[0];
			if (typeof entry !== 'object' || entry === null) return null;
			const price = Number((entry as Record<string, unknown>).lastPrice);
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
