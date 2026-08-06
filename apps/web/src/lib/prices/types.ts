import type { AssetTicker } from '@morphit/asset-registry';
/**
 * Morphit — price feeds.
 *
 * Provider-swappable interface for USD prices of all 16 tradable
 * assets (BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP).
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

/**
 * The set of assets that HAVE a USD price. cp425: goods assets (BARTER)
 * are excluded — a barter listing is valued directly in the seller's fiat
 * (no crypto-per-fiat rate), so it has no Coingecko slug, no fallback USD,
 * and no price-store slot. This is the type-level counterpart of the
 * registry's `isGoodsAsset()` predicate; every price map keyed by
 * `PricedSymbol` therefore correctly omits BARTER.
 */
export type PricedSymbol = Exclude<AssetTicker, 'BARTER'>;

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
