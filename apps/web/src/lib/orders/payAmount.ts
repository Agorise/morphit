/**
 * Pay-now amount pre-fill (cp406).
 *
 * Given an order, compute the CRYPTO amount a payer should send to cover the
 * order's fiat minimum, at the order's price. Used to seed (editable) the
 * "Pay now" modal so a non-technical user doesn't have to do the conversion.
 *
 * `amount_min` / `amount_max` on an order are FIAT values (denominated in
 * `fiat_currency`) — verified in the indexer and in orderTitle.ts, NOT asset
 * amounts. The `price_model` converts fiat ↔ crypto:
 *
 *   - { kind: 'fixed', price: P }   P is fiat-per-1-asset-unit (post form:
 *       "Fixed price per unit in fiat"). crypto = fiat / P. EXACT — needs no
 *       live data, so it never goes stale.
 *   - { kind: 'spread', percent: N } market-anchored (post form: "0 = exact
 *       market rate; +5 = market plus 5%"). The signed N already encodes the
 *       direction: effective USD/asset = marketUsd × (1 + N/100), so a higher
 *       price (larger N) yields fewer coins for the same fiat. crypto =
 *       fiatInUsd / effective. APPROXIMATE — depends on a live price.
 *   - anything else (custom / empty / legacy) — cannot be computed → null.
 *
 * Returns null whenever the amount can't be derived safely (no positive
 * amount_min, a non-positive fixed price, a market order with the FX table or
 * the live price unavailable, or an unrecognised price model). The caller
 * leaves the field blank + required in that case rather than seeding a guess —
 * this is a money field, so "blank" is always safer than "confidently wrong".
 *
 * Pure: the FX table and the live USD price are passed in, so this is fully
 * unit-testable from tsx without the network. Rounding for display is the
 * caller's concern; this returns the exact quotient.
 */

import type { OrderRecord, FxResponse } from '@morphit/indexer-client';
import { fiatToUsd } from './fx';

export interface PayAmountResult {
	/** Crypto units to send (raw, unrounded). */
	readonly amount: number;
	/** True when the value depends on a live market price (spread / market) and
	 *  is therefore an estimate; false for a deterministic fixed price. */
	readonly approximate: boolean;
}

export function computeOrderPayAmount(
	order: Pick<OrderRecord, 'price_model' | 'fiat_currency' | 'amount_min'>,
	fxTable: FxResponse | null,
	marketUsdPerAsset: number | null
): PayAmountResult | null {
	const fiatMin = order.amount_min;
	if (fiatMin === null || !Number.isFinite(fiatMin) || fiatMin <= 0) return null;

	const pm = order.price_model;
	if (!pm || typeof pm !== 'object') return null;
	const model = pm as Record<string, unknown>;

	// Fixed price: P fiat per 1 asset unit → crypto = fiat / P. Exact.
	if (model.kind === 'fixed' && typeof model.price === 'number') {
		const p = model.price;
		if (!Number.isFinite(p) || p <= 0) return null;
		const amount = fiatMin / p;
		if (!Number.isFinite(amount) || amount <= 0) return null;
		return { amount, approximate: false };
	}

	// Market / spread: needs FX (fiat→USD) + the live market USD price.
	if (model.kind === 'spread' && typeof model.percent === 'number') {
		const pct = model.percent;
		if (!Number.isFinite(pct)) return null;
		const usd = fiatToUsd(fxTable, fiatMin, order.fiat_currency);
		if (usd === null || !Number.isFinite(usd) || usd <= 0) return null;
		if (
			marketUsdPerAsset === null ||
			!Number.isFinite(marketUsdPerAsset) ||
			marketUsdPerAsset <= 0
		) {
			return null;
		}
		const effective = marketUsdPerAsset * (1 + pct / 100);
		if (!Number.isFinite(effective) || effective <= 0) return null;
		const amount = usd / effective;
		if (!Number.isFinite(amount) || amount <= 0) return null;
		return { amount, approximate: true };
	}

	// Custom / empty / unknown price model — can't compute.
	return null;
}
