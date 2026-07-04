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

import { splitListingFeeBlurt } from '@morphit/asset-registry';

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

/** Fee-collection account of the CANONICAL instance, and the safe
 *  fallback when a federated operator hasn't configured their own (or
 *  configured a malformed one).  Public knowledge; owner/active keys are
 *  cold-stored by the Morphit maintainer. */
export const FEE_RECIPIENT = 'morphit-fees';

/** Blurt account-name shape — the project-canonical regex (cp175 F-007):
 *  3–16 chars, lowercase, leading letter, `[a-z0-9.-]` interior, ending
 *  alphanumeric. Byte-identical to every other account-name regex in the
 *  tree (blurt-account-regex-parity sentinel). */
const FEE_RECIPIENT_ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** cp407 — resolve which Blurt account a listing/feature/stranger fee is paid
 *  to. Federated operators earn 90% of BLURT fees and set their own account,
 *  advertised by their indexer at `/v1/instance.fee_recipient` (which the
 *  indexer has ALREADY validated + fallback-resolved). This just guards the
 *  edge case of an old/misconfigured indexer advertising an empty or malformed
 *  value: fall back to the canonical treasury so we never sign a transfer to a
 *  non-account (which the chain would reject). The frontend pays exactly what
 *  the operator's indexer verifies against, so fees and verification agree. */
export function resolveFeeRecipient(fromInstance: string | null | undefined): string {
	const trimmed = (fromInstance ?? '').trim();
	return FEE_RECIPIENT_ACCOUNT_RE.test(trimmed) ? trimmed : FEE_RECIPIENT;
}

/** A single BLURT transfer that makes up a listing/feature/stranger fee
 *  payment. All transfers for one fee share the same memo (applied by the
 *  caller), so the indexer can find every leg of the split. */
export interface FeeTransfer {
	readonly to: string;
	/** Graphene asset string, exactly 3 decimals: "N.NNN BLURT". */
	readonly amount: string;
}

/** Format an already-3-decimal BLURT amount as a Graphene asset string.
 *  Unlike `formatBlurtAmount` this does NOT round up — the split shares come
 *  out of `splitListingFeeBlurt` already at milliBLURT precision and must be
 *  emitted verbatim so the two legs sum back to the exact total. */
function exactBlurtString(amount: number): string {
	return `${amount.toFixed(3)} BLURT`;
}

/** cp408 — build the BLURT transfer(s) for a listing/feature/stranger fee,
 *  applying the federation revenue split AT PAYMENT TIME.
 *
 *  On a FEDERATION instance (the owner's recipient differs from the canonical
 *  treasury) the fee is paid as TWO transfers in the same transaction — 90% to
 *  the owner's account, 10% to the canonical treasury — so the canonical 10% is
 *  delivered directly by the user's wallet and nobody has to forward it later.
 *
 *  When the recipient IS the canonical treasury (the canonical instance, or a
 *  federation owner whose configured account was blank/invalid and fell back to
 *  canonical) both halves would land in the same account, so this collapses to
 *  a single 100% transfer. A share that would round below BLURT's milli
 *  precision also collapses to a single canonical transfer — we never sign a
 *  zero/dust transfer, and the canonical treasury never loses its cut.
 *
 *  `totalBlurt` is the raw fee amount; it is rounded UP to 3 decimals here
 *  (matching `formatBlurtAmount`, the amount the user actually pays) before the
 *  split, so the two legs sum to exactly what a single-transfer fee would be. */
export function feeTransfersFor(
	totalBlurt: number,
	ownerRecipient: string,
	canonicalTreasury: string = FEE_RECIPIENT
): FeeTransfer[] {
	const total = Math.ceil(totalBlurt * 1000) / 1000;
	if (ownerRecipient === canonicalTreasury) {
		return [{ to: canonicalTreasury, amount: exactBlurtString(total) }];
	}
	const { ownerShareBlurt, treasuryShareBlurt } = splitListingFeeBlurt(total);
	if (ownerShareBlurt <= 0 || treasuryShareBlurt <= 0) {
		return [{ to: canonicalTreasury, amount: exactBlurtString(total) }];
	}
	return [
		{ to: ownerRecipient, amount: exactBlurtString(ownerShareBlurt) },
		{ to: canonicalTreasury, amount: exactBlurtString(treasuryShareBlurt) }
	];
}

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
