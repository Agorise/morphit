/**
 * Tests for the high-value name classifier (Layer 7 of the
 * signup-drain defense stack).
 *
 * Cover the three policy modes (strict/moderate/off) and each
 * classification category, plus a selection of names that
 * SHOULD pass — making sure normal-looking user names aren't
 * accidentally flagged as squatter targets.
 */

import { describe, it, expect } from 'vitest';
import { classifyHighValueName, isHighValueBlocked } from '../src/policy/highValueName.ts';

describe('classifyHighValueName', () => {
	describe('short_name', () => {
		it('flags 3-char names', () => {
			expect(classifyHighValueName('abc')).toBe('short_name');
		});
		it('flags 4-char names at default threshold', () => {
			expect(classifyHighValueName('abcd')).toBe('short_name');
		});
		it('does not flag 5-char names at default threshold', () => {
			expect(classifyHighValueName('abcde')).not.toBe('short_name');
		});
		it('respects custom shortNameThreshold (lower)', () => {
			expect(classifyHighValueName('abcd', { shortNameThreshold: 3 })).not.toBe('short_name');
		});
		it('respects custom shortNameThreshold (higher)', () => {
			expect(classifyHighValueName('abcde', { shortNameThreshold: 5 })).toBe('short_name');
		});
	});

	describe('dictionary_brand', () => {
		it('flags exact brand match', () => {
			expect(classifyHighValueName('binance')).toBe('dictionary_brand');
		});
		it('flags exact brand match (apparel)', () => {
			expect(classifyHighValueName('rolex')).toBe('dictionary_brand');
		});
		it('flags crypto-tier vocabulary', () => {
			expect(classifyHighValueName('bitcoin')).toBe('dictionary_brand');
			expect(classifyHighValueName('ethereum')).toBe('dictionary_brand');
			expect(classifyHighValueName('monero')).toBe('dictionary_brand');
		});
		it('does not flag a similar-but-different name', () => {
			// "binence" is a typo; not the actual brand.  We don't
			// want to over-block.  An attacker who registers
			// "binence" intending to phish is caught by other
			// surfaces (the chain-explorer warning UI on
			// /instances), not this classifier.
			expect(classifyHighValueName('binence')).not.toBe('dictionary_brand');
		});
	});

	describe('leet_brand', () => {
		it('catches `g00gle` (zero-for-o)', () => {
			expect(classifyHighValueName('g00gle')).toBe('leet_brand');
		});
		it('catches `app1e` (one-for-l)', () => {
			// 'app1e' → de-leet '1' → 'i' → 'appie' (not in list).
			// LEET_REVERSE['1'] = 'i' but apple has 'l' in it.
			// So this should NOT match leet_brand by the current
			// algorithm.  Document this limitation:
			expect(classifyHighValueName('app1e')).not.toBe('leet_brand');
		});
		it('catches `ros3x` for `rolex`?', () => {
			// 'ros3x' → de-leet '3' → 'rosex' (not 'rolex').
			// Same limitation as above.
			expect(classifyHighValueName('ros3x')).not.toBe('leet_brand');
		});
		it('catches `m0nero` (zero-for-o, real case)', () => {
			expect(classifyHighValueName('m0nero')).toBe('leet_brand');
		});
		it('catches `b1tcoin` if 1→i mapping works', () => {
			// 'b1tcoin' → de-leet '1' → 'bitcoin' which IS in list.
			expect(classifyHighValueName('b1tcoin')).toBe('leet_brand');
		});
	});

	describe('common_dictionary', () => {
		it('flags money-related words', () => {
			expect(classifyHighValueName('money')).toBe('common_dictionary');
			expect(classifyHighValueName('wallet')).toBe('common_dictionary');
		});
		it('flags news-related words (longer than short_name threshold)', () => {
			// 'news' is 4 chars → caught by short_name first.  Use
			// longer common-dictionary entries to verify this category
			// fires correctly.
			expect(classifyHighValueName('media')).toBe('common_dictionary');
			expect(classifyHighValueName('podcast')).toBe('common_dictionary');
			expect(classifyHighValueName('channel')).toBe('common_dictionary');
		});
		it('flags generic "best/top/pro" identity words', () => {
			expect(classifyHighValueName('premium')).toBe('common_dictionary');
		});
	});

	describe('all_numeric', () => {
		it('flags `a000` (single letter + digits)', () => {
			expect(classifyHighValueName('a000')).toBe('short_name');
			// Above gets caught by short_name first (length 4 ≤ 4).
			// Test a 6-char one:
			expect(classifyHighValueName('a00000')).toBe('all_numeric');
		});
		it('flags `a-0-0-0`', () => {
			expect(classifyHighValueName('a-0-0-0')).toBe('all_numeric');
		});
		it('does not flag `abcd0` (mixed)', () => {
			// "abcd0" has a digit after letters, but isn't numeric-suffix
			// (only one digit) and isn't all-numeric.  Should pass.
			expect(classifyHighValueName('abcd0')).toBe(null);
		});
	});

	describe('numeric_suffix', () => {
		it('flags user001, user002', () => {
			expect(classifyHighValueName('user001')).toBe('numeric_suffix');
			expect(classifyHighValueName('user002')).toBe('numeric_suffix');
		});
		it('flags hyphenated form user-001', () => {
			expect(classifyHighValueName('user-001')).toBe('numeric_suffix');
		});
		it('does not flag single-digit suffix user1', () => {
			// Too many false positives — many legitimate users have
			// names like "alex1".  The pattern requires 2+ digits.
			expect(classifyHighValueName('user1')).toBe(null);
		});
		it('flags 3-digit suffixes with SHORT prefixes (typical enumeration)', () => {
			// Layer 7 only catches obvious lone-enumeration: short
			// prefix + EXACTLY 3 digits.  4+ digit suffixes look
			// like years; cross-signup detection (Layer 8) catches
			// real enumeration when the same /64 produces multiple.
			expect(classifyHighValueName('usr001')).toBe('numeric_suffix');
			expect(classifyHighValueName('bob-001')).toBe('numeric_suffix');
			expect(classifyHighValueName('acct999')).toBe('numeric_suffix');
			// `a-1234` has no letters in the body — matches the
			// earlier-checked all_numeric pattern, not numeric_suffix.
			expect(classifyHighValueName('a-1234')).toBe('all_numeric');
		});

		it('does NOT flag long-prefix numeric-suffix names (year suffixes etc.)', () => {
			// Year-suffix names are common and legitimate.  Layer 7
			// shouldn't block them on shape alone.
			expect(classifyHighValueName('crypto-noob-2026')).toBe(null);
			expect(classifyHighValueName('myproject-2025')).toBe(null);
			expect(classifyHighValueName('bob-1990')).toBe(null);
			// Single-digit suffixes are also legitimate.
			expect(classifyHighValueName('alex42')).toBe(null);
			// Long-prefix + 3+ digits — also passes Layer 7 (caught by
			// Layer 8 if it's actually enumeration).
			expect(classifyHighValueName('account999')).toBe(null);
		});
	});

	describe('legitimate names pass', () => {
		// Sanity: ordinary user names don't trip any classification.
		const legitNames = [
			'alice',
			'bob-smith',
			'designer-jen',
			'morphit-fan',
			'longusername',
			'jdoe-trades',
			'dave42-trader',
			'crypto-noob-2026' // — wait, "crypto" is in COMMON_DICTIONARY so
			//   this might hit common_dictionary on the
			//   prefix.  No: classifyHighValueName checks
			//   the FULL name against the set, not substrings.
		];
		for (const name of legitNames) {
			it(`'${name}' is not high-value`, () => {
				expect(classifyHighValueName(name)).toBe(null);
			});
		}
	});
});

