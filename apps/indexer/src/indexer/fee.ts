/**
 * Morphit indexer — Sybil fee multiplier.
 *
 * BLURT-native: fees are denominated directly in BLURT, not derived
 * from a USD anchor at verification time.  Both indexer and frontend
 * use the same `feeBaseBlurt × sybilMultiplier(nth)` formula; the
 * tolerance band absorbs floating-point rounding in BLURT amount
 * formatting.
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
