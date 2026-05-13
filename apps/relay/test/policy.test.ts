import { describe, expect, it } from 'vitest';
import { validateBlurtName, isReserved } from '../src/policy/name.ts';

describe('validateBlurtName', () => {
	const cases: Array<[string, string, string]> = [
		// Happy path
		['typical', 'sally', 'ok'],
		['minimum length', 'abc', 'ok'],
		['maximum length', 'abcdefghijklmnop', 'ok'],
		['with digits', 'sally123', 'ok'],
		['with internal dash', 'sally-doe', 'ok'],
		['mixed digits letters dashes', 'alice-42-b', 'ok'],

		// Length
		['too short: 2 chars', 'ab', 'too_short'],
		['too short: empty', '', 'too_short'],
		['too long: 17 chars', 'abcdefghijklmnopq', 'too_long'],

		// Must start with letter
		['starts with digit', '3sally', 'must_start_with_letter'],
		['starts with dash', '-sally', 'must_start_with_letter'],

		// Leading/trailing dash
		['ends with dash', 'sally-', 'leading_trailing_dash'],

		// Consecutive dashes
		['consecutive dashes', 'sa--lly', 'consecutive_dashes'],
		['triple dashes', 's---a', 'consecutive_dashes'],

		// Bad chars
		['uppercase', 'Sally', 'must_start_with_letter'],
		['space', 'sal ly', 'bad_chars'],
		['underscore', 'sal_ly', 'bad_chars'],
		['emoji', 'sally🙂', 'bad_chars'],
		['cyrillic a', 'sаlly', 'bad_chars'],

		// Dots
		['dotted', 'sally.witness', 'dotted_not_allowed'],

		// Reserved
		['reserved morphit', 'morphit', 'reserved'],
		['reserved morphit-relay', 'morphit-relay', 'reserved'],
		['reserved agorise', 'agorise', 'reserved'],
		['reserved admin', 'admin', 'reserved']
	];

	it.each(cases)('%s → %s for %s', (_desc, input, expected) => {
		expect(validateBlurtName(input)).toBe(expected);
	});
});

describe('isReserved', () => {
	it('identifies reserved names', () => {
		expect(isReserved('morphit')).toBe(true);
		expect(isReserved('morphit-relay')).toBe(true);
		expect(isReserved('agorise')).toBe(true);
	});

	it('does not flag normal names', () => {
		expect(isReserved('sally')).toBe(false);
		expect(isReserved('alice')).toBe(false);
	});
});
