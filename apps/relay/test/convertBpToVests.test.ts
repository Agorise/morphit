/**
 * Tests for BlurtClient.convertBpToVests — the BP → VESTS
 * conversion used when broadcasting delegations.
 *
 * After the Phase 5 prep pass, conversion is pure BigInt
 * arithmetic. Tests assert exact string outputs.
 */

import { describe, expect, it } from 'vitest';
import { BlurtClient } from '$blurt/client';
import { formatBigIntWithScale } from '$blurt/client';

function makeClient(): BlurtClient {
	// The constructor wants endpoints + fallback fee; we only
	// exercise methods that don't touch the network, so any valid
	// URLs work and the fallback fee value doesn't matter here.
	return new BlurtClient(['https://rpc.example.invalid'], 100);
}

describe('convertBpToVests — exact BigInt outputs', () => {
	it('simple 1:1000 ratio produces exactly 1000.000000 VESTS', () => {
		const c = makeClient();
		const result = c.convertBpToVests(1, {
			total_vesting_fund_blurt: '1.000 BLURT',
			total_vesting_shares: '1000.000000 VESTS'
		});
		expect(result).toBe('1000.000000 VESTS');
	});

	it('realistic Blurt DGP: 10 BP → 20.500101 VESTS (no float drift)', () => {
		// fund = 9876543210 milliblurt, shares = 20247014130923 microvests.
		// bp_scaled = 10 * 10^3 = 10000.
		// vests_base = (10000 * 20247014130923) / 9876543210 = 20500101
		// → "20.500101 VESTS"
		const c = makeClient();
		const result = c.convertBpToVests(10, {
			total_vesting_fund_blurt: '9876543.210 BLURT',
			total_vesting_shares: '20247014.130923 VESTS'
		});
		expect(result).toBe('20.500101 VESTS');
	});

	it('high-precision case: 1000 BP → 8000000.073700 VESTS', () => {
		const c = makeClient();
		const result = c.convertBpToVests(1000, {
			total_vesting_fund_blurt: '1234567.890 BLURT',
			total_vesting_shares: '9876543210.987654 VESTS'
		});
		expect(result).toBe('8000000.073700 VESTS');
	});

	it('ADR-0011 full milestone schedule with realistic ratios', () => {
		// Same DGP as "realistic" test; check all four milestone amounts.
		const c = makeClient();
		const vi = {
			total_vesting_fund_blurt: '9876543.210 BLURT',
			total_vesting_shares: '20247014.130923 VESTS'
		};
		// The ratio is ~2.05 VESTS per BP. Exact outputs (computed
		// fresh for each BP; the truncating integer division does
		// not distribute linearly over the BP multiplier, so these
		// are NOT simple multiples of the 10-BP result):
		expect(c.convertBpToVests(10, vi)).toBe('20.500101 VESTS');
		expect(c.convertBpToVests(50, vi)).toBe('102.500509 VESTS');
		expect(c.convertBpToVests(200, vi)).toBe('410.002036 VESTS');
		expect(c.convertBpToVests(1000, vi)).toBe('2050.010180 VESTS');
	});
});

describe('convertBpToVests — edge cases', () => {
	it('deterministic: same input → identical output (no float nondeterminism)', () => {
		const c = makeClient();
		const vi = {
			total_vesting_fund_blurt: '9876543.210 BLURT',
			total_vesting_shares: '20247014.130923 VESTS'
		};
		const first = c.convertBpToVests(1000, vi);
		for (let i = 0; i < 100; i++) {
			expect(c.convertBpToVests(1000, vi)).toBe(first);
		}
	});

	it('sub-microvest truncation: tiny BP below the division floor → "0.000000 VESTS"', () => {
		// A wildly extreme DGP: 10^15 BLURT in fund, 1 microvest in
		// shares. Tiny BP would produce sub-microvest quantity and
		// truncate to zero. Shouldn't happen on real Blurt but tests
		// the boundary.
		const c = makeClient();
		const result = c.convertBpToVests(0.001, {
			total_vesting_fund_blurt: '1000000000000000.000 BLURT',
			total_vesting_shares: '0.000001 VESTS'
		});
		expect(result).toBe('0.000000 VESTS');
	});

	it('result handles small integer part (< 10^scale)', () => {
		// bp=1, fund=1 BLURT, shares=0.000005 VESTS
		// → bp_scaled = 1000, shares.amount = 5, fund.amount = 1000
		// → vests_base = (1000 * 5) / 1000 = 5
		// → "0.000005 VESTS"
		const c = makeClient();
		const result = c.convertBpToVests(1, {
			total_vesting_fund_blurt: '1.000 BLURT',
			total_vesting_shares: '0.000005 VESTS'
		});
		expect(result).toBe('0.000005 VESTS');
	});
});

