import { describe, expect, it } from 'vitest';

import {
	sybilMultiplier,
	expectedFeeBlurt,
	canonicalShareOk,
	sumFeeTransfers,
	FEE_SPLIT_TOLERANCE
} from '$indexer/fee';

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

// cp408 — payment-time federation split verification.
const CANON = 'morphit-fees';
const OWNER = 'community-op';
const SIGNER = 'alice';
const MEMO = 'morphit-fee:sell-btc-eur-2026-07';

function transfer(from: string, to: string, amount: string, memo: string) {
	return ['transfer', { from, to, amount, memo }] as const;
}

describe('canonicalShareOk', () => {
	it('accepts an exact 10% canonical cut', () => {
		expect(canonicalShareOk(60, 6)).toBe(true);
	});

	it('accepts the canonical case where the whole fee is the canonical share', () => {
		expect(canonicalShareOk(60, 60)).toBe(true);
	});

	it('accepts a canonical share a hair under 10% (within rounding tolerance)', () => {
		// 10% would be 6.0; allow down to 10% × (1 − FEE_SPLIT_TOLERANCE).
		const justUnder = 60 * 0.1 * (1 - FEE_SPLIT_TOLERANCE / 2);
		expect(canonicalShareOk(60, justUnder)).toBe(true);
	});

	it('rejects a missing canonical cut (0%) — the enforcement against skimming', () => {
		expect(canonicalShareOk(60, 0)).toBe(false);
	});

	it('rejects a canonical cut well below 10%', () => {
		expect(canonicalShareOk(60, 3)).toBe(false);
	});

	it('rejects a non-positive total', () => {
		expect(canonicalShareOk(0, 0)).toBe(false);
	});
});

describe('sumFeeTransfers', () => {
	it('sums a federation split (90% owner + 10% canonical)', () => {
		const ops = [
			transfer(SIGNER, OWNER, '54.000 BLURT', MEMO),
			transfer(SIGNER, CANON, '6.000 BLURT', MEMO)
		];
		const r = sumFeeTransfers(ops, SIGNER, OWNER, CANON, MEMO);
		expect(r).not.toBeNull();
		expect(r!.totalBlurt).toBeCloseTo(60, 6);
		expect(r!.toCanonicalBlurt).toBeCloseTo(6, 6);
		expect(canonicalShareOk(r!.totalBlurt, r!.toCanonicalBlurt)).toBe(true);
	});

	it('treats a single 100% transfer to canonical as fully canonical (owner === canonical)', () => {
		const ops = [transfer(SIGNER, CANON, '60.000 BLURT', MEMO)];
		const r = sumFeeTransfers(ops, SIGNER, CANON, CANON, MEMO);
		expect(r).not.toBeNull();
		expect(r!.totalBlurt).toBeCloseTo(60, 6);
		expect(r!.toCanonicalBlurt).toBeCloseTo(60, 6);
		expect(canonicalShareOk(r!.totalBlurt, r!.toCanonicalBlurt)).toBe(true);
	});

	it('flags a federation fee that skipped the canonical leg (100% to owner)', () => {
		const ops = [transfer(SIGNER, OWNER, '60.000 BLURT', MEMO)];
		const r = sumFeeTransfers(ops, SIGNER, OWNER, CANON, MEMO);
		expect(r).not.toBeNull();
		expect(r!.totalBlurt).toBeCloseTo(60, 6);
		expect(r!.toCanonicalBlurt).toBe(0);
		// The order handler rejects this: total is fine but canonical got nothing.
		expect(canonicalShareOk(r!.totalBlurt, r!.toCanonicalBlurt)).toBe(false);
	});

	it('ignores a decoy transfer to a third account carrying the fee memo', () => {
		const ops = [
			transfer(SIGNER, OWNER, '54.000 BLURT', MEMO),
			transfer(SIGNER, CANON, '6.000 BLURT', MEMO),
			transfer(SIGNER, 'attacker', '999.000 BLURT', MEMO)
		];
		const r = sumFeeTransfers(ops, SIGNER, OWNER, CANON, MEMO);
		expect(r!.totalBlurt).toBeCloseTo(60, 6);
		expect(r!.toCanonicalBlurt).toBeCloseTo(6, 6);
	});

	it('returns null when no transfer carries the fee memo', () => {
		const ops = [transfer(SIGNER, OWNER, '54.000 BLURT', 'morphit-fee:other-permlink')];
		expect(sumFeeTransfers(ops, SIGNER, OWNER, CANON, MEMO)).toBeNull();
	});

	it('ignores transfers not from the signer', () => {
		const ops = [
			transfer('mallory', OWNER, '54.000 BLURT', MEMO),
			transfer('mallory', CANON, '6.000 BLURT', MEMO)
		];
		expect(sumFeeTransfers(ops, SIGNER, OWNER, CANON, MEMO)).toBeNull();
	});

	it('skips malformed amounts but keeps well-formed legs', () => {
		const ops = [
			transfer(SIGNER, OWNER, 'not-an-amount', MEMO),
			transfer(SIGNER, CANON, '6.000 BLURT', MEMO)
		];
		const r = sumFeeTransfers(ops, SIGNER, OWNER, CANON, MEMO);
		expect(r).not.toBeNull();
		expect(r!.totalBlurt).toBeCloseTo(6, 6);
		expect(r!.toCanonicalBlurt).toBeCloseTo(6, 6);
	});
});
