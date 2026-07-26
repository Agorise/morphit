/**
 * Shared order-title builder.
 *
 * Produces the one canonical human sentence for an order —
 * "I'm buying 500 MXN or more worth of BLURT" — used identically on
 * the order-detail page, the orderbook cards, and the my/orders
 * cards.  Centralising it here keeps the wording (and its 10-locale
 * translations) in one place instead of three drifting copies.
 *
 * IMPORTANT — `amount_min` / `amount_max` are FIAT values (the order's
 * trade-size band, denominated in `fiat_currency`), NOT asset amounts.
 * This is verified in the indexer (`order.ts`: "amount_min is a fiat
 * value … denominated in [fiat]") and the asset-registry.  So the
 * sentence reads "<amount> <fiat> … worth of <asset>", never
 * "<amount> <asset>".
 *
 * The function returns an i18n key + interpolation values; the caller
 * renders it with `$_(parts.key, { values: parts.values })`.  The
 * caller passes its own number formatter so each surface keeps its
 * existing grouping/precision behaviour.
 */

import { isGoodsAsset, type AssetTicker } from '@morphit/asset-registry';

export interface OrderTitleInput {
	/** 'buy' | 'sell' — anything other than 'sell' is treated as buy. */
	readonly side: string;
	/** Asset ticker (BLURT, BTC, …). Never translated. */
	readonly asset: string;
	/** Fiat/quote currency code (MXN, USD, …) the amounts are in. */
	readonly fiat_currency: string;
	/** Minimum trade size, in fiat. null = no lower bound. */
	readonly amount_min: number | null;
	/** Maximum trade size, in fiat. null = no upper bound. */
	readonly amount_max: number | null;
	/** BARTER only — the accepted crypto ticker(s) the trade settles in. Used to
	 *  render the value-free barter title "I want to sell {goods} for {cryptos}"
	 *  (t.txt #5). Ignored for crypto assets and for barter listings that carry a
	 *  fiat value (those read "…{amount} {fiat} of {goods}" like any asset). */
	readonly accepted_assets?: readonly string[] | null;
}

export interface OrderTitleParts {
	/** i18n key, one of the eight `order_title.*` entries. */
	readonly key: string;
	/** Interpolation values for that key. */
	readonly values: Record<string, string | number>;
}

/**
 * Build the order-title i18n key + values.
 *
 * @param o    the order (side, asset, fiat, amount band)
 * @param fmt  number formatter for the fiat amounts (defaults to String)
 */
export function orderTitleParts(
	o: OrderTitleInput,
	fmt: (n: number) => string = (n) => String(n),
	goodsLabel?: string
): OrderTitleParts {
	const side = o.side === 'sell' ? 'sell' : 'buy';
	// cp425 — for a goods asset (BARTER) the sentence reads "…of goods/services"
	// (or the user's inline title) instead of "…of BARTER"; callers pass a
	// localized `goodsLabel`. Falls back to the raw ticker if none is provided
	// (e.g. a caller that hasn't been updated), so the title is always sensible.
	const isGoods = isGoodsAsset(o.asset as AssetTicker) && !!goodsLabel;
	const asset = isGoods ? (goodsLabel as string) : o.asset;
	const fiat = o.fiat_currency;
	const hasMin = o.amount_min !== null && o.amount_min !== undefined;
	const hasMax = o.amount_max !== null && o.amount_max !== undefined;

	// v1.8.9 — a range whose ends are equal is not a range. Pinning both bounds
	// to the same figure is a legitimate way to say "this exact amount", and the
	// generic branch rendered it "40–40 MXN worth of BLURT".
	if (hasMin && hasMax && o.amount_min === o.amount_max) {
		return {
			key: `order_title.${side}_exact`,
			values: { amount: fmt(o.amount_min as number), fiat, asset }
		};
	}
	if (hasMin && hasMax) {
		return {
			key: `order_title.${side}_range`,
			values: { min: fmt(o.amount_min as number), max: fmt(o.amount_max as number), fiat, asset }
		};
	}
	if (hasMin) {
		return {
			key: `order_title.${side}_min`,
			values: { amount: fmt(o.amount_min as number), fiat, asset }
		};
	}
	if (hasMax) {
		return {
			key: `order_title.${side}_max`,
			values: { amount: fmt(o.amount_max as number), fiat, asset }
		};
	}
	// t.txt #5 — a BARTER listing with no fiat value reads "I want to sell
	// {goods} for {cryptos}" (the accepted crypto), since there's no fiat band to
	// name and the crypto is what the trade settles in. Crypto assets and valued
	// barter never reach here. A barter with no accepted set falls through to the
	// generic *_any wording so the title is always sensible.
	if (isGoods && o.accepted_assets && o.accepted_assets.length > 0) {
		return {
			key: `order_title.${side}_barter_novalue`,
			values: { asset, cryptos: o.accepted_assets.join(', ') }
		};
	}
	// v1.8.9 — the no-amounts case used to render just "I'm buying BLURT",
	// dropping the fiat entirely: the least specific listing produced the least
	// informative title, exactly when a reader most needs to know what you'd pay
	// with. It now carries the fiat like every other branch.
	return { key: `order_title.${side}_any`, values: { asset, fiat } };
}
