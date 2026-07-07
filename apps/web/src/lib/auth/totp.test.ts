/**
 * Morphit — TOTP unit tests.
 *
 * Pinned against RFC 6238 Appendix B test vectors (the canonical
 * interop reference).  If these pass, every standards-compliant
 * authenticator (Aegis, 2FAS, Ente Auth, the rest) will produce the
 * same codes for the same secret + time.
 */

import { describe, expect, it } from 'vitest';
import {
	base32Encode,
	base32Decode,
	computeCode,
	verifyCode,
	otpauthUri,
	generateSecret,
	TOTP_SECRET_BYTES,
	TOTP_PERIOD_SECONDS,
	TOTP_DIGITS
} from './totp';

/** RFC 6238 Appendix B — SHA-1 test vectors.
 *
 *  The RFC publishes test vectors for HMAC-SHA-1 with a 20-byte
 *  secret of "12345678901234567890" (ASCII, not base32) at digits=8
 *  (the RFC's variant uses 8-digit codes for the test vectors).
 *
 *  We use digits=6 (the universal default), so we'll re-derive the
 *  6-digit prefix-truncation from the published 8-digit values is
 *  ALSO part of the RFC: the dynamic-truncation result modulo
 *  10^digits.  For 8-digit "94287082" the equivalent 6-digit code
 *  is "287082" (last 6 digits).
 *
 *  Verified against an independent TOTP implementation
 *  (oathtool --totp -b -d 6 --now=1970-01-01T00:00:59Z 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').
 */

const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_BYTES = new TextEncoder().encode(RFC_SECRET_ASCII);

// RFC 6238 Appendix B test vectors (SHA-1).  6-digit codes are the
// last 6 of the published 8-digit values, per the truncation formula.
const RFC_VECTORS_6DIGIT: Array<{ time: number; code: string }> = [
	{ time: 59,          code: '287082' },
	{ time: 1111111109,  code: '081804' },
	{ time: 1111111111,  code: '050471' },
	{ time: 1234567890,  code: '005924' },
	{ time: 2000000000,  code: '279037' },
	{ time: 20000000000, code: '353130' }  // > 32-bit step, exercises high counter bytes
];

describe('TOTP — RFC 6238 test vectors', () => {
	for (const { time, code } of RFC_VECTORS_6DIGIT) {
		it(`computeCode at unix time ${time} → ${code}`, async () => {
			const result = await computeCode(RFC_SECRET_BYTES, time);
			expect(result).toBe(code);
		});
	}
});

describe('TOTP — verifyCode acceptance window', () => {
	it('accepts the current step', async () => {
		const t = 1111111111;
		const result = await verifyCode(RFC_SECRET_BYTES, '050471', t);
		expect(result.valid).toBe(true);
	});

	it('accepts the previous step (–30s skew)', async () => {
		const t = 1111111111;
		// Code at t-30 is the previous step.  Compute it:
		const prevCode = await computeCode(RFC_SECRET_BYTES, t - 30);
		const result = await verifyCode(RFC_SECRET_BYTES, prevCode, t);
		expect(result.valid).toBe(true);
	});

	it('accepts the next step (+30s skew)', async () => {
		const t = 1111111111;
		const nextCode = await computeCode(RFC_SECRET_BYTES, t + 30);
		const result = await verifyCode(RFC_SECRET_BYTES, nextCode, t);
		expect(result.valid).toBe(true);
	});

	it('rejects a code 2 steps in the past (outside window)', async () => {
		const t = 1111111111;
		const oldCode = await computeCode(RFC_SECRET_BYTES, t - 60);
		const result = await verifyCode(RFC_SECRET_BYTES, oldCode, t);
		expect(result.valid).toBe(false);
	});

	it('rejects a code 2 steps in the future (outside window)', async () => {
		const t = 1111111111;
		const futureCode = await computeCode(RFC_SECRET_BYTES, t + 60);
		const result = await verifyCode(RFC_SECRET_BYTES, futureCode, t);
		expect(result.valid).toBe(false);
	});

	it('rejects malformed input (non-numeric)', async () => {
		const result = await verifyCode(RFC_SECRET_BYTES, 'abc123', 1111111111);
		expect(result.valid).toBe(false);
	});

	it('rejects wrong-length input', async () => {
		const r1 = await verifyCode(RFC_SECRET_BYTES, '12345', 1111111111); // 5 digits
		expect(r1.valid).toBe(false);
		const r2 = await verifyCode(RFC_SECRET_BYTES, '1234567', 1111111111); // 7 digits
		expect(r2.valid).toBe(false);
	});

	it('strips whitespace from user input', async () => {
		const t = 1111111111;
		const result = await verifyCode(RFC_SECRET_BYTES, '050 471', t);
		expect(result.valid).toBe(true);
	});

	it('rejects a completely wrong code', async () => {
		const result = await verifyCode(RFC_SECRET_BYTES, '000000', 1111111111);
		expect(result.valid).toBe(false);
	});

	it('returns the used step for replay-prevention bookkeeping', async () => {
		const t = 1111111111;
		const result = await verifyCode(RFC_SECRET_BYTES, '050471', t);
		expect(result.valid).toBe(true);
		expect(result.usedStep).toBe(Math.floor(t / 30));
	});
});

