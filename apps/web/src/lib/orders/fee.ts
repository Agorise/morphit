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
 * Fees are denominated in BLURT, and VERIFICATION is BLURT-native
 * — the indexer checks the paid BLURT against `feeBaseBlurt × mult`
 * with no price read, so there's no TOCTOU window between quote and
 * broadcast.  What the UI QUOTES, though, tracks the live USD value
 * (Model A, cp372): `/v1/listing-fee.base_fee_blurt` is the operator's
 * USD-equivalent fee re-priced at the live BLURT/USD rate, so the
 * fee's dollar value stays put instead of drifting as a fixed BLURT
 * constant.  The verifier grants a FEE_PRICE_TOLERANCE band so a user
 * paying the live-quoted amount isn't rejected as that quote drifts
 * from the operator's pinned base between re-tunes.
 *
 * NB (cp370 → cp372): the canonical USD target (~12.5¢) lives in
 * `@morphit/asset-registry` (`LISTING_FEE_USD.blurt`).  `BASE_FEE_BLURT`
 * below is a fixed fallback approximating it at the reference price,
 * used only when the `/v1/listing-fee` fetch fails; the live amount
 * (operator's USD fee at the current rate) is fetched from
 * `/v1/listing-fee.base_fee_blurt`, with `base_fee_blurt_live` telling
 * the client whether that amount is the live figure or the fallback.
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

/** Display-side reference for the indexer's fee-acceptance band.
 *  Pre-cp372 this was the tight FP-rounding tolerance (0.1%).  Under
 *  Model A the indexer accepts a payment within FEE_PRICE_TOLERANCE
 *  (15%, in @morphit/asset-registry) below the pinned base, to absorb
 *  the drift between the live-quoted amount and the operator's pinned
 *  base.  This constant is informational only — the frontend does NOT
 *  enforce a tolerance (the indexer is the authority); it's kept for
 *  reference + the doc test.  See the indexer order handler. */
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
