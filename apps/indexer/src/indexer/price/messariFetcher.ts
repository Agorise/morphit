/**
 * Messari crypto→USD price fetcher — an additional external source
 * for the multi-source median.
 *
 * KEY-GATED: Messari's market-data endpoint requires an API key
 * (sent as the documented `x-messari-api-key` header).  The factory
 * only wires Messari when the operator has set a Messari key, so
 * without one it doesn't join the average.  Slug-keyed (e.g.
 * 'bitcoin', 'monero'); covers any asset Messari lists.
 *
 * Endpoint: GET /api/v1/assets/{slug}/metrics/market-data
 * Response: { "data": { "market_data": { "price_usd": 90000.1, ... } }, ... }
 * Bad slug: HTTP 404
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

const log = logger('price-messari');

export interface MessariConfig {
	/** Base URL. Default: https://data.messari.io */
	readonly baseUrl: string;
	/** Messari asset slug, e.g. 'bitcoin', 'monero'. */
	readonly slug: string;
	/** API key (required; the factory only wires this when present). */
	readonly apiKey: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createMessariFetcher(config: MessariConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const base = config.baseUrl.replace(/\/+$/, '');
	const url = `${base}/api/v1/assets/${encodeURIComponent(config.slug)}/metrics/market-data`;
	return async function fetchMessari(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const headers = priceUpstreamHeaders();
			headers['x-messari-api-key'] = config.apiKey;
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers
			});
			if (res.status === 429) {
				log.warn('rate_limited', { slug: config.slug });
				return null;
			}
			if (!res.ok) {
				log.warn('http_not_ok', { slug: config.slug, status: res.status });
				return null;
			}
			const text = await readPriceBodyCapped(res, ac, url);
			const body = JSON.parse(text) as unknown;
			if (typeof body !== 'object' || body === null) return null;
			const data = (body as Record<string, unknown>).data;
			if (typeof data !== 'object' || data === null) return null;
			const md = (data as Record<string, unknown>).market_data;
			if (typeof md !== 'object' || md === null) return null;
			const price = Number((md as Record<string, unknown>).price_usd);
			if (!Number.isFinite(price) || price <= 0) return null;
			return price;
		} catch (err) {
			log.warn('fetch_error', { slug: config.slug }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
