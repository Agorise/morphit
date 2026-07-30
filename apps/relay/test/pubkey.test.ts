import { describe, expect, it } from 'vitest';
import { isValidPublicKey } from '../src/blurt/pubkey.ts';

describe('isValidPublicKey', () => {
	const morphitKey = 'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9';

	it('accepts the real @morphit posting pubkey', () => {
		expect(isValidPublicKey(morphitKey)).toBe(true);
	});

	it('rejects wrong prefix', () => {
		const steemified = 'STM' + morphitKey.slice(3);
		expect(isValidPublicKey(steemified)).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidPublicKey('')).toBe(false);
	});

	it('rejects non-string types', () => {
		expect(isValidPublicKey(null)).toBe(false);
		expect(isValidPublicKey(undefined)).toBe(false);
		expect(isValidPublicKey(123)).toBe(false);
		expect(isValidPublicKey({})).toBe(false);
	});

	it('rejects truncated keys', () => {
		expect(isValidPublicKey('BLT12345')).toBe(false);
		expect(isValidPublicKey('BLT')).toBe(false);
	});

	it('rejects checksum-tampered keys', () => {
		// Flip the very last char of the real key. The checksum is
		// derived from the key body, so any modification to any
		// position invalidates it.
		const tampered = morphitKey.slice(0, -1) + '1';
		expect(isValidPublicKey(tampered)).toBe(false);
	});

	it('rejects base58-invalid chars', () => {
		// '0' and 'O' are not in the Bitcoin base58 alphabet.
		expect(isValidPublicKey('BLT0' + morphitKey.slice(4))).toBe(false);
	});
});
