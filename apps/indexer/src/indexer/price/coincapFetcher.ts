/**
 * CoinCap (v3) crypto→USD price fetcher — an additional external
 * source for the multi-source median.
 *
 * KEY-GATED: CoinCap retired the keyless v2 API; v3 (rest.coincap.io)
 * requires an API key, sent as `Authorization: Bearer <key>`.  The
 * factory only wires CoinCap when the operator has set a CoinCap key,
 * so without one it simply doesn't join the average (no dead calls).
 * Id-keyed (e.g. 'bitcoin', 'monero'); covers any asset CoinCap lists.
 *
 * Endpoint: GET /assets/{id}            (e.g. bitcoin)
 * Response: { "data": { "id":"bitcoin", "priceUsd":"90000.1", ... }, ... }
 * Bad id:   HTTP 404
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

const log = logger('price-coincap');

export interface CoincapConfig {
	/** Base URL. Default: https://rest.coincap.io/v3 */
	readonly baseUrl: string;
	/** CoinCap asset id, e.g. 'bitcoin', 'monero'. */
	readonly assetId: string;
	/** API key (required by CoinCap v3; the factory only wires this
	 *  fetcher when a key is present). */
	readonly apiKey: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createCoincapFetcher(config: CoincapConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const base = config.baseUrl.replace(/\/+$/, '');
	const url = `${base}/assets/${encodeURIComponent(config.assetId)}`;
	return async function fetchCoincap(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const headers = priceUpstreamHeaders();
			headers.authorization = `Bearer ${config.apiKey}`;
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers
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
			if (typeof body !== 'object' || body === null) return null;
			const data = (body as Record<string, unknown>).data;
			if (typeof data !== 'object' || data === null) return null;
			const price = Number((data as Record<string, unknown>).priceUsd);
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
