/**
 * What a coin is worth in an order's currency, and how much of a coin a fiat
 * amount is (v1.23.2). PURE — the caller brings the live USD price
 * (lib/prices: this instance's indexer) and the FX table (lib/orders/fx: the
 * same instance), so the browser asks no price service of its own.
 *
 * Used to fill in the pay and share-address windows: "Amount you ask to be
 * paid" for 11 BRL of BTC, the BLURT to send for 11 BRL, and the "(≈11 BRL)"
 * beside either.
 */
import type { FxResponse } from '@morphit/indexer-client';

import { usdToFiat } from './fx';

/** One coin in `fiat`, or null when the price or the rate is unknown. */
export function fiatPerCoin(
	usdPerCoin: number | null,
	fx: FxResponse | null,
	fiat: string
): number | null {
	if (usdPerCoin === null || !Number.isFinite(usdPerCoin) || usdPerCoin <= 0) return null;
	const v = usdToFiat(fx, usdPerCoin, fiat);
	return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/** `fiatAmount` of fiat in coins, rounded to the coin's `decimals`; null when
 *  it cannot be said (unknown price, nothing to pay, or less than one of the
 *  coin's smallest units). */
export function coinAmountForFiat(
	fiatAmount: number,
	fiatPerOneCoin: number | null,
	decimals: number
): number | null {
	if (fiatPerOneCoin === null || !Number.isFinite(fiatPerOneCoin) || fiatPerOneCoin <= 0) {
		return null;
	}
	if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) return null;
	const v = Number((fiatAmount / fiatPerOneCoin).toFixed(Math.max(0, Math.min(decimals, 12))));
	return Number.isFinite(v) && v > 0 ? v : null;
}
