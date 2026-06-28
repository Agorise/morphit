/**
 * Shared helpers for FX provider fetchers.
 *
 * Reuses the price subsystem's hardened HTTP stack (priceFetchUtil:
 * 64 KiB body cap, `redirect: 'manual'`, named User-Agent) — an FX
 * table is a few KB, well under the cap.  This keeps a SINGLE
 * hardened-fetch implementation across both money-data subsystems
 * (no drift), and gives every FX fetcher the same SSRF-adjacent
 * protections for free.
 *
 * Each provider fetcher is a thin wrapper: build the base=USD URL,
 * call fxGetJson, then map the provider's response shape into an
 * FxRateTable via tableFromFlat.  Every fetcher honours the FxFetch
 * contract — returns a table or null, NEVER throws.
 */

import { logger } from '$log';
import {
	priceUpstreamFetchInit,
	priceUpstreamHeaders,
	readPriceBodyCapped
} from '$indexer/price/priceFetchUtil';
import type { FxRateTable } from '$indexer/fx/source';

const log = logger('fx-fetch');

/**
 * Hardened GET → parsed JSON, or null on any failure.  Never
 * throws.  Mirrors coingeckoFetcher's request handling (429/!ok/
 * capped-body/abort-on-timeout) so FX upstreams behave identically
 * to price upstreams.
 */
export async function fxGetJson(
	url: string,
	timeoutMs: number,
	fetchImpl: typeof globalThis.fetch
): Promise<unknown | null> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, {
			...priceUpstreamFetchInit(ac.signal),
			headers: priceUpstreamHeaders()
		});
		if (res.status === 429) {
			log.warn('rate_limited', { url });
			return null;
		}
		if (!res.ok) {
			log.warn('http_not_ok', { url, status: res.status });
			return null;
		}
		const text = await readPriceBodyCapped(res, ac, url);
		return JSON.parse(text) as unknown;
	} catch (err) {
		log.warn('fetch_error', { url }, err);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Build an FxRateTable from a flat `{ code: number }` rates object.
 * Filters out non-numeric / non-positive entries and uppercases
 * codes.  Returns null if the input isn't a usable object or yields
 * too few entries to be a real table (the composite re-checks
 * plausibility, but bailing early avoids committing junk).
 *
 * `assumeUsdBase` is informational — every provider we use is
 * queried with base=USD, so the values are already "units per USD".
 */
export function tableFromFlat(rawRates: unknown): FxRateTable | null {
	if (typeof rawRates !== 'object' || rawRates === null) return null;
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(rawRates as Record<string, unknown>)) {
		if (typeof k !== 'string') continue;
		const code = k.trim().toUpperCase();
		if (code.length < 2 || code.length > 8) continue;
		if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
		out[code] = v;
	}
	if (Object.keys(out).length === 0) return null;
	return { base: 'USD', rates: out };
}
