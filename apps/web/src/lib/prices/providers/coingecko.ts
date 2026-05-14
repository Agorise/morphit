/**
 * Coingecko BTC/XMR price provider.
 *
 * STATUS (2026-05-02): not currently wired into the live frontend.
 * `apps/web/src/lib/prices/index.ts` hardcodes `fallbackProvider`
 * pending the Phase-3 decision in ADR-0004 §"Phase 3 plan".  This
 * file is kept as a concrete, ready-to-wire reference of one of
 * the candidate Phase-3 providers (Option B: client-direct call to
 * a public price API).  Until Phase 3 lands, no production
 * surface invokes this code.
 *
 * Free-tier `/simple/price` endpoint: no API key required, ~10-30
 * req/min per IP. With Morphit's 5-minute refresh interval and a
 * single call per page load, the free tier is ample.
 *
 * Response shape (verified against Coingecko docs, and already
 * consumed by the indexer-side BLURT fetcher):
 *   GET /api/v3/simple/price?ids=bitcoin,monero&vs_currencies=usd
 *   → { "bitcoin": { "usd": 95000 }, "monero": { "usd": 180 } }
 *
 * BLURT is handled server-side by the indexer's composite price
 * source (klingex → coingecko → static floor) because fee-
 * verification needs a single canonical value. This frontend
 * provider is for the user-facing "how much USD is that BTC?"
 * estimation on the compose-order page and order cards.
 *
 * Failure mode: any network / shape / timeout error throws, and
 * the caller's composite wrapper falls through to the next
 * provider. We don't log here — logging is the caller's
 * responsibility since it has the context of which symbol was
 * being fetched and in service of which UI.
 */

import type { PriceProvider, PriceQuote, PricedSymbol } from '../types';

const COINGECKO_IDS: Record<PricedSymbol, string> = {
	BTC: 'bitcoin',
	XMR: 'monero',
	// BLURT is served by the indexer's price source, not the
	// frontend. If a caller asks for BLURT here, we ask Coingecko
	// anyway — CG does list BLURT — and let the caller wrap us in
	// its composite fallback chain.
	BLURT: 'blurt',
	// Part 121 — USDT pegs to USD by design.  Coingecko's
	// `tether` ID returns the live peg state; expected ~$1.00,
	// dips during peg-stress events.  The frontend order-row
	// subline reads this value so users see actual peg state
	// rather than an assumed $1.00.
	USDT: 'tether'
};

/** Max response body size from CoinGecko. Real responses are
 *  a few hundred bytes; 64KB is comfortably above legitimate
 *  values and comfortably below pathological. Defends against a
 *  hostile or compromised endpoint returning arbitrary bytes. */
const MAX_RESPONSE_BYTES = 64 * 1024;

const REQUEST_TIMEOUT_MS = 5_000;

export interface CoingeckoProviderConfig {
	/** Base URL without trailing slash. Defaults to the public
	 *  free-tier host; operators running paid-tier can point at
	 *  `https://pro-api.coingecko.com/api/v3` and pass an apiKey. */
	readonly baseUrl?: string;
	/** Optional paid-tier API key. Omit for free tier. */
	readonly apiKey?: string;
	/** fetch injection for tests. */
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createCoingeckoProvider(config: CoingeckoProviderConfig = {}): PriceProvider {
	const baseUrl = (config.baseUrl ?? 'https://api.coingecko.com/api/v3').replace(/\/+$/, '');
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;

	return {
		name: 'coingecko',
		async getPriceUsd(symbol: PricedSymbol): Promise<PriceQuote> {
			const id = COINGECKO_IDS[symbol];
			if (!id) {
				throw new Error(`coingecko: unsupported symbol ${symbol}`);
			}

			const url = `${baseUrl}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
			try {
				const headers: Record<string, string> = { accept: 'application/json' };
				if (config.apiKey) headers['x-cg-pro-api-key'] = config.apiKey;

				const res = await fetchImpl(url, {
					method: 'GET',
					headers,
					signal: ac.signal
				});
				if (!res.ok) {
					throw new Error(`coingecko: HTTP ${res.status}`);
				}
				// Audit 2026-05 hardening: cap response size before
				// parse to defend against a hostile or compromised
				// endpoint. Pre-flight Content-Length check + streaming
				// abort, mirroring federation-probe and bodyCap fixes.
				const contentLength = res.headers.get('content-length');
				if (contentLength !== null) {
					const declared = parseInt(contentLength, 10);
					if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
						throw new Error(
							`coingecko: response too large (declared ${declared} > cap ${MAX_RESPONSE_BYTES})`
						);
					}
				}
				const respBody = res.body;
				if (respBody === null) {
					throw new Error('coingecko: empty response body');
				}
				const reader = respBody.getReader();
				const chunks: Uint8Array[] = [];
				let total = 0;
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						if (value === undefined) continue;
						total += value.byteLength;
						if (total > MAX_RESPONSE_BYTES) {
							ac.abort();
							throw new Error(
								`coingecko: response exceeded cap (${total} > ${MAX_RESPONSE_BYTES})`
							);
						}
						chunks.push(value);
					}
				} finally {
					reader.releaseLock();
				}
				const buf = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					buf.set(chunk, offset);
					offset += chunk.byteLength;
				}
				const text = new TextDecoder('utf-8').decode(buf);
				const body = JSON.parse(text) as unknown;
				const usd = extractUsd(body, id);
				if (usd === null) {
					throw new Error(`coingecko: unexpected shape for ${id}`);
				}
				return {
					symbol,
					usd,
					fetchedAt: Date.now(),
					source: 'coingecko'
				};
			} finally {
				clearTimeout(timer);
			}
		}
	};
}

/** Extract the USD price from Coingecko's {id:{usd:N}} response. */
function extractUsd(body: unknown, id: string): number | null {
	if (typeof body !== 'object' || body === null) return null;
	const inner = (body as Record<string, unknown>)[id];
	if (typeof inner !== 'object' || inner === null) return null;
	const usd = (inner as Record<string, unknown>).usd;
	if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
	return usd;
}