describe('convertBpToVests — input validation', () => {
	it('throws on unparseable fund string', () => {
		const c = makeClient();
		expect(() =>
			c.convertBpToVests(10, {
				total_vesting_fund_blurt: 'garbage',
				total_vesting_shares: '1000.000000 VESTS'
			})
		).toThrow(/unparseable/);
	});

	it('throws on unparseable shares string', () => {
		const c = makeClient();
		expect(() =>
			c.convertBpToVests(10, {
				total_vesting_fund_blurt: '100.000 BLURT',
				total_vesting_shares: 'not a vesting'
			})
		).toThrow(/unparseable/);
	});

	it('throws on zero fund amount (would divide by zero)', () => {
		const c = makeClient();
		expect(() =>
			c.convertBpToVests(10, {
				total_vesting_fund_blurt: '0.000 BLURT',
				total_vesting_shares: '1000.000000 VESTS'
			})
		).toThrow(/non-positive/);
	});

	it('throws on zero shares amount', () => {
		const c = makeClient();
		expect(() =>
			c.convertBpToVests(10, {
				total_vesting_fund_blurt: '100.000 BLURT',
				total_vesting_shares: '0.000000 VESTS'
			})
		).toThrow(/non-positive/);
	});

	it('throws on zero or negative BP', () => {
		const c = makeClient();
		const vi = {
			total_vesting_fund_blurt: '100.000 BLURT',
			total_vesting_shares: '1000.000000 VESTS'
		};
		expect(() => c.convertBpToVests(0, vi)).toThrow(/bp must be > 0/);
		expect(() => c.convertBpToVests(-10, vi)).toThrow(/bp must be > 0/);
	});
});

describe('formatBigIntWithScale', () => {
	it('trivial case with scale 0 returns integer string', () => {
		expect(formatBigIntWithScale(1234n, 0)).toBe('1234');
	});

	it('zero pads correctly for small amounts at higher scale', () => {
		// 5 microvests at scale 6 → "0.000005"
		expect(formatBigIntWithScale(5n, 6)).toBe('0.000005');
		// 123 at scale 6 → "0.000123"
		expect(formatBigIntWithScale(123n, 6)).toBe('0.000123');
	});

	it('large amounts place decimal point at correct offset', () => {
		// 1_234_567_890 at scale 3 → "1234567.890"
		expect(formatBigIntWithScale(1_234_567_890n, 3)).toBe('1234567.890');
		// 9_876_543_210_987_654 at scale 6 → "9876543210.987654"
		expect(formatBigIntWithScale(9_876_543_210_987_654n, 6)).toBe('9876543210.987654');
	});

	it('handles the boundary between integer and fractional parts', () => {
		// 1_000_000 at scale 6 → "1.000000"
		expect(formatBigIntWithScale(1_000_000n, 6)).toBe('1.000000');
		// 999_999 at scale 6 → "0.999999"
		expect(formatBigIntWithScale(999_999n, 6)).toBe('0.999999');
	});

	it('zero renders as 0.{scale zeros}', () => {
		expect(formatBigIntWithScale(0n, 3)).toBe('0.000');
		expect(formatBigIntWithScale(0n, 6)).toBe('0.000000');
	});

	it('handles negative BigInt amounts', () => {
		// Not used by convertBpToVests but the helper should be correct.
		expect(formatBigIntWithScale(-1_234_567n, 3)).toBe('-1234.567');
		expect(formatBigIntWithScale(-5n, 6)).toBe('-0.000005');
	});
});
