/**
 * Morphit relay — keyEnvelope smoke.
 *
 * Covers the most security-critical primitive in the relay:
 * the AES-256-GCM + scrypt envelope that protects the active
 * key on disk.  Tests verify:
 *   - happy-path encrypt/decrypt round-trip
 *   - wrong passphrase fails with code='decryption_failed'
 *   - tampered ciphertext fails with code='decryption_failed'
 *     (GCM auth tag works)
 *   - tampered iv fails with code='decryption_failed'
 *   - malformed envelope shapes throw code='malformed'
 *   - weak scrypt N rejected with code='weak_params'
 *   - looksLikeEnvelope distinguishes JSON envelope from raw WIF
 *
 * Item 17 part 2 audit deliverable.
 */

import {
	encryptEnvelope,
	decryptEnvelope,
	looksLikeEnvelope,
	KeyEnvelopeError,
	KEY_ENVELOPE_VERSION
} from '../src/crypto/keyEnvelope.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KEY_ENVELOPE_SRC_PATH = resolve(__dirname, '../src/crypto/keyEnvelope.ts');

// Use a low-cost N for tests so they run in seconds, not minutes.
// We test the param-validation path separately; round-trip just
// needs ANY valid N.  encryptEnvelope hardcodes N=2^17 (good
// for production), so each test takes ~500ms-1s on a typical
// machine. With ~10 tests that's ~10s total — acceptable for a
// smoke that only runs occasionally.

let scenarios = 0;
let failures = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── keyEnvelope ───────────────────────────────────────────\n');

const TEST_WIF = '5KYZdUEo39z3FPrtuX2QbbwGnNP5zTd7yyr2SC1j299sBCnWjss';
const PASS = 'correct horse battery staple';

let canonical: ReturnType<typeof encryptEnvelope>;

scenario('encrypt produces a v1 envelope', () => {
	canonical = encryptEnvelope(TEST_WIF, PASS);
	if (canonical.v !== KEY_ENVELOPE_VERSION)
		throw new Error(`v=${canonical.v} expected ${KEY_ENVELOPE_VERSION}`);
	if (canonical.kdf !== 'scrypt') throw new Error(`kdf=${canonical.kdf}`);
	if (canonical.cipher !== 'aes-256-gcm') throw new Error(`cipher=${canonical.cipher}`);
	// salt + iv + ct are non-empty base64.
	if (canonical.kdf_params.salt.length < 16) throw new Error('salt too short');
	if (canonical.iv.length < 12) throw new Error('iv too short');
	if (canonical.ct.length < 32) throw new Error('ct too short');
});

scenario('round-trip recovers the WIF', () => {
	const out = decryptEnvelope(canonical, PASS);
	if (out !== TEST_WIF) throw new Error(`got ${out.length} chars`);
});

scenario('wrong passphrase fails with code=decryption_failed', () => {
	try {
		decryptEnvelope(canonical, 'definitely wrong');
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'decryption_failed')
			throw new Error(`code=${err.code} expected decryption_failed`);
	}
});

scenario('tampered ciphertext fails with code=decryption_failed', () => {
	// Flip a bit in ct.
	const ctBuf = Buffer.from(canonical.ct, 'base64');
	ctBuf[0] = ctBuf[0]! ^ 0xff;
	const tampered = { ...canonical, ct: ctBuf.toString('base64') };
	try {
		decryptEnvelope(tampered, PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'decryption_failed')
			throw new Error(`code=${err.code} expected decryption_failed`);
	}
});

scenario('tampered iv fails with code=decryption_failed', () => {
	const ivBuf = Buffer.from(canonical.iv, 'base64');
	ivBuf[0] = ivBuf[0]! ^ 0xff;
	const tampered = { ...canonical, iv: ivBuf.toString('base64') };
	try {
		decryptEnvelope(tampered, PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'decryption_failed')
			throw new Error(`code=${err.code} expected decryption_failed`);
	}
});

scenario('tampered tag fails with code=decryption_failed', () => {
	// Tag is the last 16 bytes of ct.
	const ctBuf = Buffer.from(canonical.ct, 'base64');
	ctBuf[ctBuf.length - 1] = ctBuf[ctBuf.length - 1]! ^ 0xff;
	const tampered = { ...canonical, ct: ctBuf.toString('base64') };
	try {
		decryptEnvelope(tampered, PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'decryption_failed')
			throw new Error(`code=${err.code} expected decryption_failed`);
	}
});

