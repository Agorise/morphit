/**
 * open.er-api.com USD→fiat fetcher (secondary FX upstream).
 *
 * The free, no-key tier of ExchangeRate-API.  Covers ~160
 * currencies (far wider than the ECB set), updated daily.  No key,
 * no account, privacy-respecting.  Sits behind Frankfurter and
 * provides much broader currency coverage when Frankfurter is down
 * or lacks an exotic currency.
 *
 * Endpoint: GET /v6/latest/USD
 * Response: { "result":"success", "base_code":"USD", "rates":{ "EUR":0.92, … } }
 *
 * Contract: never throws; returns an FxRateTable or null.
 */

import { type FxFetch, type FxRateTable } from '$indexer/fx/source';
import { fxGetJson, tableFromFlat } from '$indexer/fx/fetchUtil';

export interface ErApiConfig {
	/** Base URL. Default: https://open.er-api.com/v6 */
	readonly baseUrl: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createErApiFetcher(config: ErApiConfig): FxFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const url = `${config.baseUrl.replace(/\/+$/, '')}/latest/USD`;
	return async function fetchErApi(): Promise<FxRateTable | null> {
		const body = await fxGetJson(url, config.timeoutMs, fetchImpl);
		if (typeof body !== 'object' || body === null) return null;
		const obj = body as Record<string, unknown>;
		// Only accept an explicit success result.
		if (typeof obj.result === 'string' && obj.result !== 'success') return null;
		if (typeof obj.base_code === 'string' && obj.base_code.toUpperCase() !== 'USD') return null;
		return tableFromFlat(obj.rates);
	};
}
