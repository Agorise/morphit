/**
 * Morphit indexer — Sybil fee multiplier.
 *
 * BLURT-native: fees are denominated directly in BLURT, not derived
 * from a USD anchor at verification time.  Both indexer and frontend
 * use the same `feeBaseBlurt × sybilMultiplier(nth)` formula; the
 * tolerance band absorbs floating-point rounding in the BLURT amount
 * formatting.
 *
 * NB (cp370): the canonical USD TARGET for the BLURT fee lives in
 * the canonical economics in `@morphit/asset-registry` (`LISTING_FEE_USD.blurt`,
 * ~12.5¢).  `feeBaseBlurt` is currently a fixed BLURT amount that
 * approximates that target at the reference price — verification is
 * still BLURT-native (no price feed, no TOCTOU window).  Making the
 * amount track the live price so it stays exactly on-target is the
 * deliberately-deferred live-tracking work: it would derive the base
 * from `listingFeeBlurtBase(blurtUsdPrice)` and widen the tolerance
 * to `FEE_PRICE_TOLERANCE` to absorb the quote→pay drift.  Until then
 * this comment, not the USD target, describes runtime behaviour.
 *
 * Tier schedule (per-account, rolling 24-hour window):
 *   tiers 1-3 (orders 1, 2, 3): 1.00×
 *   tier 4 (4th):   1.25×
 *   tier 5 (5th):   1.5625×
 *   tier 6 (6th):   1.953125×
 *   tier 7 (7th):   2.44140625×
 *   tier 8 (8th):   3.0517578125×
 *   tier 9 (9th):   3.814697265625×
 *   tier 10 (10th): 4.76837158203125×
 *   11+: compound 1.5× per additional order on tier-10's
 *
 * Tier escalation makes spammy posting expensive while leaving
 * normal users (1-3 listings/day) on the baseline rate.
 */

import { FEE_TREASURY_SHARE_BLURT } from '@morphit/asset-registry';

const MULTIPLIERS: readonly number[] = [
	1.0, 1.0, 1.0, 1.25, 1.5625, 1.953125, 2.44140625, 3.0517578125, 3.814697265625, 4.76837158203125
];

/** Compute the Sybil multiplier for the nth order in the 24h
 *  window (1-indexed). */
export function sybilMultiplier(nth: number): number {
	if (nth <= 0) return MULTIPLIERS[0]!;
	if (nth <= MULTIPLIERS.length) return MULTIPLIERS[nth - 1]!;
	const base = MULTIPLIERS[MULTIPLIERS.length - 1]!;
	const extras = nth - MULTIPLIERS.length;
	return base * Math.pow(1.5, extras);
}

/** Expected BLURT amount for the nth order. Same formula both
 *  sides compute; the tolerance band in config.feeTolerance
 *  absorbs floating-point rounding (Graphene serializes BLURT
 *  amounts at 3 decimal places, so multiplications can drift
 *  by a fractional millibBLURT). */
export function expectedFeeBlurt(nth: number, baseBlurt: number): number {
	if (baseBlurt <= 0) {
		throw new Error(`invalid baseBlurt: ${baseBlurt}`);
	}
	return baseBlurt * sybilMultiplier(nth);
}

/**
 * cp408 — tolerance on the canonical treasury's 10% split leg.
 *
 * The frontend rounds each leg of the fee to milliBLURT
 * (`splitListingFeeBlurt`), so the canonical share can land a
 * fraction of a milli below an exact 10%. This small band absorbs
 * that rounding. It is NOT the fee-underpaid band (that's the wider
 * price-drift tolerance applied to the fee TOTAL) — it only guards
 * the split PROPORTION, i.e. "did the canonical treasury actually
 * receive its ~10% cut of what was paid."
 */
export const FEE_SPLIT_TOLERANCE = 0.02;

/**
 * cp408 — did the canonical treasury receive its 10% cut?
 *
 * Federation instances split BLURT fees at payment time: 90% to the
 * instance owner, 10% to the canonical treasury. This checks that
 * the amount which actually reached the canonical treasury is at
 * least ~10% of the total paid. When the instance's own fee
 * recipient IS the canonical treasury (the canonical instance, or a
 * federation owner who fell back to it), the whole fee is the
 * canonical's, so `toCanonicalBlurt === totalBlurt` and this is
 * trivially satisfied.
 *
 * This is the enforcement that a federation instance cannot keep the
 * canonical 10%: an order whose fee skipped (or shorted) the
 * canonical leg fails verification and never becomes visible.
 */
export function canonicalShareOk(totalBlurt: number, toCanonicalBlurt: number): boolean {
	if (totalBlurt <= 0) return false;
	const required = totalBlurt * FEE_TREASURY_SHARE_BLURT * (1 - FEE_SPLIT_TOLERANCE);
	return toCanonicalBlurt >= required;
}

/**
 * cp408 — sum the sibling transfer(s) that paid a fee (listing, feature bid, or
 * stranger DM), honoring the payment-time federation split.
 *
 * A fee is one or two sibling transfers that share `expectedMemo`: the owner
 * leg (to `feeRecipient`) and the canonical leg (to `canonicalTreasury`).
 * Returns the total paid across both legs plus how much reached the canonical
 * treasury, or null if no matching transfer exists in the transaction.
 *
 * When `feeRecipient === canonicalTreasury` (the canonical instance, or a
 * federation owner who fell back to it) the `to === canonicalTreasury` test
 * runs first, so every matched leg counts as the canonical's and
 * `toCanonicalBlurt === totalBlurt`. A transfer carrying the fee memo but
 * addressed to some third account is ignored (defense against a decoy that
 * would pad the total without paying the canonical its cut).
 *
 * Malformed sibling ops are skipped (not errors). The returned total is always
 * a positive finite number by construction.
 */
export function sumFeeTransfers(
	siblingOps: readonly (readonly [string, Record<string, unknown>])[],
	signer: string,
	feeRecipient: string,
	canonicalTreasury: string,
	expectedMemo: string
): { totalBlurt: number; toCanonicalBlurt: number } | null {
	let toOwner = 0;
	let toCanonical = 0;
	let found = false;
	for (const op of siblingOps) {
		if (!op) continue;
		const [name, body] = op;
		if (name !== 'transfer') continue;
		const b = body as {
			from?: unknown;
			to?: unknown;
			amount?: unknown;
			memo?: unknown;
		};
		if (b.from !== signer) continue;
		if (b.memo !== expectedMemo) continue;
		const toCanonicalLeg = b.to === canonicalTreasury;
		const toOwnerLeg = b.to === feeRecipient;
		if (!toCanonicalLeg && !toOwnerLeg) continue;
		if (typeof b.amount !== 'string') continue;
		const match = /^(\d+(?:\.\d+)?)\s+BLURT$/.exec(b.amount);
		if (!match) continue;
		const amount = Number(match[1]);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		if (toCanonicalLeg) {
			toCanonical += amount;
		} else {
			toOwner += amount;
		}
		found = true;
	}
	if (!found) return null;
	return { totalBlurt: toOwner + toCanonical, toCanonicalBlurt: toCanonical };
}
