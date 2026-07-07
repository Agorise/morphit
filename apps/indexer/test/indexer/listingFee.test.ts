import { describe, expect, it } from 'vitest';

// SKIPPED: this test file references `$indexer/listingFee`, a module
// that has been removed from the codebase (the listing-fee logic
// was either inlined elsewhere or replaced by a different mechanism
// — see git history if you need the old behavior).  Restore the
// module or delete this file before re-enabling.
//
// Originally tested:
//   - computeBaselineListingFee
//   - computeExpectedFee
//
// Tagged as a documented skip rather than deletion so the
// pre-launch test-suite audit (Part 47) has a clear "not silently
// dropped" trail.
describe.skip('listingFee (module removed)', () => {
	it('skipped — see file header', () => {
		expect(true).toBe(true);
	});
});

// Original test body retained below as a comment block for future
// restoration.  Do not uncomment without restoring the module.
/*
import {
	computeBaselineListingFee,
	computeExpectedFee,
	type ListingFeeConfig
} from '$indexer/listingFee';

const DEFAULT_CONFIG: ListingFeeConfig = {
	amortizationFactor: 0.5,
	operationalMarginBlurt: 25
};

describe('computeBaselineListingFee', () => {
	it('uses the formula: chain_fee × factor + margin', () => {
		// 100 BLURT chain fee × 0.5 + 25 = 75 BLURT.
		const q = computeBaselineListingFee(100, 0.002, DEFAULT_CONFIG);
		expect(q.baseFeeBlurt).toBe(75);
		// 75 BLURT × $0.002 = $0.15.
		expect(q.baseFeeUsd).toBeCloseTo(0.15, 6);
	});

	it('echoes inputs for auditability via /v1/listing-fee', () => {
		// The HTTP endpoint surfaces inputs so the frontend can
		// display "fee computed from X BLURT chain fee @ $Y" —
		// transparency for users wondering where a fee came from.
		const q = computeBaselineListingFee(100, 0.002, DEFAULT_CONFIG);
		expect(q.inputs.accountCreationFeeBlurt).toBe(100);
		expect(q.inputs.amortizationFactor).toBe(0.5);
		expect(q.inputs.operationalMarginBlurt).toBe(25);
		expect(q.inputs.blurtPriceUsd).toBe(0.002);
	});

	it('handles a zero chain fee (margin only)', () => {
		// If witnesses set account_creation_fee to 0 (hypothetical),
		// Morphit's listing fee is just the margin. No divide-by-zero
		// risk in the formula.
		const q = computeBaselineListingFee(0, 0.002, DEFAULT_CONFIG);
		expect(q.baseFeeBlurt).toBe(25);
	});

	it('handles non-integer amortization factors', () => {
		// If the operator prefers 0.25 (meaning 4 listings amortize
		// one ACT), the math still works cleanly.
		const q = computeBaselineListingFee(100, 0.002, {
			amortizationFactor: 0.25,
			operationalMarginBlurt: 25
		});
		expect(q.baseFeeBlurt).toBe(50); // 100 * 0.25 + 25
	});

	it('rejects negative chain fee', () => {
		// The chain itself should never report negative, but the
		// formula guards defensively.
		expect(() =>
			computeBaselineListingFee(-1, 0.002, DEFAULT_CONFIG)
		).toThrow(/accountCreationFeeBlurt/);
	});

	it('rejects zero or negative blurtPriceUsd', () => {
		// A zero price would cause divide-by-zero in downstream
		// fee->USD math (not in this function, but downstream);
		// fail fast here.
		expect(() =>
			computeBaselineListingFee(100, 0, DEFAULT_CONFIG)
		).toThrow(/blurtPriceUsd/);
		expect(() =>
			computeBaselineListingFee(100, -0.01, DEFAULT_CONFIG)
		).toThrow(/blurtPriceUsd/);
	});

	it('rejects negative config parameters', () => {
		expect(() =>
			computeBaselineListingFee(100, 0.002, {
				amortizationFactor: -0.1,
				operationalMarginBlurt: 25
			})
		).toThrow(/amortizationFactor/);
		expect(() =>
			computeBaselineListingFee(100, 0.002, {
				amortizationFactor: 0.5,
				operationalMarginBlurt: -5
			})
		).toThrow(/operationalMarginBlurt/);
	});
});

describe('computeExpectedFee', () => {
	const QUOTE = computeBaselineListingFee(100, 0.002, DEFAULT_CONFIG);
	// QUOTE.baseFeeBlurt === 75, QUOTE.baseFeeUsd ≈ 0.15.

	it('waived_first_buy returns 0 regardless of nth', () => {
		const f1 = computeExpectedFee(QUOTE, 'waived_first_buy', 1);
		const f5 = computeExpectedFee(QUOTE, 'waived_first_buy', 5);
		expect(f1).toEqual({ feeBlurt: 0, feeUsd: 0 });
		expect(f5).toEqual({ feeBlurt: 0, feeUsd: 0 });
	});

	it('BTC payments pay flat tier-1 regardless of nth', () => {
		// The Sybil escalation only applies to BLURT payments per
		// ADR-0011 §6. BTC payers don't get charged more for posting
		// many orders.
		const f1 = computeExpectedFee(QUOTE, 'btc', 1);
		const f10 = computeExpectedFee(QUOTE, 'btc', 10);
		expect(f1.feeBlurt).toBe(75);
		expect(f10.feeBlurt).toBe(75); // No escalation.
	});

	it('XMR payments pay flat tier-1 regardless of nth', () => {
		const f1 = computeExpectedFee(QUOTE, 'xmr', 1);
		const f10 = computeExpectedFee(QUOTE, 'xmr', 10);
		expect(f1.feeBlurt).toBe(75);
		expect(f10.feeBlurt).toBe(75);
	});

	it('BLURT tier-1 gets the 50% discount', () => {
		// Baseline 75 BLURT × tier-1 multiplier 1.0 × 0.5 discount = 37.5.
		const f = computeExpectedFee(QUOTE, 'blurt', 1);
		expect(f.feeBlurt).toBe(37.5);
		expect(f.feeUsd).toBeCloseTo(0.075, 6);
	});

	it('BLURT tier-4 gets tier multiplier AND 50% discount', () => {
		// Tier 4 is 1.25× per ADR-0009. So 75 × 1.25 × 0.5 = 46.875.
		const f = computeExpectedFee(QUOTE, 'blurt', 4);
		expect(f.feeBlurt).toBeCloseTo(46.875, 5);
	});

	it('BLURT tier-10 compounds correctly before discount', () => {
		// Tier 10 multiplier is 4.76837158203125 per ADR-0009.
		// 75 × 4.76837158203125 × 0.5 = 178.813...
		const f = computeExpectedFee(QUOTE, 'blurt', 10);
		expect(f.feeBlurt).toBeCloseTo(75 * 4.76837158203125 * 0.5, 5);
	});

	it('USD amount scales proportionally with BLURT amount', () => {
		// Invariant: feeUsd === feeBlurt × inputs.blurtPriceUsd.
		const f = computeExpectedFee(QUOTE, 'blurt', 3);
		expect(f.feeUsd).toBeCloseTo(
			f.feeBlurt * QUOTE.inputs.blurtPriceUsd,
			8
		);
	});
});
*/
