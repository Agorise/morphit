import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, escapeLike, isAccountName } from '$api/shared';

describe('isAccountName', () => {
	it('accepts well-formed names', () => {
		for (const ok of ['alice', 'sally-doe', 'xyz', 'a12-34-56']) {
			expect(isAccountName(ok)).toBe(true);
		}
	});

	it('rejects names starting with non-letter', () => {
		expect(isAccountName('1alice')).toBe(false);
		expect(isAccountName('-alice')).toBe(false);
	});

	it('rejects names with invalid charset', () => {
		expect(isAccountName('Alice')).toBe(false); // caps
		expect(isAccountName('alice_doe')).toBe(false); // underscore
		expect(isAccountName('alice/doe')).toBe(false); // slash
		expect(isAccountName('alice doe')).toBe(false); // space
	});

	it('accepts names with dots (Blurt allows dotted segment names)', () => {
		// Per Steem/Hive/Blurt convention, dotted account names like
		// `alice.morphit` are valid (often used for service-account
		// hierarchies).  isAccountName admits them.
		expect(isAccountName('alice.doe')).toBe(true);
	});

	it('rejects too-short and too-long names', () => {
		expect(isAccountName('ab')).toBe(false); // 2 chars
		expect(isAccountName('a' + '1'.repeat(16))).toBe(false); // 17 chars
	});

	it('rejects non-string input', () => {
		expect(isAccountName(null)).toBe(false);
		expect(isAccountName(123)).toBe(false);
		expect(isAccountName(undefined)).toBe(false);
	});
});

describe('cursor codec', () => {
	it('round-trips a simple object', () => {
		const obj = { u: '2026-04-19T12:00:00Z', a: 'alice', p: 'sell-1' };
		const encoded = encodeCursor(obj);
		const decoded = decodeCursor(encoded);
		expect(decoded).toEqual(obj);
	});

	it('round-trips nested data', () => {
		const obj = { c: '2026-04-19T12:00:00Z', i: 42 };
		expect(decodeCursor(encodeCursor(obj))).toEqual(obj);
	});

	it('returns null on malformed base64', () => {
		expect(decodeCursor('not a cursor')).toBeNull();
	});

	it('returns null on invalid JSON after decode', () => {
		// Valid base64 of a string that's not JSON.
		const bad = Buffer.from('not json!', 'utf8').toString('base64url');
		expect(decodeCursor(bad)).toBeNull();
	});

	it('produces URL-safe output (no +, /, or =)', () => {
		const encoded = encodeCursor({ u: 'x'.repeat(50) });
		expect(encoded).not.toMatch(/[+/=]/);
	});
});

describe('escapeLike', () => {
	it('escapes percent signs', () => {
		expect(escapeLike('100%')).toBe('100\\%');
	});

	it('escapes underscores', () => {
		expect(escapeLike('foo_bar')).toBe('foo\\_bar');
	});

	it('escapes backslashes', () => {
		expect(escapeLike('a\\b')).toBe('a\\\\b');
	});

	it('leaves normal text alone', () => {
		expect(escapeLike('North America')).toBe('North America');
	});

	it('handles multiple escapes in one string', () => {
		expect(escapeLike('50%_off')).toBe('50\\%\\_off');
	});
});
