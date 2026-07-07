#!/usr/bin/env tsx
/**
 * desktop-pairing-crypto-smoke (ADR-0022).
 *
 * Exercises the pure pairing crypto module end-to-end without
 * a relay, without a chain, and without browser harness.  The
 * smoke acts as both phone and desktop, swapping between roles
 * in the same process.
 *
 * Coverage:
 *   - Round trip: desktop generates QR, phone validates +
 *     signs + encrypts, desktop decrypts + verifies, OK.
 *   - QR validation gates: malformed JSON, wrong version,
 *     bad pid, bad epk (length / base64), bad origin, bad
 *     relay, expired, exp-too-far-future.
 *   - Bundle build: rejects oversize / non-ASCII device labels.
 *   - Echo checks: epk_echo mismatch, origin_echo mismatch,
 *     pid mismatch.
 *   - Freshness: signed_at too old, signed_at too future.
 *   - Signature: verifier returning false rejects; verifier
 *     returning true accepts.
 *   - canonicalJson: stable across key insertion orders.
 *   - derivePairingId: deterministic; different inputs yield
 *     different output.
 */

import sodium from 'libsodium-wrappers-sumo';

import {
	PAIRING_PROTOCOL_VERSION,
	QR_MAX_AGE_FUTURE_SECONDS,
	BUNDLE_FRESHNESS_PAST_SECONDS,
	BUNDLE_FRESHNESS_FUTURE_SECONDS,
	canonicalJson,
	derivePairingId,
	generateDesktopEphemeralKeys,
	buildQrPayload,
	validateQrWireForm,
	buildPairingBundle,
	buildDeliveryPayload,
	verifyDeliveryPayload,
	type BundleSigner,
	type SignatureVerifier,
	type PairingBundle
} from '../src/lib/auth/desktopPairing.ts';

let failures = 0;
let scenarios = 0;

async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
	scenarios++;
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

