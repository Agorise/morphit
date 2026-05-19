import type { AssetTicker } from '@morphit/asset-registry';
/**
 * Morphit — price feeds.
 *
 * Provider-swappable interface for USD prices of all 15 tradable
 * assets (BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH).
 * Phase 2 ships a hardcoded fallback as the default provider; Phase 3
 * adds on-chain oracle reads and/or a relay-based API provider.
 *
 * Consumers call `getPrice(symbol)` and get back a `PriceQuote`
 * carrying the price and the timestamp it was fetched. UI surfaces
 * the staleness as a "prices updated X ago" indicator.
 *
 * See `docs/adr/0004-price-feeds.md` for the full architectural
 * rationale.
 */

export type PricedSymbol = AssetTicker;

export interface PriceQuote {
	readonly symbol: PricedSymbol;
	/** USD per 1 unit of `symbol`. */
	readonly usd: number;
	/** Unix ms at which this quote was produced. */
	readonly fetchedAt: number;
	/** Identifier of the provider that produced this quote (e.g. "fallback",
	 *  "coingecko-coinmarketcap-avg", "blurt-oracle"). Surfaced in the UI. */
	readonly source: string;
}

export interface PriceProvider {
	readonly name: string;
	getPriceUsd(symbol: PricedSymbol): Promise<PriceQuote>;
}
