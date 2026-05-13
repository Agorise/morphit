/**
 * Morphit — hardcoded-fallback price provider.
 *
 * The Phase 2 default. Returns a static price per symbol (documented
 * in Plan v1.3 and ADR-0004), with `fetchedAt` set to the moment the
 * call was made so the "updated X ago" indicator works as intended.
 *
 * This provider exists so that Phase 2 can ship a working `$lib/prices`
 * surface without any network dependency. Phase 3 adds real providers
 * (on-chain oracle and/or relay-API) that implement the same interface.
 *
 * Update the hardcoded values here when they drift >20% from real
 * market price, as a fallback-of-last-resort improvement. The real fix
 * is Phase 3.
 */

import type { PriceProvider, PriceQuote, PricedSymbol } from '../types';

/** Hardcoded USD prices, current as of Plan v1.3 authoring. */
const FALLBACK_USD: Record<PricedSymbol, number> = {
	BTC: 95_000,
	XMR: 180,
	BLURT: 0.002
};

export const fallbackProvider: PriceProvider = {
	name: 'fallback',
	async getPriceUsd(symbol: PricedSymbol): Promise<PriceQuote> {
		const usd = FALLBACK_USD[symbol];
		return {
			symbol,
			usd,
			fetchedAt: Date.now(),
			source: 'fallback'
		};
	}
};
