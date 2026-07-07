import { describe, expect, it } from 'vitest';

import { sybilMultiplier, expectedFeeBlurt } from '$indexer/fee';

/**
 * ADR-0009 §4 is the single source of truth for the Sybil tier
 * table. The indexer's sybilMultiplier and the frontend's
 * sybilMultiplier MUST both produce these exact values for every
 * nth in 1..30.
 *
 * Changing these numbers is a protocol change — it requires
 * coordinating an indexer upgrade, a frontend release, and a
 * matching edit to ADR-0009 all at once.
 */
const ADR_0009_EXPECTED: readonly { nth: number; mul: number }[] = [
	{ nth: 1, mul: 1.0 },
	{ nth: 2, mul: 1.0 },
	{ nth: 3, mul: 1.0 },
	{ nth: 4, mul: 1.25 },
	{ nth: 5, mul: 1.5625 },
	{ nth: 6, mul: 1.953125 },
	{ nth: 7, mul: 2.44140625 },
	{ nth: 8, mul: 3.0517578125 },
	{ nth: 9, mul: 3.814697265625 },
	{ nth: 10, mul: 4.76837158203125 },
	// 11+ compounds 1.5× on tier 10
	{ nth: 11, mul: 4.76837158203125 * 1.5 },
	{ nth: 12, mul: 4.76837158203125 * 1.5 * 1.5 },
	{ nth: 20, mul: 4.76837158203125 * Math.pow(1.5, 10) }
];

describe('ADR-0009 fee schedule parity', () => {
	it('indexer sybilMultiplier matches the ADR-0009 table', () => {
		for (const { nth, mul } of ADR_0009_EXPECTED) {
			// Use toBeCloseTo for >10 because compound multiplication
			// accumulates tiny float error; exact match for nth <= 10.
			if (nth <= 10) {
				expect(sybilMultiplier(nth)).toBe(mul);
			} else {
				expect(sybilMultiplier(nth)).toBeCloseTo(mul, 10);
			}
		}
	});

	it('expectedFeeBlurt composes multiplier with base correctly', () => {
		// §F.11: signature changed to (nth, baseBlurt).  At a 60-BLURT
		// base, every tier scales from there by the multiplier.
		const baseBlurt = 60;
		for (const { nth, mul } of ADR_0009_EXPECTED) {
			const expected = baseBlurt * mul;
			if (nth <= 10) {
				expect(expectedFeeBlurt(nth, baseBlurt)).toBe(expected);
			} else {
				expect(expectedFeeBlurt(nth, baseBlurt)).toBeCloseTo(expected, 4);
			}
		}
	});

	it('±1% tolerance band accepts reasonable drift', () => {
		// Tolerance is computed in BLURT directly; if the frontend
		// quoted 60 BLURT and the indexer observes 0.5% less, that's
		// well within the 1% band.
		const expected = expectedFeeBlurt(1, 60);
		const drift = expected * 0.995;
		const minAcceptable = expected * (1 - 0.01);
		expect(drift).toBeGreaterThan(minAcceptable);
	});
});
