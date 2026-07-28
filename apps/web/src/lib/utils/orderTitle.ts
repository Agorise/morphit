/**
 * Shared order-title builder.
 *
 * Produces the one canonical human sentence for an order —
 * "I'm buying 500 MXN or more worth of BLURT for BTC or XMR" — used
 * identically on the order-detail page, the orderbook cards, the my/orders
 * cards, the chat RE: line, and the Blurt blog post (which just appends
 * "Want to trade?"). Centralising it here keeps the wording (and its
 * 10-locale translations) in one place instead of many drifting copies.
 *
 * IMPORTANT — `amount_min` / `amount_max` are FIAT values (the order's
 * trade-size band, denominated in `fiat_currency`), NOT asset amounts.
 * This is verified in the indexer (`order.ts`: "amount_min is a fiat
 * value … denominated in [fiat]") and the asset-registry.  So the
 * sentence reads "<amount> <fiat> … of <asset>", never "<amount> <asset>".
 *
 * SETTLEMENT (v1.9.5, Ken — tt.txt) — every order names what settles the
 * trade at the end of the sentence:
 *   • BARTER (goods) settles in CRYPTO → the `accepted_assets` tickers,
 *     shown verbatim ("… for BTC or XMR").
 *   • CRYPTO settles via the seller's `payment_methods` → their localized
 *     display labels ("… with Bank transfer or BTC"). Crypto-category
 *     methods label as their ticker, so a crypto-for-crypto order reads
 *     "… with BTC" exactly as Ken specified.
 * The preposition is baked into each key: a BUY that names a fiat amount
 * reads "… with {settlement}" (you pay WITH it); every SELL, and the
 * value-free barter BUY, reads "… for {settlement}" (in exchange FOR it).
 * The settlement list is rendered as a localized DISJUNCTION ("A or B",
 * "A, B, or C") via `formatDisjunction`.
 *
 * The function returns an i18n key + interpolation values; the caller
 * renders it with `$_(parts.key, { values: parts.values })`. The caller
 * passes its own number formatter, a `methodDisplay` mapper (usually
 * `displayNamesForMethods`) for crypto settlements, and the active locale
 * for disjunction formatting.
 */

import { isGoodsAsset, type AssetTicker } from '@morphit/asset-registry';
import { displayNamesForMethods } from '$lib/payments/display';

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
	/** BARTER settlement — the accepted crypto ticker(s) the goods trade
	 *  settles in. Required (non-empty) for a goods asset; omitted for crypto
	 *  assets (they settle via `payment_methods`). Rendered verbatim. */
	readonly accepted_assets?: readonly string[] | null;
	/** CRYPTO settlement — the payment-method id(s) the seller accepts. Present
	 *  for crypto assets; each id is mapped to a localized label via the
	 *  caller-supplied `methodDisplay` before rendering. */
	readonly payment_methods?: readonly string[] | null;
}

export interface OrderTitleOptions {
	/** Maps payment-method ids → localized display labels (crypto settlement).
	 *  Usually `$lib/payments/display`'s `displayNamesForMethods`. */
	readonly methodDisplay?: (methods: readonly string[]) => readonly string[];
	/** Active locale, for the settlement disjunction ("A or B" vs "A o B"). */
	readonly locale?: string;
}

export interface OrderTitleParts {
	/** i18n key, one of the twelve `order_title.*` entries. */
	readonly key: string;
	/** Interpolation values for that key. */
	readonly values: Record<string, string | number>;
}

/**
 * Format a settlement list as a localized DISJUNCTION: [] → "", ["BTC"] →
 * "BTC", ["BTC","XMR"] → "BTC or XMR", ["ETH","BCH","LTC"] → "ETH, BCH, or
 * LTC" (and the locale's own conjunction/commas elsewhere). Tickers + method
 * labels are never translated; only the joining structure localizes. Falls
 * back to a comma join if Intl.ListFormat is unavailable on the runtime.
 */
