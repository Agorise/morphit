import { describe, it, expect } from 'vitest';
import { extractRecipientFromQr } from './qrRecipient';

describe('extractRecipientFromQr', () => {
	it('returns a bare account name unchanged', () => {
		expect(extractRecipientFromQr('alice')).toBe('alice');
	});

	it('strips a leading @ handle form', () => {
		expect(extractRecipientFromQr('@alice')).toBe('alice');
	});

	it('lowercases (Blurt accounts are lowercase)', () => {
		expect(extractRecipientFromQr('Alice')).toBe('alice');
	});

	it('trims surrounding whitespace', () => {
		expect(extractRecipientFromQr('  alice  ')).toBe('alice');
	});

	it('preserves a dotted account name (no colon → not a scheme)', () => {
		expect(extractRecipientFromQr('alice.bob')).toBe('alice.bob');
	});

	it('strips a "scheme:" URI prefix', () => {
		expect(extractRecipientFromQr('blurt:alice')).toBe('alice');
	});

	it('strips a "scheme://" URI prefix', () => {
		expect(extractRecipientFromQr('blurt://alice')).toBe('alice');
	});

	it('extracts ONLY the account from a payment URI — never amount/memo', () => {
		// A hostile/other-wallet QR could carry money params; we must not
		// let them pre-fill anything. Only the recipient comes through.
		expect(extractRecipientFromQr('blurt://alice?amount=999&memo=drain')).toBe('alice');
	});

	it('cuts a trailing path segment', () => {
		expect(extractRecipientFromQr('alice/extra')).toBe('alice');
	});

	it('returns empty for an empty string', () => {
		expect(extractRecipientFromQr('')).toBe('');
	});

	it('returns empty for whitespace only', () => {
		expect(extractRecipientFromQr('   ')).toBe('');
	});

	it('does not throw on a non-Blurt URI (validation rejects the result downstream)', () => {
		// Extraction is lenient; the Send modal's format + on-chain checks
		// are what actually gate a send. This must just not crash.
		expect(() => extractRecipientFromQr('bitcoin:1ABCxyz?amount=1')).not.toThrow();
		expect(extractRecipientFromQr('bitcoin:1ABCxyz?amount=1')).toBe('1abcxyz');
	});
});
