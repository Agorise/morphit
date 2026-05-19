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
	BLURT: 0.002,
	// Part 121 — USDT pegs to USD by design.  The fallback
	// returns exactly 1.00; when the peg breaks (2018, 2022
	// incidents) the live CoinGecko/Klingex provider returns
	// the actual depegged value and the order-row subline
	// surfaces it as "1 USDT = $0.97 live" instead of $1.00.
	USDT: 1.00,
	// Part 122 cp30 — USD Coin pegs to USD by design.  Same
	// fallback posture as USDT: exactly 1.00 hardcoded; live
	// providers surface the actual peg state during stress
	// events (USDC saw a brief depeg to ~$0.87 during the
	// March 2023 SVB incident — providers carry the live truth).
	USDC: 1.00,
	// Part 122 cp31 — Dai pegs to USD by design via overcollateralized
	// vaults + the Peg Stability Module.  Same hardcoded fallback as
	// USDT/USDC.  DAI's peg has held remarkably well historically
	// (briefly traded ~$0.97 during the March 2023 USDC depeg, which
	// transitively affected DAI through the PSM's USDC reserves).
	// Live providers surface the actual state during stress events.
	DAI: 1.00,
	// Part 122 cp21 — Bitcoin Cash.  Hardcoded fallback used
	// only when every live provider has failed and no value has
	// cached since boot.  Approximate live value at cp21 ship
	// time; rough order-of-magnitude is what matters for the
	// fallback — live providers are the canonical source.
	BCH: 400,
	// Part 122 cp24 — Litecoin.  Hardcoded fallback used only
	// when every live provider has failed and no value has
	// cached since boot.  Approximate live value at cp24 ship
	// time; rough order-of-magnitude is what matters for the
	// fallback — live providers are the canonical source.
	LTC: 100,
	// Part 122 cp27 — Dash.  Same posture as the other fallbacks:
	// rough order-of-magnitude only, used when live providers
	// have all failed.  Approximate live DASH/USD at cp27 ship time.
	DASH: 30,
	// Part 122 cp33 — Dogecoin.  Same posture as the other
	// fallbacks: rough order-of-magnitude only.  Approximate live
	// DOGE/USD at cp33 ship time (DOGE typically trades in the
	// sub-dollar range; cents-scale is its natural domain).
	DOGE: 0.1,
	// Part 122 cp39 — Zcash.  Same posture as the other fallbacks:
	// rough order-of-magnitude only, used when live providers
	// have all failed.  Approximate live ZEC/USD at cp39 ship time
	// (ZEC has trended in the $20–$50 range across 2024–2026).
	ZEC: 30,
	ARRR: 0.20,
	DCR: 20.00,
	SOL: 150.00,
	ETH: 2500.00
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
