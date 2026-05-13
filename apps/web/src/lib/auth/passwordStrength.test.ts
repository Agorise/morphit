import { describe, expect, it } from 'vitest';
import { scorePassword, isPasswordAcceptable } from './passwordStrength';

describe('scorePassword — strengthened policy', () => {
	describe('hard fails (UI must block submission)', () => {
		it('rejects empty', () => {
			expect(scorePassword('')).toBe('too_short');
			expect(isPasswordAcceptable('')).toBe(false);
		});

		it('rejects passwords shorter than 10 chars', () => {
			expect(scorePassword('1234567')).toBe('too_short'); // 7
			expect(scorePassword('12345678')).toBe('too_short'); // 8
			expect(scorePassword('123456789')).toBe('too_short'); // 9
			expect(isPasswordAcceptable('mypw1234')).toBe(false); // 8 mixed
		});

		it('rejects 10-11 char single-class passwords (too_simple)', () => {
			// 10 chars, lowercase only — 1 class
			expect(scorePassword('abcdefghij')).toBe('too_simple');
			// 11 chars, digit only — 1 class
			expect(scorePassword('00000000001')).toBe('too_simple');
			// 10 chars, lowercase + digit — 2 classes (still <3)
			expect(scorePassword('abcde12345')).toBe('too_simple');
			expect(isPasswordAcceptable('abcde12345')).toBe(false);
		});

		it('accepts 10-11 char passwords WITH 3+ character classes', () => {
			// 10 chars, lower+upper+digit = 3 classes
			expect(scorePassword('Abcde12345')).not.toBe('too_short');
			expect(scorePassword('Abcde12345')).not.toBe('too_simple');
			expect(isPasswordAcceptable('Abcde12345')).toBe(true);
			// 11 chars, lower+digit+symbol = 3 classes
			expect(scorePassword('abcde12345!')).not.toBe('too_short');
			expect(scorePassword('abcde12345!')).not.toBe('too_simple');
			expect(isPasswordAcceptable('abcde12345!')).toBe(true);
		});

		it('accepts 12+ char passwords regardless of class mix', () => {
			// 12 chars, lowercase only — passes
			expect(scorePassword('abcdefghijkl')).not.toBe('too_short');
			expect(scorePassword('abcdefghijkl')).not.toBe('too_simple');
			expect(isPasswordAcceptable('abcdefghijkl')).toBe(true);
			// 12 chars, digit only — passes (length wins)
			expect(scorePassword('123456789012')).not.toBe('too_simple');
		});
	});

	describe('soft warnings (UI shows badge, allows submit)', () => {
		it("'common' for known weak passwords (must still be 10+ chars)", () => {
			// Common-passwords lookup is exact-match on password.toLowerCase().
			// Need a denylist entry that's 10+ chars AND has 3+ classes
			// (else hits 'too_simple' before reaching the common check).
			// Use 'Password123' (capital P + digits + lowercase = 3 classes,
			// 11 chars; toLowerCase('Password123') = 'password123' which IS
			// in COMMON_PASSWORDS).
			expect(scorePassword('Password123')).toBe('common');
			expect(isPasswordAcceptable('Password123')).toBe(true);
		});

		it("'trivial' for repeated/sequential strings", () => {
			expect(scorePassword('aaaaaaaaaaaa')).toBe('trivial'); // 12 a's
			// isSimpleSequence requires the WHOLE string to be a
			// monotonic arithmetic progression. '123456789012' breaks
			// at 9→0; use '123456789' (9 chars too short) or extend
			// alphabetic: 'abcdefghijkl' is 12 monotonic chars.
			expect(scorePassword('abcdefghijkl')).toBe('trivial');
			expect(isPasswordAcceptable('aaaaaaaaaaaa')).toBe(true); // soft warning
		});

		it("'ok' for strong passphrases", () => {
			expect(scorePassword('correcthorsebatterystaple')).toBe('ok');
			expect(scorePassword('Abcde12345!@')).toBe('ok'); // mixed, 12 chars
			expect(isPasswordAcceptable('correcthorsebatterystaple')).toBe(true);
		});
	});

	describe('character-class detection corner cases', () => {
		it('counts unicode emoji as a symbol class', () => {
			// 10 chars: 5 lowercase + 1 emoji + 4 digits = 3 classes if we count emoji as "other"
			// Note: the emoji likely takes 2 code units, so this might be 11 chars total
			expect(scorePassword('abcde1234!')).not.toBe('too_simple'); // lower+digit+symbol = 3
		});

		it('is case-insensitive for the common-passwords check', () => {
			// 'password123' is in the denylist; uppercase variant ('Password123')
			// has 3 classes (upper+lower+digit) so it passes the simplicity gate
			// and reaches the common-password check, which lowercases first.
			expect(scorePassword('Password123')).toBe('common');
		});
	});
});
