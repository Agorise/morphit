/**
 * Morphit — listing fee calculator.
 *
 * Pure function. No network, no side effects. Given:
 *   - the user's current Sybil-tier (how many orders they've
 *     posted in the last 24h, 1-indexed)
 * the fee calculator returns:
 *   - the multiplier applied to the base fee
 *   - the BLURT amount as a Graphene-conforming string
 *     ("N.NNN BLURT")
 *
 * Fees are denominated directly in BLURT — no live-USD
 * conversion at sign or verify time.  The frontend's quote and
 * the indexer's verification both use the same constants and
 * the same multiplier, so there's no drift window between
 * quote and broadcast.
 *
 * The optional USD echo for display ("60 BLURT (~$0.12)") is
 * fetched separately from /v1/listing-fee when the operator has
 * the price feed enabled.  See $lib/orders/listingFee.ts for
 * that path.
 */

/** Fallback BLURT base fee used when the indexer's reported
 *  rate is unavailable.  The compose page and the broadcast
 *  path read the operator's actual rate from
 *  `/v1/listing-fee.base_fee_blurt` and pass it into
 *  `computeFee()`; this constant is the bundled-in default
 *  matching MORPHIT_INDEXER_FEE_BASE_BLURT's default value, used
 *  only when the indexer fetch fails.  An operator who has
 *  changed their listing fee from the default will still cause
 *  fee_underpaid rejections on frontends that fall back to this
 *  constant — but those are recoverable (user retries) and the
 *  indexer's clear `fee_underpaid` status surfaces the issue. */
export const BASE_FEE_BLURT = 60;

/** Tolerance the indexer grants when verifying the fee amount.
 *  After the BLURT-native fee refactor this band only absorbs
 *  floating-point rounding (Graphene serializes BLURT amounts
 *  to 3 decimals; multiplications can introduce sub-millibBLURT
 *  drift).  Must match MORPHIT_INDEXER_FEE_TOLERANCE on the
 *  indexer. */
export const FEE_TOLERANCE = 0.001;

/** Fee-collection account.  This is where the transfer op
 *  sends the BLURT.  Public knowledge; owner/active keys are
 *  cold-stored by the Morphit maintainer. */
export const FEE_RECIPIENT = 'morphit-fees';

/**
 * Multiplier table.
 *
 * Index into this array with the number of orders the user
 * already has in their rolling 24h window. `tier0` means "no
 * orders yet in window"; the user is posting their 1st.
 *
 *   tier 0 (1st order):  1.00×
 *   tier 1 (2nd order):  1.00×
 *   tier 2 (3rd order):  1.00×
 *   tier 3 (4th order):  1.25×  (+25% from the 4th)
 *   tier 4 (5th order):  1.5625×
 *   tier 5 (6th order):  1.953125×
 *   tier 6 (7th order):  2.44140625×
 *   tier 7 (8th order):  3.0517578125×
 *   tier 8 (9th order):  3.814697265625×
 *   tier 9 (10th order): 4.76837158203125×
 *
 * From the 11th order on, +50% per additional compounds on top
 * of tier-9's 4.77×.
 */
const MULTIPLIERS: readonly number[] = [
	1.0,
	1.0,
	1.0, // orders 1-3
	1.25,
	1.5625,
	1.953125,
	2.44140625,
	3.0517578125,
	3.814697265625,
	4.76837158203125
];

/** Compute the Sybil multiplier for the nth order in the 24h
 *  window, where n is 1-indexed (1 = first, 2 = second, etc).
 *  For n >= 11, compound 1.5× per additional on tier-9. */
export function sybilMultiplier(nth: number): number {
	if (nth <= 0) return MULTIPLIERS[0]!;
	if (nth <= MULTIPLIERS.length) return MULTIPLIERS[nth - 1]!;
	const base = MULTIPLIERS[MULTIPLIERS.length - 1]!;
	const extras = nth - MULTIPLIERS.length;
	return base * Math.pow(1.5, extras);
}

/** Round a BLURT amount to 3 decimals and format as a Graphene
 *  asset string. Graphene accepts exactly 3 decimals for BLURT.
 *  We round UP at the 4th decimal so users slightly overpay
 *  rather than slightly underpay (the indexer's tolerance band
 *  absorbs the overpayment; underpayment would be rejected). */
export function formatBlurtAmount(amount: number): string {
	const rounded = Math.ceil(amount * 1000) / 1000;
	return `${rounded.toFixed(3)} BLURT`;
}

export interface FeeQuote {
	/** BLURT amount the user will actually transfer. */
	readonly blurtAmount: number;
	/** Same amount, as a "N.NNN BLURT" string ready for the
	 *  transfer op. */
	readonly blurtFormatted: string;
	/** Sybil multiplier applied. */
	readonly multiplier: number;
	/** 1-indexed position of this order in the user's 24h window. */
	readonly nth: number;
}

/** Compute the fee for the nth order (1-indexed).
 *
 *  `baseBlurt` is the operator's configured baseline fee per
 *  listing.  The compose page and the broadcast path read this
 *  from the indexer's `/v1/listing-fee` endpoint so the
 *  frontend stays in sync with the operator's actual rate even
 *  if it differs from the bundled `BASE_FEE_BLURT` default.
 *
 *  Pure arithmetic, instant, no async. */
export function computeFee(nth: number, baseBlurt: number): FeeQuote {
	if (!Number.isFinite(nth) || !Number.isInteger(nth) || nth < 1) {
		throw new Error(`Invalid nth (must be positive integer): ${nth}`);
	}
	if (!Number.isFinite(baseBlurt) || baseBlurt <= 0) {
		throw new Error(`Invalid baseBlurt (must be positive): ${baseBlurt}`);
	}
	const multiplier = sybilMultiplier(nth);
	const blurtAmount = baseBlurt * multiplier;
	return {
		blurtAmount,
		blurtFormatted: formatBlurtAmount(blurtAmount),
		multiplier,
		nth
	};
}

/** Format a permlink-bound memo for the fee transfer. Matches the
 *  format the indexer parses: `morphit-fee:<permlink>`. */
export function feeMemoFor(permlink: string): string {
	return `morphit-fee:${permlink}`;
}