describe('base32 — RFC 4648 encode/decode', () => {
	// RFC 4648 §10 test vectors, but with PADDING STRIPPED since we
	// emit no-padding output (the de-facto authenticator-app standard).
	const cases: Array<[string, string]> = [
		['', ''],
		['f', 'MY'],
		['fo', 'MZXQ'],
		['foo', 'MZXW6'],
		['foob', 'MZXW6YQ'],
		['fooba', 'MZXW6YTB'],
		['foobar', 'MZXW6YTBOI']
	];
	for (const [plain, encoded] of cases) {
		it(`encode("${plain}") → "${encoded}"`, () => {
			const bytes = new TextEncoder().encode(plain);
			expect(base32Encode(bytes)).toBe(encoded);
		});
		it(`decode("${encoded}") → "${plain}"`, () => {
			const decoded = base32Decode(encoded);
			expect(new TextDecoder().decode(decoded)).toBe(plain);
		});
	}

	it('decode tolerates lowercase, spaces, dashes, padding', () => {
		const a = base32Decode('mzxw 6yt-boi==');
		const b = base32Decode('MZXW6YTBOI');
		expect(Array.from(a)).toEqual(Array.from(b));
	});

	it('decode rejects out-of-alphabet characters', () => {
		expect(() => base32Decode('M!ZW')).toThrow(/invalid character/);
	});

	it('roundtrip on 20 random bytes (TOTP secret size)', () => {
		const random = crypto.getRandomValues(new Uint8Array(20));
		const encoded = base32Encode(random);
		const decoded = base32Decode(encoded);
		expect(Array.from(decoded)).toEqual(Array.from(random));
	});
});

describe('TOTP — otpauth:// URI', () => {
	it('builds the spec-compliant URI', () => {
		// RFC 6238-style URI per the Google Authenticator URI spec.
		const secretB32 = 'JBSWY3DPEHPK3PXP'; // "Hello!\xDE\xAD\xBE\xEF" encoded
		const uri = otpauthUri('alice', secretB32);
		expect(uri).toMatch(/^otpauth:\/\/totp\//);
		expect(uri).toContain('Morphit%3Aalice'); // URL-encoded "Morphit:alice"
		expect(uri).toContain(`secret=${secretB32}`);
		expect(uri).toContain('issuer=Morphit');
		expect(uri).toContain('algorithm=SHA1');
		expect(uri).toContain('digits=6');
		expect(uri).toContain('period=30');
	});

	it('URL-encodes account names containing special chars', () => {
		const uri = otpauthUri('alice@example', 'JBSWY3DPEHPK3PXP');
		// '@' must be percent-encoded inside the label
		expect(uri).toContain('Morphit%3Aalice%40example');
	});
});

describe('TOTP — secret generation', () => {
	it('generateSecret returns a 20-byte (160-bit) Uint8Array', () => {
		const secret = generateSecret();
		expect(secret).toBeInstanceOf(Uint8Array);
		expect(secret.length).toBe(TOTP_SECRET_BYTES);
		expect(TOTP_SECRET_BYTES).toBe(20);
	});

	it('generates distinct secrets on consecutive calls (statistical)', () => {
		// Vanishingly unlikely to collide; if this ever fails, we've
		// got a real PRNG bug.
		const a = generateSecret();
		const b = generateSecret();
		expect(Array.from(a)).not.toEqual(Array.from(b));
	});
});

describe('TOTP — exported constants', () => {
	it('period = 30s, digits = 6 (universal authenticator defaults)', () => {
		expect(TOTP_PERIOD_SECONDS).toBe(30);
		expect(TOTP_DIGITS).toBe(6);
	});
});
