/**
 * currency-api USD→fiat fetcher (tertiary FX upstream).
 *
 * fawazahmed0's currency-api — a free, no-key dataset served from
 * the jsDelivr CDN (and a pages.dev mirror).  CDN-hosted means very
 * high availability and no rate-limit account.  Covers ~150 fiat +
 * crypto codes; we keep only the fiat ones the composite's
 * plausibility filter accepts.  Privacy-respecting (static CDN
 * file, base=USD).
 *
 * Endpoint: GET /v1/currencies/usd.json
 * Response: { "date":"…", "usd": { "eur":0.92, "gbp":0.79, … } }   (codes lowercase)
 *
 * Contract: never throws; returns an FxRateTable or null.
 */

import { type FxFetch, type FxRateTable } from '$indexer/fx/source';
import { fxGetJson, tableFromFlat } from '$indexer/fx/fetchUtil';

export interface CurrencyApiConfig {
	/** Base URL (the dated/`latest` path root, e.g.
	 *  https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1).
	 *  The fetcher appends /currencies/usd.json. */
	readonly baseUrl: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createCurrencyApiFetcher(config: CurrencyApiConfig): FxFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const url = `${config.baseUrl.replace(/\/+$/, '')}/currencies/usd.json`;
	return async function fetchCurrencyApi(): Promise<FxRateTable | null> {
		const body = await fxGetJson(url, config.timeoutMs, fetchImpl);
		if (typeof body !== 'object' || body === null) return null;
		// Shape: { date, usd: { eur: n, … } }.  tableFromFlat
		// uppercases the lowercase codes.
		const usd = (body as Record<string, unknown>).usd;
		return tableFromFlat(usd);
	};
}
