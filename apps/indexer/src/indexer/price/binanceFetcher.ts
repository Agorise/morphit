/**
 * Binance public spot-ticker price fetcher — an additional
 * external source for the multi-source median.
 *
 * Free, no-key public ticker.  Symbols are quoted in USDT (Binance
 * has no native USD spot pairs); USDT≈USD and the composite's
 * median + outlier rejection absorbs the tiny USDT/USD basis.
 * Binance delisted XMR in 2024, so the factory only wires it for
 * BTC (and any future major it lists).  Does not list BLURT.
 *
 * Endpoint: GET /api/v3/ticker/price?symbol={SYMBOL}   (e.g. BTCUSDT)
 * Response: { "symbol": "BTCUSDT", "price": "90000.10" }
 * Bad symbol: HTTP 400 with { "code": -1121, "msg": "Invalid symbol." }
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

const log = logger('price-binance');

export interface BinanceConfig {
	/** Base URL. Default: https://api.binance.com */
	readonly baseUrl: string;
	/** Spot symbol, e.g. 'BTCUSDT'. */
	readonly symbol: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createBinanceFetcher(config: BinanceConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const base = config.baseUrl.replace(/\/+$/, '');
	const url = `${base}/api/v3/ticker/price?symbol=${encodeURIComponent(config.symbol)}`;
	return async function fetchBinance(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers: priceUpstreamHeaders()
			});
			if (res.status === 429 || res.status === 418) {
				log.warn('rate_limited', { symbol: config.symbol, status: res.status });
				return null;
			}
			if (!res.ok) {
				log.warn('http_not_ok', { symbol: config.symbol, status: res.status });
				return null;
			}
			const text = await readPriceBodyCapped(res, ac, url);
			const body = JSON.parse(text) as unknown;
			if (typeof body !== 'object' || body === null) return null;
			const price = Number((body as Record<string, unknown>).price);
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
