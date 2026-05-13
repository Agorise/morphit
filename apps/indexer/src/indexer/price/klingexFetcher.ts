/**
 * Klingex BLURT/USDT price fetcher.
 *
 * Klingex (klingex.io) is the Blurt-community-run exchange and
 * Morphit's primary price oracle for BLURT. Preferred upstream
 * because:
 *   - Native to the Blurt ecosystem (no external dependency on
 *     Coingecko or similar)
 *   - Run by Agorise; lower "Morphit indirectly funds CG's
 *     infrastructure via API traffic" concerns
 *   - Typically free; no API key friction for self-hosted
 *     operators
 *
 * BLURT trades on Klingex as the BLURT/USDT pair; the live
 * orderbook / chart for operators wanting to sanity-check the
 * fetcher against a UI lives at:
 *
 *     https://klingex.io/trade/BLURT-USDT
 *
 * We treat USDT as approximately USD for display purposes —
 * Tether typically holds within ±0.5% of $1 and the USD echo on
 * Morphit is purely a display courtesy, not a settlement
 * reference. If USDT ever meaningfully de-pegs, operators can
 * disable the price feed (priceFeedEnabled=false) until the
 * situation stabilizes.
 *
 * (Historical note: Klingex used to be the secondary BLURT
 * exchange after ProBit. ProBit went out of business; Klingex is
 * now the only meaningful BLURT exchange and the BLURT/USDT pair
 * is the only liquid pair. We retain the BLURT/USD aliasing
 * because the Morphit codebase reasons about USD as the unit of
 * display.)
 *
 * ⚠ API SHAPE: This fetcher is written against the Klingex
 * public ticker endpoint. Operators running a fresh deploy
 * should verify the endpoint URL and response shape against the
 * current Klingex docs (klingex.io/docs) and open a bug if the
 * shape has drifted. The indexer treats a shape mismatch as a
 * transient failure (returns null), so the net effect is
 * falling back to the next upstream in the chain — never a
 * crash.
 *
 * Contract: never throws; returns a positive number on success,
 * null on any failure (network, shape, timeout, non-2xx).
 */

import { logger } from '$log';

const log = logger('price-klingex');

export interface KlingexConfig {
	/** Base URL for the Klingex public API. Without trailing slash.
	 *  Defaulted via MORPHIT_INDEXER_KLINGEX_BASE_URL or left to
	 *  the caller. */
	readonly baseUrl: string;
	/** Request timeout. 5 seconds is generous; the price source's
	 *  refresh interval is much longer so we can afford a modest
	 *  wait. */
	readonly timeoutMs: number;
	/** fetch implementation injection for tests. */
	readonly fetchImpl?: typeof globalThis.fetch;
}

/** Build a PriceFetch closure from Klingex config. */
export function createKlingexFetcher(config: KlingexConfig): () => Promise<number | null> {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	// BLURT_USDT is the only liquid Klingex pair for BLURT (post-
	// ProBit-shutdown). We use the USDT price as a proxy for USD;
	// see module header for rationale.
	const url = `${config.baseUrl.replace(/\/+$/, '')}/ticker/BLURT_USDT`;

	return async function fetchKlingex(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const res = await fetchImpl(url, {
				method: 'GET',
				headers: { accept: 'application/json' },
				signal: ac.signal
			});
			if (!res.ok) {
				log.warn('http_not_ok', { url, status: res.status });
				return null;
			}
			const body = (await res.json()) as unknown;
			const price = extractPrice(body);
			if (price === null) {
				log.warn('unexpected_shape', { url });
				return null;
			}
			return price;
		} catch (err) {
			log.warn('fetch_error', { url }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Extract BLURT/USDT (≈BLURT/USD) from a Klingex ticker response.
 *  Tries several common field names in case the API drifts. If
 *  none match, returns null — the caller treats that as an
 *  upstream failure. */
function extractPrice(body: unknown): number | null {
	if (typeof body !== 'object' || body === null) return null;
	const obj = body as Record<string, unknown>;

	// Common shapes to try, in priority order:
	//   { last: "0.002" } or { last: 0.002 }        — the most common
	//   { price: ... }                              — alternate
	//   { last_price: ... }                         — older exchanges
	//   { data: { last: ... } } or { ticker: ... } — wrapped
	const candidates: unknown[] = [
		obj.last,
		obj.price,
		obj.last_price,
		typeof obj.data === 'object' && obj.data !== null
			? (obj.data as Record<string, unknown>).last
			: undefined,
		typeof obj.ticker === 'object' && obj.ticker !== null
			? (obj.ticker as Record<string, unknown>).last
			: undefined
	];

	for (const v of candidates) {
		const n = parseNumericField(v);
		if (n !== null && n > 0) return n;
	}
	return null;
}

function parseNumericField(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string') {
		const n = parseFloat(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}
