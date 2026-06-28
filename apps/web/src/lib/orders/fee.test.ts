import { describe, it, expect } from 'vitest';
import {
	sybilMultiplier,
	computeFee,
	formatBlurtAmount,
	BASE_FEE_BLURT,
	FEE_TOLERANCE
} from './fee';

/**
 * Sybil tier table is the single source of truth for fee
 * escalation. BOTH the frontend (this file) and the indexer
 * (apps/indexer/test/indexer/fee-schedule-parity.test.ts) assert
 * the same numbers. A drift between the two would cause every
 * fee transfer to fail verification — we'd rather fail the test.
 */
const TIER_TABLE: readonly { nth: number; mul: number }[] = [
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
	{ nth: 11, mul: 4.76837158203125 * 1.5 },
	{ nth: 15, mul: 4.76837158203125 * Math.pow(1.5, 5) }
];

describe('frontend Sybil tier schedule parity', () => {
	it('sybilMultiplier matches the canonical table', () => {
		for (const { nth, mul } of TIER_TABLE) {
			if (nth <= 10) {
				expect(sybilMultiplier(nth)).toBe(mul);
			} else {
				expect(sybilMultiplier(nth)).toBeCloseTo(mul, 10);
			}
		}
	});

	it('BASE_FEE_BLURT fallback default is 60 BLURT', () => {
		// Used as a fallback when the indexer's reported rate is
		// unavailable.  Must match MORPHIT_INDEXER_FEE_BASE_BLURT's
		// default on the indexer side.  Operators can change their
		// indexer's rate; the fallback is just for unreachable-
		// indexer cases (where the alternative is no fee math at
		// all).
		expect(BASE_FEE_BLURT).toBe(60);
	});

	it('FEE_TOLERANCE constant unchanged (display-side reference; indexer enforces FEE_PRICE_TOLERANCE under Model A)', () => {
		expect(FEE_TOLERANCE).toBe(0.001);
	});
});

describe('computeFee', () => {
	it('returns tier-1 fee for first 3 orders', () => {
		for (const nth of [1, 2, 3]) {
			const q = computeFee(nth, BASE_FEE_BLURT);
			expect(q.nth).toBe(nth);
			expect(q.multiplier).toBe(1.0);
			expect(q.blurtAmount).toBeCloseTo(60, 6);
		}
	});

	it('escalates on the 4th order', () => {
		const q = computeFee(4, BASE_FEE_BLURT);
		expect(q.multiplier).toBe(1.25);
		expect(q.blurtAmount).toBeCloseTo(75, 6);
	});

	it('honors operator-supplied base when different from default', () => {
		// An operator runs their indexer with feeBaseBlurt=80; the
		// frontend reads /v1/listing-fee, gets 80, and computes
		// against that.  Multiplier curve unchanged (protocol-
		// uniform).
		const q = computeFee(4, 80);
		expect(q.multiplier).toBe(1.25);
		expect(q.blurtAmount).toBeCloseTo(100, 6);
	});

	it('rejects non-positive base', () => {
		expect(() => computeFee(1, 0)).toThrow(/baseBlurt/);
		expect(() => computeFee(1, -1)).toThrow(/baseBlurt/);
		expect(() => computeFee(1, NaN)).toThrow(/baseBlurt/);
	});

	it('formats BLURT amount as Graphene-conforming "N.NNN BLURT"', () => {
		const q = computeFee(1, BASE_FEE_BLURT);
		expect(q.blurtFormatted).toMatch(/^\d+\.\d{3} BLURT$/);
	});

	it('rounds up at the 4th decimal (users slightly overpay)', () => {
		// Fee amount of exactly 60.0001 should round UP to 60.001,
		// not down to 60.000. The indexer's tolerance band absorbs
		// the overpayment; underpayment would be rejected.
		expect(formatBlurtAmount(60.0001)).toBe('60.001 BLURT');
		expect(formatBlurtAmount(60)).toBe('60.000 BLURT');
	});
});
