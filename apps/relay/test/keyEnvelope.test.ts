/**
 * Tests for keyEnvelope encrypt/decrypt roundtrip.
 *
 * Uses the full v1 scrypt parameters, which means each test
 * that encrypts takes ~500ms–1s. A few tests only decrypt, so
 * they're free. Total expected runtime: 5–10 seconds.
 */

import { describe, expect, it } from 'vitest';

import {
	decryptEnvelope,
	encryptEnvelope,
	looksLikeEnvelope,
	KEY_ENVELOPE_VERSION,
	KeyEnvelopeError
} from '$crypto/keyEnvelope';

// Realistic WIF-shaped sample. Not a real key, just for tests.
const SAMPLE_WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';

describe('encryptEnvelope / decryptEnvelope', () => {
	it('round-trip returns the original plaintext', async () => {
		const env = encryptEnvelope(SAMPLE_WIF, 'correct horse battery staple');
		const back = decryptEnvelope(env, 'correct horse battery staple');
		expect(back).toBe(SAMPLE_WIF);
	});

	it('produces a v1 envelope with scrypt + aes-256-gcm + 16B salt + 12B IV', () => {
		const env = encryptEnvelope(SAMPLE_WIF, 'passphrase123');
		expect(env.v).toBe(KEY_ENVELOPE_VERSION);
		expect(env.kdf).toBe('scrypt');
		expect(env.cipher).toBe('aes-256-gcm');
		// base64 16 bytes = 24 chars (with padding).
		expect(Buffer.from(env.kdf_params.salt, 'base64')).toHaveLength(16);
		// base64 12 bytes = 16 chars.
		expect(Buffer.from(env.iv, 'base64')).toHaveLength(12);
	});

	it('two encryptions of the same plaintext produce different envelopes', () => {
		// Fresh salt + IV each time means identical plaintexts encrypt
		// to completely different envelopes. This tests the randomness.
		const a = encryptEnvelope(SAMPLE_WIF, 'same-pass');
		const b = encryptEnvelope(SAMPLE_WIF, 'same-pass');
		expect(a.kdf_params.salt).not.toBe(b.kdf_params.salt);
		expect(a.iv).not.toBe(b.iv);
		expect(a.ct).not.toBe(b.ct);
	});

	it('wrong passphrase → decryption failed error', () => {
		const env = encryptEnvelope(SAMPLE_WIF, 'right-one');
		expect(() => decryptEnvelope(env, 'wrong-one')).toThrow(KeyEnvelopeError);
		try {
			decryptEnvelope(env, 'wrong-one');
		} catch (err) {
			expect(err).toBeInstanceOf(KeyEnvelopeError);
			expect((err as KeyEnvelopeError).message).toContain('decryption failed');
		}
	});

	it('tampered ciphertext → integrity check fails', () => {
		const env = encryptEnvelope(SAMPLE_WIF, 'passphrase123');
		// Flip the first byte of the ciphertext.
		const ctBuf = Buffer.from(env.ct, 'base64');
		ctBuf[0] = ctBuf[0]! ^ 0xff;
		const tampered = { ...env, ct: ctBuf.toString('base64') };
		expect(() => decryptEnvelope(tampered, 'passphrase123')).toThrow(KeyEnvelopeError);
	});

	it('short passphrase rejected at encrypt time', () => {
		expect(() => encryptEnvelope(SAMPLE_WIF, 'short')).toThrow(/at least 8/);
	});

	it('empty plaintext rejected at encrypt time', () => {
		expect(() => encryptEnvelope('', 'passphrase123')).toThrow(/empty plaintext/);
	});
});

describe('decryptEnvelope shape validation', () => {
	it('rejects non-object input', () => {
		expect(() => decryptEnvelope('not-an-envelope', 'pw')).toThrow(/must be an object/);
	});

	it('rejects envelope with missing v field', () => {
		expect(() => decryptEnvelope({ kdf: 'scrypt' }, 'pw')).toThrow(/envelope\.v/);
	});

	it('rejects envelope with unsupported version', () => {
		const env = encryptEnvelope(SAMPLE_WIF, 'passphrase123');
		const bad = { ...env, v: 999 };
		expect(() => decryptEnvelope(bad, 'passphrase123')).toThrow(/unsupported envelope version/);
	});

	it('rejects envelope with unsupported kdf', () => {
		const env = encryptEnvelope(SAMPLE_WIF, 'passphrase123');
		const bad = { ...env, kdf: 'argon2' };
		expect(() => decryptEnvelope(bad, 'passphrase123')).toThrow(/unsupported kdf/);
	});

	it('rejects scrypt N below the safety floor', () => {
		const env = encryptEnvelope(SAMPLE_WIF, 'passphrase123');
		const bad = {
			...env,
			kdf_params: { ...env.kdf_params, N: 1024 }
		};
		expect(() => decryptEnvelope(bad, 'passphrase123')).toThrow(/scrypt N below/);
	});
});

describe('looksLikeEnvelope', () => {
	it('returns true for JSON-like content', () => {
		expect(looksLikeEnvelope('{"v":1}')).toBe(true);
		expect(looksLikeEnvelope('  \n{"v":1}')).toBe(true);
	});

	it('returns false for a raw WIF', () => {
		expect(looksLikeEnvelope(SAMPLE_WIF)).toBe(false);
		expect(looksLikeEnvelope('KxyHqTB...')).toBe(false);
	});
});