function expectEq<T>(actual: T, expected: T, label = ''): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label ? label + ': ' : ''}expected ${e}, got ${a}`);
	}
}

/** Make a "fake posting key" signer + verifier pair for testing.
 *  Uses ed25519 because that's what libsodium provides directly;
 *  the production posting-key signer is secp256k1-via-dblurt and
 *  is supplied by the caller, so the smoke just needs SOMETHING
 *  with the same shape. */
async function makeSignerPair(): Promise<{
	readonly signer: BundleSigner;
	readonly verifier: SignatureVerifier;
	readonly account: string;
}> {
	await sodium.ready;
	const seed = sodium.randombytes_buf(32);
	const kp = sodium.crypto_sign_seed_keypair(seed);
	const account = 'test-account';
	const signer: BundleSigner = async (canonicalBytes) =>
		sodium.crypto_sign_detached(canonicalBytes, kp.privateKey);
	const verifier: SignatureVerifier = async (acct, canonicalBytes, signatureBytes) => {
		if (acct !== account) return false;
		try {
			return sodium.crypto_sign_verify_detached(signatureBytes, canonicalBytes, kp.publicKey);
		} catch {
			return false;
		}
	};
	return { signer, verifier, account };
}

async function main(): Promise<void> {
	await sodium.ready;
	console.log('desktop-pairing-crypto-smoke (ADR-0022):\n');

	// ─── Constants exposed correctly ──────────────────────────

	await scenario('PAIRING_PROTOCOL_VERSION === 1', () => {
		expectEq(PAIRING_PROTOCOL_VERSION, 1);
	});

	await scenario('QR_MAX_AGE_FUTURE_SECONDS === 300 (5 min)', () => {
		expectEq(QR_MAX_AGE_FUTURE_SECONDS, 300);
	});

	await scenario('BUNDLE_FRESHNESS bounds are 120s past / 30s future', () => {
		expectEq(BUNDLE_FRESHNESS_PAST_SECONDS, 120);
		expectEq(BUNDLE_FRESHNESS_FUTURE_SECONDS, 30);
	});

	// ─── canonicalJson stability ──────────────────────────────

	await scenario('canonicalJson sorts keys regardless of insertion order', () => {
		const a = canonicalJson({ b: 1, a: 2, c: 3 });
		const b = canonicalJson({ c: 3, a: 2, b: 1 });
		expectEq(a, b);
		expectEq(a, '{"a":2,"b":1,"c":3}');
	});

	await scenario('canonicalJson handles nested objects + arrays', () => {
		const a = canonicalJson({ z: { y: 1, x: 2 }, arr: [3, 1, 2] });
		// Nested object keys sorted; array order preserved.
		expectEq(a, '{"arr":[3,1,2],"z":{"x":2,"y":1}}');
	});

	await scenario('canonicalJson handles primitives and null', () => {
		expectEq(canonicalJson(null), 'null');
		expectEq(canonicalJson(42), '42');
		expectEq(canonicalJson('hi'), '"hi"');
		expectEq(canonicalJson(true), 'true');
	});

	// ─── derivePairingId determinism ──────────────────────────

	await scenario('derivePairingId is deterministic', async () => {
		const epk = sodium.randombytes_buf(32);
		const nonce = sodium.randombytes_buf(16);
		const a = await derivePairingId(epk, nonce);
		const b = await derivePairingId(epk, nonce);
		expectEq(a, b);
		assert(/^[0-9a-f]{64}$/.test(a), 'pid format wrong');
	});

	await scenario('derivePairingId differs for different nonces', async () => {
		const epk = sodium.randombytes_buf(32);
		const a = await derivePairingId(epk, sodium.randombytes_buf(16));
		const b = await derivePairingId(epk, sodium.randombytes_buf(16));
		assert(a !== b, 'two random nonces produced same pid');
	});

	await scenario('derivePairingId rejects wrong-size epk', async () => {
		try {
			await derivePairingId(new Uint8Array(31), new Uint8Array(16));
			throw new Error('did not throw');
		} catch (err) {
			assert(
				err instanceof Error && err.message.includes('epk_pub must be 32 bytes'),
				`wrong error: ${err}`
			);
		}
	});

	await scenario('derivePairingId rejects wrong-size nonce', async () => {
		try {
			await derivePairingId(new Uint8Array(32), new Uint8Array(15));
			throw new Error('did not throw');
		} catch (err) {
			assert(
				err instanceof Error && err.message.includes('nonce must be 16 bytes'),
				`wrong error: ${err}`
			);
		}
	});

	// ─── Full happy-path round trip ───────────────────────────

	await scenario('happy path: desktop QR → phone sign → desktop verify OK', async () => {
		const { signer, verifier, account } = await makeSignerPair();
		const desktopKeys = await generateDesktopEphemeralKeys();
		const now = 1714867200;
		const { payload, compactWire } = await buildQrPayload({
			epk_pub: desktopKeys.epk_pub,
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			nowSeconds: now
		});

		// Phone scans, validates.
		const validated = validateQrWireForm(compactWire, now + 5);
		assert(validated.kind === 'ok', 'QR validation failed');
		expectEq(validated.payload.pid, payload.pid);

		// Phone builds bundle + delivery payload.
		const bundle = buildPairingBundle({
			qr: validated.payload,
			account,
			accountChatPubkey: 'chatPubkey-stub-base64',
			nowSeconds: now + 5,
			deviceLabel: 'iPhone 15 Pro'
		});
		const delivery = await buildDeliveryPayload({
			bundle,
			signer,
			desktopEpkPub: desktopKeys.epk_pub
		});

		// Desktop verifies.  Note: epk_priv is mutable Uint8Array
		// so we make a copy before passing — the function wipes
		// the original.  In production the caller owns the buffer
		// and accepts the wipe.
		const epkPrivCopy = new Uint8Array(desktopKeys.epk_priv);
		const result = await verifyDeliveryPayload({
			delivery,
			desktopEpkPriv: epkPrivCopy,
			desktopEpkPub: desktopKeys.epk_pub,
			desktopOrigin: 'https://morphit.io',
			expectedPid: payload.pid,
			nowSeconds: now + 10,
			verifier
		});
		assert(result.kind === 'ok', `verify failed: ${JSON.stringify(result)}`);
		expectEq(result.envelope.bundle.account, account);
		expectEq(result.envelope.bundle.device_label, 'iPhone 15 Pro');
	});

	// ─── QR validation gates ──────────────────────────────────

	await scenario('QR validation: malformed base64 → reject', () => {
		const r = validateQrWireForm('@@@not-base64@@@', 1714867200);
		assert(r.kind === 'reject', 'should reject');
		expectEq(r.reason.kind, 'malformed_json');
	});

	await scenario('QR validation: valid base64 of non-JSON → reject', () => {
		const r = validateQrWireForm(
			sodium.to_base64(
				new TextEncoder().encode('not json'),
				sodium.base64_variants.URLSAFE_NO_PADDING
			),
			1714867200
		);
		assert(r.kind === 'reject');
		expectEq(r.reason.kind, 'malformed_json');
	});

	await scenario('QR validation: wrong version → reject', () => {
		const wire = sodium.to_base64(
			new TextEncoder().encode(
				JSON.stringify({
					v: 99,
					pid: 'a'.repeat(64),
					epk: sodium.to_base64(new Uint8Array(32), sodium.base64_variants.ORIGINAL),
					origin: 'https://morphit.io',
					relay: 'https://morphit.io',
					exp: 1714867200 + 60
				})
			),
			sodium.base64_variants.URLSAFE_NO_PADDING
		);
		const r = validateQrWireForm(wire, 1714867200);
		assert(r.kind === 'reject');
		expectEq(r.reason.kind, 'wrong_version');
	});

	await scenario('QR validation: short pid → reject', () => {
		const wire = sodium.to_base64(
			new TextEncoder().encode(
				JSON.stringify({
					v: 1,
					pid: 'short',
					epk: sodium.to_base64(new Uint8Array(32), sodium.base64_variants.ORIGINAL),
					origin: 'https://morphit.io',
					relay: 'https://morphit.io',
					exp: 1714867200 + 60
				})
			),
			sodium.base64_variants.URLSAFE_NO_PADDING
		);
		const r = validateQrWireForm(wire, 1714867200);
		assert(r.kind === 'reject');
		expectEq(r.reason.kind, 'bad_pid');
	});

	await scenario('QR validation: non-base64 epk → reject', () => {
		const wire = sodium.to_base64(
			new TextEncoder().encode(
				JSON.stringify({
					v: 1,
					pid: 'a'.repeat(64),
					epk: '@@@',
					origin: 'https://morphit.io',
					relay: 'https://morphit.io',
					exp: 1714867200 + 60
				})
			),
			sodium.base64_variants.URLSAFE_NO_PADDING
		);
		const r = validateQrWireForm(wire, 1714867200);
		assert(r.kind === 'reject');
		expectEq(r.reason.kind, 'bad_epk');
	});

	await scenario('QR validation: http (not https) origin → reject', () => {
		const wire = sodium.to_base64(
			new TextEncoder().encode(
				JSON.stringify({
					v: 1,
					pid: 'a'.repeat(64),
					epk: sodium.to_base64(new Uint8Array(32), sodium.base64_variants.ORIGINAL),
					origin: 'http://morphit.io',
					relay: 'https://morphit.io',
					exp: 1714867200 + 60
				})
			),
			sodium.base64_variants.URLSAFE_NO_PADDING
		);
		const r = validateQrWireForm(wire, 1714867200);
		assert(r.kind === 'reject');
		expectEq(r.reason.kind, 'bad_origin');
	});

	await scenario('QR validation: expired → reject', async () => {
		const desktopKeys = await generateDesktopEphemeralKeys();
		const { compactWire } = await buildQrPayload({
			epk_pub: desktopKeys.epk_pub,
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			nowSeconds: 1714867200
		});
		// Validate at a time AFTER the QR's exp.
		const r = validateQrWireForm(compactWire, 1714867200 + 600);
		assert(r.kind === 'reject');
		expectEq(r.reason.kind, 'expired');
	});

	await scenario('QR validation: exp too far future → reject', async () => {
		const wire = sodium.to_base64(
			new TextEncoder().encode(
				JSON.stringify({
					v: 1,
					pid: 'a'.repeat(64),
					epk: sodium.to_base64(new Uint8Array(32), sodium.base64_variants.ORIGINAL),
					origin: 'https://morphit.io',
					relay: 'https://morphit.io',
					exp: 1714867200 + 3600 // 1 hour out, well above 5min cap
				})
			),
			sodium.base64_variants.URLSAFE_NO_PADDING
		);
		const r = validateQrWireForm(wire, 1714867200);
		assert(r.kind === 'reject');
		expectEq(r.reason.kind, 'exp_too_far_future');
	});

	// ─── Bundle build validation ──────────────────────────────

	await scenario('buildPairingBundle rejects oversize device label', () => {
		try {
			buildPairingBundle({
				qr: {
					v: 1,
					pid: 'a'.repeat(64),
					epk: 'epk-base64',
					origin: 'https://morphit.io',
					relay: 'https://morphit.io',
					exp: 1714867200 + 60
				},
				account: 'test-account',
				accountChatPubkey: 'chatpub',
				nowSeconds: 1714867200,
				deviceLabel: 'x'.repeat(33)
			});
			throw new Error('did not throw');
		} catch (err) {
			assert(err instanceof Error && err.message.includes('device label too long'));
		}
	});

	await scenario('buildPairingBundle rejects non-ASCII device label', () => {
		try {
			buildPairingBundle({
				qr: {
					v: 1,
					pid: 'a'.repeat(64),
					epk: 'epk-base64',
					origin: 'https://morphit.io',
					relay: 'https://morphit.io',
					exp: 1714867200 + 60
				},
				account: 'test-account',
				accountChatPubkey: 'chatpub',
				nowSeconds: 1714867200,
				deviceLabel: 'iPhone 📱'
			});
			throw new Error('did not throw');
		} catch (err) {
			assert(err instanceof Error && err.message.includes('ASCII printable'));
		}
	});

	await scenario('buildPairingBundle rejects empty / oversize account', () => {
		const qr = {
			v: 1 as const,
			pid: 'a'.repeat(64),
			epk: 'epk-base64',
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			exp: 1714867200 + 60
		};
		try {
			buildPairingBundle({
				qr,
				account: '',
				accountChatPubkey: 'chatpub',
				nowSeconds: 1714867200,
				deviceLabel: 'phone'
			});
			throw new Error('did not throw on empty account');
		} catch (err) {
			assert(err instanceof Error && err.message.includes('account name'));
		}
		try {
			buildPairingBundle({
				qr,
				account: 'x'.repeat(65),
				accountChatPubkey: 'chatpub',
				nowSeconds: 1714867200,
				deviceLabel: 'phone'
			});
			throw new Error('did not throw on oversize account');
		} catch (err) {
			assert(err instanceof Error && err.message.includes('account name'));
		}
	});

	// ─── Echo checks (the heart of the threat model) ──────────

	await scenario('verify: epk_echo mismatch → reject', async () => {
		const { signer, verifier, account } = await makeSignerPair();
		const desktopKeys = await generateDesktopEphemeralKeys();
		const decoyKeys = await generateDesktopEphemeralKeys();
		const now = 1714867200;
		const { payload, compactWire } = await buildQrPayload({
			epk_pub: desktopKeys.epk_pub,
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			nowSeconds: now
		});
		const v = validateQrWireForm(compactWire, now);
		assert(v.kind === 'ok');
		// Phone signs a bundle that LIES about which epk it
		// echoes.  This simulates a hostile relay shuffling
		// bundles between pids.
		const lyingBundle: PairingBundle = {
			...buildPairingBundle({
				qr: v.payload,
				account,
				accountChatPubkey: 'chatpub',
				nowSeconds: now,
				deviceLabel: 'phone'
			}),
			epk_echo: sodium.to_base64(decoyKeys.epk_pub, sodium.base64_variants.ORIGINAL)
		};
		const delivery = await buildDeliveryPayload({
			bundle: lyingBundle,
			signer,
			desktopEpkPub: desktopKeys.epk_pub
		});
		const epkPrivCopy = new Uint8Array(desktopKeys.epk_priv);
		const result = await verifyDeliveryPayload({
			delivery,
			desktopEpkPriv: epkPrivCopy,
			desktopEpkPub: desktopKeys.epk_pub,
			desktopOrigin: 'https://morphit.io',
			expectedPid: payload.pid,
			nowSeconds: now,
			verifier
		});
		assert(result.kind === 'reject');
		expectEq(result.reason.kind, 'epk_echo_mismatch');
	});

	await scenario('verify: origin_echo mismatch → reject', async () => {
		const { signer, verifier, account } = await makeSignerPair();
		const desktopKeys = await generateDesktopEphemeralKeys();
		const now = 1714867200;
		const { payload, compactWire } = await buildQrPayload({
			epk_pub: desktopKeys.epk_pub,
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			nowSeconds: now
		});
		const v = validateQrWireForm(compactWire, now);
		assert(v.kind === 'ok');
		const bundle = buildPairingBundle({
			qr: v.payload,
			account,
			accountChatPubkey: 'chatpub',
			nowSeconds: now,
			deviceLabel: 'phone'
		});
		const delivery = await buildDeliveryPayload({
			bundle,
			signer,
			desktopEpkPub: desktopKeys.epk_pub
		});
		// Desktop is at a DIFFERENT origin than what was signed.
		const epkPrivCopy = new Uint8Array(desktopKeys.epk_priv);
		const result = await verifyDeliveryPayload({
			delivery,
			desktopEpkPriv: epkPrivCopy,
			desktopEpkPub: desktopKeys.epk_pub,
			desktopOrigin: 'https://morphit.example.com',
			expectedPid: payload.pid,
			nowSeconds: now,
			verifier
		});
		assert(result.kind === 'reject');
		expectEq(result.reason.kind, 'origin_echo_mismatch');
	});

	await scenario('verify: pid mismatch (delivery vs expected) → reject', async () => {
		const { signer, verifier, account } = await makeSignerPair();
		const desktopKeys = await generateDesktopEphemeralKeys();
		const now = 1714867200;
		const { payload, compactWire } = await buildQrPayload({
			epk_pub: desktopKeys.epk_pub,
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			nowSeconds: now
		});
		const v = validateQrWireForm(compactWire, now);
		assert(v.kind === 'ok');
		const bundle = buildPairingBundle({
			qr: v.payload,
			account,
			accountChatPubkey: 'chatpub',
			nowSeconds: now,
			deviceLabel: 'phone'
		});
		const delivery = await buildDeliveryPayload({
			bundle,
			signer,
			desktopEpkPub: desktopKeys.epk_pub
		});
		const epkPrivCopy = new Uint8Array(desktopKeys.epk_priv);
		const result = await verifyDeliveryPayload({
			delivery,
			desktopEpkPriv: epkPrivCopy,
			desktopEpkPub: desktopKeys.epk_pub,
			desktopOrigin: 'https://morphit.io',
			expectedPid: 'b'.repeat(64), // wrong pid
			nowSeconds: now,
			verifier
		});
		assert(result.kind === 'reject');
		expectEq(result.reason.kind, 'pid_mismatch');
	});

	// ─── Freshness window ────────────────────────────────────

	await scenario('verify: signed_at too old → reject', async () => {
		const { signer, verifier, account } = await makeSignerPair();
		const desktopKeys = await generateDesktopEphemeralKeys();
		const now = 1714867200;
		const { payload, compactWire } = await buildQrPayload({
			epk_pub: desktopKeys.epk_pub,
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			nowSeconds: now
		});
		const v = validateQrWireForm(compactWire, now);
		assert(v.kind === 'ok');
		const bundle = buildPairingBundle({
			qr: v.payload,
			account,
			accountChatPubkey: 'chatpub',
			nowSeconds: now - 200, // 200s old, > BUNDLE_FRESHNESS_PAST_SECONDS (120s)
			deviceLabel: 'phone'
		});
		const delivery = await buildDeliveryPayload({
			bundle,
			signer,
			desktopEpkPub: desktopKeys.epk_pub
		});
		const epkPrivCopy = new Uint8Array(desktopKeys.epk_priv);
		const result = await verifyDeliveryPayload({
			delivery,
			desktopEpkPriv: epkPrivCopy,
			desktopEpkPub: desktopKeys.epk_pub,
			desktopOrigin: 'https://morphit.io',
			expectedPid: payload.pid,
			nowSeconds: now,
			verifier
		});
		assert(result.kind === 'reject');
		expectEq(result.reason.kind, 'signed_at_too_old');
	});

	await scenario('verify: signed_at too future → reject', async () => {
		const { signer, verifier, account } = await makeSignerPair();
		const desktopKeys = await generateDesktopEphemeralKeys();
		const now = 1714867200;
		const { payload, compactWire } = await buildQrPayload({
			epk_pub: desktopKeys.epk_pub,
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			nowSeconds: now
		});
		const v = validateQrWireForm(compactWire, now);
		assert(v.kind === 'ok');
		const bundle = buildPairingBundle({
			qr: v.payload,
			account,
			accountChatPubkey: 'chatpub',
			nowSeconds: now + 100, // > BUNDLE_FRESHNESS_FUTURE_SECONDS (30s)
			deviceLabel: 'phone'
		});
		const delivery = await buildDeliveryPayload({
			bundle,
			signer,
			desktopEpkPub: desktopKeys.epk_pub
		});
		const epkPrivCopy = new Uint8Array(desktopKeys.epk_priv);
		const result = await verifyDeliveryPayload({
			delivery,
			desktopEpkPriv: epkPrivCopy,
			desktopEpkPub: desktopKeys.epk_pub,
			desktopOrigin: 'https://morphit.io',
			expectedPid: payload.pid,
			nowSeconds: now,
			verifier
		});
		assert(result.kind === 'reject');
		expectEq(result.reason.kind, 'signed_at_too_future');
	});

	// ─── Signature verification ──────────────────────────────

	await scenario('verify: signature verifier returns false → reject', async () => {
		const { signer, account } = await makeSignerPair();
		// Custom verifier that always returns false (simulates
		// chain returning a different pubkey than what signed).
		const alwaysFalse: SignatureVerifier = async () => false;
		const desktopKeys = await generateDesktopEphemeralKeys();
		const now = 1714867200;
		const { payload, compactWire } = await buildQrPayload({
			epk_pub: desktopKeys.epk_pub,
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			nowSeconds: now
		});
		const v = validateQrWireForm(compactWire, now);
		assert(v.kind === 'ok');
		const bundle = buildPairingBundle({
			qr: v.payload,
			account,
			accountChatPubkey: 'chatpub',
			nowSeconds: now,
			deviceLabel: 'phone'
		});
		const delivery = await buildDeliveryPayload({
			bundle,
			signer,
			desktopEpkPub: desktopKeys.epk_pub
		});
		const epkPrivCopy = new Uint8Array(desktopKeys.epk_priv);
		const result = await verifyDeliveryPayload({
			delivery,
			desktopEpkPriv: epkPrivCopy,
			desktopEpkPub: desktopKeys.epk_pub,
			desktopOrigin: 'https://morphit.io',
			expectedPid: payload.pid,
			nowSeconds: now,
			verifier: alwaysFalse
		});
		assert(result.kind === 'reject');
		expectEq(result.reason.kind, 'signature_invalid');
	});

	// ─── Buffer wipe defense ─────────────────────────────────

	await scenario('verify wipes desktopEpkPriv even on success', async () => {
		const { signer, verifier, account } = await makeSignerPair();
		const desktopKeys = await generateDesktopEphemeralKeys();
		const now = 1714867200;
		const { payload, compactWire } = await buildQrPayload({
			epk_pub: desktopKeys.epk_pub,
			origin: 'https://morphit.io',
			relay: 'https://morphit.io',
			nowSeconds: now
		});
		const v = validateQrWireForm(compactWire, now);
		assert(v.kind === 'ok');
		const bundle = buildPairingBundle({
			qr: v.payload,
			account,
			accountChatPubkey: 'chatpub',
			nowSeconds: now,
			deviceLabel: 'phone'
		});
		const delivery = await buildDeliveryPayload({
			bundle,
			signer,
			desktopEpkPub: desktopKeys.epk_pub
		});
		const epkPrivCopy = new Uint8Array(desktopKeys.epk_priv);
		const before = epkPrivCopy.slice();
		await verifyDeliveryPayload({
			delivery,
			desktopEpkPriv: epkPrivCopy,
			desktopEpkPub: desktopKeys.epk_pub,
			desktopOrigin: 'https://morphit.io',
			expectedPid: payload.pid,
			nowSeconds: now,
			verifier
		});
		// After verify, the priv buffer should be all zeroes.
		const allZero = epkPrivCopy.every((b) => b === 0);
		assert(allZero, 'desktopEpkPriv was not wiped');
		// Sanity: the `before` snapshot was NOT all zeroes (so
		// the test's signal isn't a false positive from a dud
		// keygen).
		const beforeAllZero = before.every((b) => b === 0);
		assert(!beforeAllZero, 'pre-verify buffer was already zero (test setup bug)');
	});

	console.log(
		`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
	);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
