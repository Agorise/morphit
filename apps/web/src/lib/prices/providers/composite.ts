/**
 * Composite price provider — chains upstream providers with
 * per-symbol caching.
 *
 * STATUS (2026-05-02): not currently wired into the live frontend.
 * `apps/web/src/lib/prices/index.ts` hardcodes `fallbackProvider`
 * pending the Phase-3 decision in ADR-0004 §"Phase 3 plan".  This
 * file is the chaining wrapper that Phase 3 would use to combine
 * upstream providers (e.g. Coingecko + a relay-side proxy).  Until
 * Phase 3 lands, no production surface invokes this code.
 *
 * Usage:
 *   const provider = createCompositeProvider({
 *     upstreams: [createCoingeckoProvider(), fallbackProvider],
 *     cacheTtlMs: 5 * 60 * 1000
 *   });
 *   const btc = await provider.getPriceUsd('BTC');
 *
 * Semantics:
 *   - First upstream to return a valid quote wins. Later
 *     upstreams are not called.
 *   - Successful responses are cached per-symbol for cacheTtlMs.
 *     Subsequent calls within TTL return the cached quote with
 *     its original `fetchedAt` (NOT refreshed) so the UI's
 *     "prices updated X ago" indicator stays honest.
 *   - When all upstreams fail and no cache is available, we
 *     propagate the last error. The caller is expected to have
 *     the fallback provider as the last link in the chain, so
 *     this failure path should be unreachable in practice.
 */

import type { PriceProvider, PriceQuote, PricedSymbol } from '../types';

export interface CompositeProviderConfig {
	/** Providers in priority order. First to return a valid quote
	 *  wins. Last should generally be the static fallback so we
	 *  never actually throw through to the UI. */
	readonly upstreams: readonly PriceProvider[];
	/** How long a successful quote is considered fresh, in ms.
	 *  Default 5 minutes. */
	readonly cacheTtlMs?: number;
}

interface CacheEntry {
	quote: PriceQuote;
	expiresAt: number;
}

export function createCompositeProvider(config: CompositeProviderConfig): PriceProvider {
	if (config.upstreams.length === 0) {
		throw new Error('CompositeProvider requires at least one upstream');
	}
	const ttl = config.cacheTtlMs ?? 5 * 60 * 1000;
	const cache = new Map<PricedSymbol, CacheEntry>();

	return {
		name: 'composite',
		async getPriceUsd(symbol: PricedSymbol): Promise<PriceQuote> {
			// Cache hit?
			const cached = cache.get(symbol);
			if (cached && cached.expiresAt > Date.now()) {
				return cached.quote;
			}

			let lastError: unknown = null;
			for (const upstream of config.upstreams) {
				try {
					const quote = await upstream.getPriceUsd(symbol);
					if (
						quote &&
						typeof quote.usd === 'number' &&
						Number.isFinite(quote.usd) &&
						quote.usd > 0
					) {
						cache.set(symbol, {
							quote,
							expiresAt: Date.now() + ttl
						});
						return quote;
					}
				} catch (err) {
					lastError = err;
					// Fall through to next upstream.
				}
			}

			// Last-ditch: if we have a stale cached entry, serve it
			// rather than throwing. A slightly-stale price is far
			// better than a blank UI.
			if (cached) return cached.quote;

			throw lastError ?? new Error('composite: all upstreams failed');
		}
	};
}
