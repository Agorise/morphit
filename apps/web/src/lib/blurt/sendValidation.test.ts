import { describe, expect, it } from 'vitest';
import {
	validateBlurtAmount,
	MIN_BLURT,
	floorToBlurtPrecision,
	hasBlurtPrecision
} from './sendValidation';

const BAL = 3052.962;

describe('validateBlurtAmount', () => {
	it('accepts a normal amount', () => {
		expect(validateBlurtAmount('30', BAL)).toEqual({ precisionOk: true, valid: true });
	});

	it('accepts exactly 3 decimals', () => {
		expect(validateBlurtAmount('1.001', BAL).valid).toBe(true);
	});

	it('accepts the full balance (float epsilon)', () => {
		expect(validateBlurtAmount(BAL.toFixed(3), BAL).valid).toBe(true);
	});

	// The money bugs this exists to prevent.
	it('REJECTS 4 decimals that toFixed(3) would round UP (1.0006 -> 1.001)', () => {
		const r = validateBlurtAmount('1.0006', BAL);
		expect(r.precisionOk).toBe(false);
		expect(r.valid).toBe(false);
	});

	it('REJECTS a sub-precision amount that would serialise to 0.000 BLURT', () => {
		const r = validateBlurtAmount('0.0004', BAL);
		expect(r.precisionOk).toBe(false);
		expect(r.valid).toBe(false);
	});

	it('rejects anything below the minimum representable amount', () => {
		expect(validateBlurtAmount('0', BAL).valid).toBe(false);
		expect(validateBlurtAmount('0.000', BAL).valid).toBe(false);
		expect(validateBlurtAmount(String(MIN_BLURT), BAL).valid).toBe(true);
	});

	it('rejects more than the balance', () => {
		expect(validateBlurtAmount((BAL + 1).toFixed(3), BAL).valid).toBe(false);
	});

	// Shapes Number() accepts but a money field must not.
	it('rejects negatives, exponents, signs and whitespace-padded junk', () => {
		for (const bad of ['-1', '1e3', '+2', 'Infinity', 'NaN', '1,000', '1.2.3', 'abc', '.']) {
			const r = validateBlurtAmount(bad, BAL);
			expect(r.valid, `${bad} must be invalid`).toBe(false);
		}
		// '.' alone matches the shape regex but is not a finite number.
		expect(validateBlurtAmount('.', BAL).valid).toBe(false);
	});

	it('tolerates surrounding whitespace on an otherwise good amount', () => {
		expect(validateBlurtAmount('  12.5  ', BAL).valid).toBe(true);
	});

	it('an empty field is not valid (but is not a precision error)', () => {
		const r = validateBlurtAmount('', BAL);
		expect(r.precisionOk).toBe(true); // don't shout "too many decimals" at an empty box
		expect(r.valid).toBe(false);
	});

	it('a zero balance can never produce a valid amount', () => {
		expect(validateBlurtAmount('0.001', 0).valid).toBe(false);
	});
});

describe('floorToBlurtPrecision', () => {
	it('never exceeds the balance (the reason it floors rather than rounds)', () => {
		// toFixed(3) would give "12345.679" — MORE than the balance.
		expect(floorToBlurtPrecision(12345.6789)).toBe('12345.678');
		expect(Number(floorToBlurtPrecision(12345.6789))).toBeLessThanOrEqual(12345.6789);
	});

	it('round-trips an ordinary 3-decimal balance exactly', () => {
		expect(floorToBlurtPrecision(3052.962)).toBe('3052.962');
		expect(validateBlurtAmount(floorToBlurtPrecision(3052.962), 3052.962).valid).toBe(true);
	});

	it('whatever it produces is always accepted by validateBlurtAmount', () => {
		for (const bal of [3052.962, 1, 0.001, 999999.999, 12345.6789, 0.9999]) {
			const filled = floorToBlurtPrecision(bal);
			if (Number(filled) >= 0.001) {
				expect(validateBlurtAmount(filled, bal).valid, `balance ${bal} -> ${filled}`).toBe(true);
			}
		}
	});

	it('guards a zero / non-finite balance', () => {
		expect(floorToBlurtPrecision(0)).toBe('0.000');
		expect(floorToBlurtPrecision(NaN)).toBe('0.000');
		expect(floorToBlurtPrecision(-5)).toBe('0.000');
	});
});

describe('hasBlurtPrecision', () => {
	it('accepts amounts already on the 3-decimal grid', () => {
		for (const n of [1, 0.001, 30, 3052.962, 1.5]) expect(hasBlurtPrecision(n)).toBe(true);
	});

	it('rejects amounts formatBlurtAmount would silently round', () => {
		expect(hasBlurtPrecision(1.0006)).toBe(false);
		expect(hasBlurtPrecision(0.0004)).toBe(false);
	});

	it('tolerates float representation error rather than rejecting valid money', () => {
		expect(hasBlurtPrecision(28.515)).toBe(true);
		// 0.1 + 0.2 === 0.30000000000000004, but that IS 0.300 BLURT. Rejecting it
		// would block a perfectly legal amount because of IEEE-754, so the epsilon
		// is what makes this predicate usable on computed amounts.
		expect(hasBlurtPrecision(0.1 + 0.2)).toBe(true);
	});

	it('rejects non-finite', () => {
		expect(hasBlurtPrecision(NaN)).toBe(false);
		expect(hasBlurtPrecision(Infinity)).toBe(false);
	});
});