scenario('weak scrypt N rejected with code=weak_params', () => {
	const weak = {
		...canonical,
		kdf_params: { ...canonical.kdf_params, N: 1024 }
	};
	try {
		decryptEnvelope(weak, PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'weak_params') throw new Error(`code=${err.code} expected weak_params`);
	}
});

scenario('unsupported version rejected with code=malformed', () => {
	const bad = { ...canonical, v: 999 };
	try {
		decryptEnvelope(bad, PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'malformed') throw new Error(`code=${err.code} expected malformed`);
	}
});

scenario('unsupported kdf rejected with code=malformed', () => {
	const bad = { ...canonical, kdf: 'bcrypt' as never };
	try {
		decryptEnvelope(bad, PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'malformed') throw new Error(`code=${err.code}`);
	}
});

scenario('unsupported cipher rejected with code=malformed', () => {
	const bad = { ...canonical, cipher: 'aes-128-gcm' as never };
	try {
		decryptEnvelope(bad, PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'malformed') throw new Error(`code=${err.code}`);
	}
});

scenario('non-object envelope rejected with code=malformed', () => {
	try {
		decryptEnvelope('not an object', PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'malformed') throw new Error(`code=${err.code}`);
	}
});

scenario('null envelope rejected with code=malformed', () => {
	try {
		decryptEnvelope(null, PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
		if (err.code !== 'malformed') throw new Error(`code=${err.code}`);
	}
});

scenario('encrypt rejects empty plaintext', () => {
	try {
		encryptEnvelope('', PASS);
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
	}
});

scenario('encrypt rejects passphrase < 8 chars', () => {
	try {
		encryptEnvelope(TEST_WIF, 'short');
		throw new Error('expected throw');
	} catch (err) {
		if (!(err instanceof KeyEnvelopeError)) throw new Error('expected KeyEnvelopeError');
	}
});

scenario('looksLikeEnvelope distinguishes JSON from raw WIF', () => {
	if (!looksLikeEnvelope('{"v":1}')) throw new Error('json should look like envelope');
	if (!looksLikeEnvelope('   {"v":1}'))
		throw new Error('whitespace-prefixed json should look like envelope');
	if (looksLikeEnvelope('5KYZdUEo39z3FPrtuX2QbbwGnNP5zTd7yyr2SC1j299sBCnWjss'))
		throw new Error('WIF should not look like envelope');
	if (looksLikeEnvelope('Kxabc')) throw new Error('compressed WIF should not look like envelope');
});

scenario('two encrypts of same plaintext produce different ciphertext (fresh IV+salt)', () => {
	const a = encryptEnvelope(TEST_WIF, PASS);
	const b = encryptEnvelope(TEST_WIF, PASS);
	if (a.iv === b.iv) throw new Error('IVs should differ');
	if (a.kdf_params.salt === b.kdf_params.salt) throw new Error('salts should differ');
	if (a.ct === b.ct) throw new Error('ciphertexts should differ');
});

// Static-source check: both encryptEnvelope and decryptEnvelope
// MUST zero the scrypt-derived key in a finally block on success
// AND throw paths.  Pre-fix, the key sat in V8/Node's heap until
// GC after the function returned — observable to a process-memory
// scraper for seconds-to-minutes.  This smoke catches regressions
// that drop the finally-zero (e.g. a refactor that moves the
// cleanup outside the try block).
scenario('encryptEnvelope zeros scrypt-derived key in finally', () => {
	const src = readFileSync(KEY_ENVELOPE_SRC_PATH, 'utf8');
	const match = src.match(/export function encryptEnvelope[\s\S]*?\n\}\n/);
	if (!match) throw new Error('encryptEnvelope body not found');
	if (!/finally\s*\{[\s\S]*?key\.fill\(0\)[\s\S]*?\}/.test(match[0])) {
		throw new Error('encryptEnvelope: missing finally{ key.fill(0) }');
	}
});

scenario('decryptEnvelope zeros scrypt-derived key + plaintext in finally', () => {
	const src = readFileSync(KEY_ENVELOPE_SRC_PATH, 'utf8');
	const match = src.match(/export function decryptEnvelope[\s\S]*?\n\}\n/);
	if (!match) throw new Error('decryptEnvelope body not found');
	if (!/finally\s*\{[\s\S]*?key\.fill\(0\)[\s\S]*?\}/.test(match[0])) {
		throw new Error('decryptEnvelope: missing finally{ key.fill(0) }');
	}
	if (!/plaintext\.fill\(0\)/.test(match[0])) {
		throw new Error('decryptEnvelope: missing plaintext.fill(0) in finally');
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
