/**
 * OKX public market-ticker price fetcher — an additional external
 * source for the multi-source median.
 *
 * Free, no-key public ticker.  Quoted in USDT (USDT≈USD; the
 * composite median absorbs the basis).  OKX delisted XMR, so the
 * factory wires it for BTC (and any future major it lists).  Does
 * not list BLURT.
 *
 * Endpoint: GET /api/v5/market/ticker?instId={INST}   (e.g. BTC-USDT)
 * Response: { "code":"0", "msg":"", "data":[ { "last":"90000.1", ... } ] }
 * Bad inst:  { "code":"51001", "msg":"Instrument ID does not exist", "data":[] }
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

const log = logger('price-okx');

export interface OkxConfig {
	/** Base URL. Default: https://www.okx.com */
	readonly baseUrl: string;
	/** Instrument id, e.g. 'BTC-USDT'. */
	readonly instId: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createOkxFetcher(config: OkxConfig): PriceFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const base = config.baseUrl.replace(/\/+$/, '');
	const url = `${base}/api/v5/market/ticker?instId=${encodeURIComponent(config.instId)}`;
	return async function fetchOkx(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers: priceUpstreamHeaders()
			});
			if (res.status === 429) {
				log.warn('rate_limited', { instId: config.instId });
				return null;
			}
			if (!res.ok) {
				log.warn('http_not_ok', { instId: config.instId, status: res.status });
				return null;
			}
			const text = await readPriceBodyCapped(res, ac, url);
			const body = JSON.parse(text) as unknown;
			if (typeof body !== 'object' || body === null) return null;
			const obj = body as Record<string, unknown>;
			// OKX signals success with code "0"; anything else is an error.
			if (obj.code !== '0') {
				log.warn('okx_error', { instId: config.instId, code: obj.code });
				return null;
			}
			const data = obj.data;
			if (!Array.isArray(data) || data.length === 0) return null;
			const entry = data[0];
			if (typeof entry !== 'object' || entry === null) return null;
			const price = Number((entry as Record<string, unknown>).last);
			if (!Number.isFinite(price) || price <= 0) return null;
			return price;
		} catch (err) {
			log.warn('fetch_error', { instId: config.instId }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