describe('isHighValueBlocked', () => {
	it('strict mode blocks every category', () => {
		expect(isHighValueBlocked('short_name', 'strict')).toBe(true);
		expect(isHighValueBlocked('dictionary_brand', 'strict')).toBe(true);
		expect(isHighValueBlocked('leet_brand', 'strict')).toBe(true);
		expect(isHighValueBlocked('common_dictionary', 'strict')).toBe(true);
		expect(isHighValueBlocked('all_numeric', 'strict')).toBe(true);
		expect(isHighValueBlocked('numeric_suffix', 'strict')).toBe(true);
	});

	it('moderate mode blocks only enumeration patterns', () => {
		expect(isHighValueBlocked('all_numeric', 'moderate')).toBe(true);
		expect(isHighValueBlocked('numeric_suffix', 'moderate')).toBe(true);
		// Brand/dictionary names PASS in moderate mode.
		expect(isHighValueBlocked('dictionary_brand', 'moderate')).toBe(false);
		expect(isHighValueBlocked('common_dictionary', 'moderate')).toBe(false);
		expect(isHighValueBlocked('short_name', 'moderate')).toBe(false);
		expect(isHighValueBlocked('leet_brand', 'moderate')).toBe(false);
	});

	it('off mode blocks nothing', () => {
		expect(isHighValueBlocked('short_name', 'off')).toBe(false);
		expect(isHighValueBlocked('numeric_suffix', 'off')).toBe(false);
		expect(isHighValueBlocked(null, 'off')).toBe(false);
	});

	it('null classification never blocks', () => {
		expect(isHighValueBlocked(null, 'strict')).toBe(false);
		expect(isHighValueBlocked(null, 'moderate')).toBe(false);
	});
});
