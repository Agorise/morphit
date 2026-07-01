/**
 * Frankfurter USD→fiat fetcher (primary FX upstream).
 *
 * Frankfurter (frankfurter.dev) is a free, no-key, open-source FX
 * API serving European Central Bank reference rates — the most
 * authoritative non-commercial source.  Covers ~30 major
 * currencies (the ECB reference set), refreshed on ECB business
 * days.  No API key, no rate-limit account, privacy-respecting.
 *
 * Endpoint: GET /v1/latest?base=USD
 * Response: { "amount":1, "base":"USD", "date":"…", "rates":{ "EUR":0.92, … } }
 *
 * Contract: never throws; returns an FxRateTable or null.
 */

import {
	type FxFetch,
	type FxRateTable
} from '$indexer/fx/source';
import { fxGetJson, tableFromFlat } from '$indexer/fx/fetchUtil';

export interface FrankfurterConfig {
	/** Base URL. Default: https://api.frankfurter.dev/v1 */
	readonly baseUrl: string;
	readonly timeoutMs: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createFrankfurterFetcher(config: FrankfurterConfig): FxFetch {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const url = `${config.baseUrl.replace(/\/+$/, '')}/latest?base=USD`;
	return async function fetchFrankfurter(): Promise<FxRateTable | null> {
		const body = await fxGetJson(url, config.timeoutMs, fetchImpl);
		if (typeof body !== 'object' || body === null) return null;
		const base = (body as Record<string, unknown>).base;
		if (typeof base === 'string' && base.toUpperCase() !== 'USD') return null;
		return tableFromFlat((body as Record<string, unknown>).rates);
	};
}
