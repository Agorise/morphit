import type { AssetTicker } from '@morphit/asset-registry';
/**
 * Morphit — price feeds.
 *
 * USD prices for the priced assets (BTC, XMR, BLURT, USDT, USDC, DAI, BCH,
 * LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP). Live prices come from
 * this instance's indexer (providers/indexer.ts), which today prices BLURT,
 * BTC and XMR; every other asset is "unknown".
 *
 * Consumers call `getPrice(symbol)` and get back a `PriceQuote` carrying the
 * price and the time it was read, or null when there is no live price.
 *
 * See `docs/adr/0004-price-feeds.md` for the full architectural
 * rationale.
 */

/**
 * The set of assets that HAVE a USD price. Goods assets (BARTER)
 * are excluded — a barter listing is valued directly in the seller's fiat
 * (no crypto-per-fiat rate), so it has no price-store slot. This is the type-level counterpart of the
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
	/** Identifier of the source that produced this quote ("indexer"). */
	readonly source: string;
}
