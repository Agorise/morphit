/**
 * CoinLore crypto→USD price fetcher — an additional external source
 * for the multi-source median.
 *
 * Free, no-key public ticker.  CoinLore keys assets by an opaque
 * NUMERIC id (e.g. Bitcoin = 90), not by ticker, so each asset must
 * carry its verified CoinLore id in the factory defaults; assets
 * without a known id simply don't wire CoinLore.  Covers any asset
 * CoinLore lists (broad long-tail aggregator).
 *
 * Endpoint: GET /api/ticker/?id={id}    (e.g. 90)
 * Response: [ { "id":"90", "symbol":"BTC", "price_usd":"90000.1", ... } ]
 * Bad id:   [] (empty array) or { "error": "..." }
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

const log = logger('price-coinlore');

export interface CoinloreConfig {
	/** Base URL. Default: https://api.coinlore.net */
	readonly baseUrl: string;
	/** CoinLore numeric asset id (string), e.g. '90' for Bitcoin. */
	readonly assetId: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createCoinloreFetcher(config: CoinloreConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const base = config.baseUrl.replace(/\/+$/, '');
	const url = `${base}/api/ticker/?id=${encodeURIComponent(config.assetId)}`;
	return async function fetchCoinlore(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers: priceUpstreamHeaders()
			});
			if (res.status === 429) {
				log.warn('rate_limited', { assetId: config.assetId });
				return null;
			}
			if (!res.ok) {
				log.warn('http_not_ok', { assetId: config.assetId, status: res.status });
				return null;
			}
			const text = await readPriceBodyCapped(res, ac, url);
			const body = JSON.parse(text) as unknown;
			// CoinLore returns an array of one entry for ?id=.
			if (!Array.isArray(body) || body.length === 0) return null;
			const entry = body[0];
			if (typeof entry !== 'object' || entry === null) return null;
			const price = Number((entry as Record<string, unknown>).price_usd);
			if (!Number.isFinite(price) || price <= 0) return null;
			return price;
		} catch (err) {
			log.warn('fetch_error', { assetId: config.assetId }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
