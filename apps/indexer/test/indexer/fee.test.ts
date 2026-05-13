import { describe, expect, it } from 'vitest';

import { sybilMultiplier, expectedFeeBlurt } from '$indexer/fee';

describe('sybilMultiplier', () => {
	it('is 1.0 for the first three orders', () => {
		expect(sybilMultiplier(1)).toBe(1.0);
		expect(sybilMultiplier(2)).toBe(1.0);
		expect(sybilMultiplier(3)).toBe(1.0);
	});

	it('jumps to 1.25 on the 4th order', () => {
		expect(sybilMultiplier(4)).toBe(1.25);
	});

	it('matches ADR-0009 §4 table for tiers 5-10', () => {
		expect(sybilMultiplier(5)).toBe(1.5625);
		expect(sybilMultiplier(6)).toBe(1.953125);
		expect(sybilMultiplier(7)).toBe(2.44140625);
		expect(sybilMultiplier(8)).toBe(3.0517578125);
		expect(sybilMultiplier(9)).toBe(3.814697265625);
		expect(sybilMultiplier(10)).toBe(4.76837158203125);
	});

	it('compounds 1.5× per additional order beyond the 10th', () => {
		const tier10 = sybilMultiplier(10);
		expect(sybilMultiplier(11)).toBeCloseTo(tier10 * 1.5, 10);
		expect(sybilMultiplier(12)).toBeCloseTo(tier10 * 1.5 * 1.5, 10);
		expect(sybilMultiplier(15)).toBeCloseTo(tier10 * Math.pow(1.5, 5), 10);
	});

	it('is monotonically non-decreasing across all integer tiers', () => {
		let prev = sybilMultiplier(1);
		for (let n = 2; n <= 30; n++) {
			const cur = sybilMultiplier(n);
			expect(cur).toBeGreaterThanOrEqual(prev);
			prev = cur;
		}
	});

	it('treats zero or negative tiers as tier 1', () => {
		expect(sybilMultiplier(0)).toBe(1.0);
		expect(sybilMultiplier(-5)).toBe(1.0);
	});
});

describe('expectedFeeBlurt', () => {
	// §F.11: signature changed from (nth, baseUsd, blurtPriceUsd) →
	// (nth, baseBlurt).  The function no longer consults a USD price
	// feed; the operator configures a BLURT-denominated base fee
	// directly and the multiplier scales it.
	it('returns base for tier 1 (no multiplier)', () => {
		expect(expectedFeeBlurt(1, 60)).toBe(60);
	});

	it('applies the multiplier for higher tiers', () => {
		// Tier 4: 60 BLURT × 1.25 = 75 BLURT.
		expect(expectedFeeBlurt(4, 60)).toBeCloseTo(75, 6);
	});

	it('throws on non-positive base', () => {
		expect(() => expectedFeeBlurt(1, 0)).toThrow(/baseBlurt/);
		expect(() => expectedFeeBlurt(1, -10)).toThrow(/baseBlurt/);
	});
});
