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
	fetchImpl: typeof globalThis.fetch,
	opts?: { readonly followSameHostRedirect?: boolean }
): Promise<unknown | null> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		// redirect:'manual' ALWAYS. One FX upstream — currency-api on the
		// jsDelivr CDN — addresses its data via the `@latest` path, which
		// 302-redirects to the concrete dated version, so such an upstream
		// opts into following ONE redirect. It is followed here, by hand, and
		// only when its target is the same host: letting fetch follow and
		// checking the final URL afterwards meant a cross-host hop had already
		// been requested by the time it was rejected.
		const get = (u: string): Promise<Response> =>
			fetchImpl(u, { ...priceUpstreamFetchInit(ac.signal), headers: priceUpstreamHeaders() });
		let res = await get(url);
		if (opts?.followSameHostRedirect && res.status >= 300 && res.status < 400) {
			const next = sameHostRedirectTarget(url, res.headers.get('location'));
			await res.body?.cancel().catch(() => undefined);
			if (next === null) {
				log.warn('cross_host_redirect_rejected', { url });
				return null;
			}
			res = await get(next);
		}
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

/** The absolute target of a redirect from `from`, when it stays on the same
 *  host (and port) with the same scheme; null otherwise. PURE. */
export function sameHostRedirectTarget(from: string, location: string | null): string | null {
	if (location === null || location.length === 0) return null;
	try {
		const a = new URL(from);
		const b = new URL(location, a);
		return a.host === b.host && a.protocol === b.protocol ? b.toString() : null;
	} catch {
		return null;
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
