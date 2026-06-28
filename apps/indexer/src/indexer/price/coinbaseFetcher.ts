/**
 * Coinbase Exchange public ticker price fetcher — an additional
 * external source for the multi-source median.
 *
 * Free, no-key public ticker.  Native USD products (BTC-USD), so no
 * USDT basis.  Coinbase does not list XMR (never has) or BLURT, so
 * the factory wires it for BTC (and any future major it lists).
 * A User-Agent is required by Coinbase's edge (priceUpstreamHeaders
 * supplies one).
 *
 * Endpoint: GET /products/{PRODUCT}/ticker   (e.g. BTC-USD)
 * Response: { "price": "90000.12", "size": "...", "time": "...", ... }
 * Bad product: HTTP 404 with { "message": "NotFound" }
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

const log = logger('price-coinbase');

export interface CoinbaseConfig {
	/** Base URL. Default: https://api.exchange.coinbase.com */
	readonly baseUrl: string;
	/** Product id, e.g. 'BTC-USD'. */
	readonly product: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createCoinbaseFetcher(config: CoinbaseConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const base = config.baseUrl.replace(/\/+$/, '');
	const url = `${base}/products/${encodeURIComponent(config.product)}/ticker`;
	return async function fetchCoinbase(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers: priceUpstreamHeaders()
			});
			if (res.status === 429) {
				log.warn('rate_limited', { product: config.product });
				return null;
			}
			if (!res.ok) {
				log.warn('http_not_ok', { product: config.product, status: res.status });
				return null;
			}
			const text = await readPriceBodyCapped(res, ac, url);
			const body = JSON.parse(text) as unknown;
			if (typeof body !== 'object' || body === null) return null;
			const price = Number((body as Record<string, unknown>).price);
			if (!Number.isFinite(price) || price <= 0) return null;
			return price;
		} catch (err) {
			log.warn('fetch_error', { product: config.product }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
