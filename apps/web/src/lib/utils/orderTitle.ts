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
	// cp425 — for a goods asset (BARTER) the sentence reads "worth of
	// goods/services" instead of "worth of BARTER"; callers pass a localized
	// `goodsLabel`. Falls back to the raw ticker if none is provided (e.g. a
	// caller that hasn't been updated), so the title is always sensible.
	const asset =
		isGoodsAsset(o.asset as AssetTicker) && goodsLabel ? goodsLabel : o.asset;
	const fiat = o.fiat_currency;
	const hasMin = o.amount_min !== null && o.amount_min !== undefined;
	const hasMax = o.amount_max !== null && o.amount_max !== undefined;

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
	return { key: `order_title.${side}_any`, values: { asset } };
}