export function formatDisjunction(items: readonly string[], locale?: string): string {
	const list = items.filter((s) => s != null && String(s).length > 0);
	if (list.length === 0) return '';
	if (list.length === 1) return list[0] ?? '';
	try {
		return new Intl.ListFormat(locale || 'en', { type: 'disjunction' }).format(list);
	} catch {
		return list.join(', ');
	}
}

/** Resolve an order's settlement labels: barter → accepted crypto tickers
 *  (verbatim); crypto → payment-method labels via `methodDisplay`. */
function settlementLabels(
	o: OrderTitleInput,
	methodDisplay?: (m: readonly string[]) => readonly string[]
): readonly string[] {
	if (isGoodsAsset(o.asset as AssetTicker)) return o.accepted_assets ?? [];
	const methods = o.payment_methods ?? [];
	// Default to the shared (pure) payment-method label resolver, so crypto
	// settlements render proper names even from a caller that hasn't been
	// updated to pass one — only the disjunction locale still comes from opts.
	return (methodDisplay ?? displayNamesForMethods)(methods);
}

/**
 * Build the order-title i18n key + values.
 *
 * @param o          the order (side, asset, fiat, amount band, settlement)
 * @param fmt        number formatter for the fiat amounts (defaults to String)
 * @param goodsLabel localized goods label for BARTER (falls back to the ticker)
 * @param opts       methodDisplay (crypto settlement labels) + locale
 */
export function orderTitleParts(
	o: OrderTitleInput,
	fmt: (n: number) => string = (n) => String(n),
	goodsLabel?: string,
	opts?: OrderTitleOptions
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

	// v1.9.5 (Ken) — the settlement string every branch appends: the accepted
	// cryptos (barter) or the payment-method labels (crypto), as a localized
	// disjunction. Empty only for a malformed order (validation requires ≥1).
	const settlement = formatDisjunction(settlementLabels(o, opts?.methodDisplay), opts?.locale);

	// v1.8.9 — a range whose ends are equal is not a range. Pinning both bounds
	// to the same figure is a legitimate way to say "this exact amount", and the
	// generic branch rendered it "40–40 MXN worth of BLURT".
	if (hasMin && hasMax && o.amount_min === o.amount_max) {
		return {
			key: `order_title.${side}_exact`,
			values: { amount: fmt(o.amount_min as number), fiat, asset, settlement }
		};
	}
	if (hasMin && hasMax) {
		return {
			key: `order_title.${side}_range`,
			values: {
				min: fmt(o.amount_min as number),
				max: fmt(o.amount_max as number),
				fiat,
				asset,
				settlement
			}
		};
	}
	if (hasMin) {
		return {
			key: `order_title.${side}_min`,
			values: { amount: fmt(o.amount_min as number), fiat, asset, settlement }
		};
	}
	if (hasMax) {
		return {
			key: `order_title.${side}_max`,
			values: { amount: fmt(o.amount_max as number), fiat, asset, settlement }
		};
	}
	// tt.txt #5 — a BARTER listing with no fiat value reads "I'm buying {asset}
	// for {settlement}" (the accepted crypto), since there's no fiat band to name
	// and the crypto is what the trade settles in. Crypto assets and valued
	// barter never reach here. A barter with no accepted set falls through to the
	// generic *_any wording so the title is always sensible.
	if (isGoods && o.accepted_assets && o.accepted_assets.length > 0) {
		return {
			key: `order_title.${side}_barter_novalue`,
			values: { asset, settlement }
		};
	}
	// v1.8.9 — the no-amounts case used to render just "I'm buying BLURT",
	// dropping everything else: the least specific listing produced the least
	// informative title, exactly when a reader most needs to know what settles
	// it. It now names the settlement like every other branch.
	return { key: `order_title.${side}_any`, values: { asset, fiat, settlement } };
}
