/**
 * Morphit — YubiKey HMAC-SHA1 challenge-response (Batch I, ADR-0017).
 *
 * Wraps/unwraps a CEK using the YubiKey's HMAC-SHA1 slot as the
 * primary entropy source.  The HMAC output is run through Argon2id
 * before use as a wrap key (see threat model T5 in protocol.ts).
 *
 * Architecture split:
 *   - Pure helpers live here: build/recover wrap given an HMAC
 *     callback.  Smoke-testable with a stub HMAC.
 *   - WebHID transport lives in `transport.ts` (browser-only, not
 *     smoke-testable in the sandbox).  Transport returns a function
 *     that performs an HMAC operation; the helpers in this file
 *     consume that callback.
 *
 * The split lets us test the wrap/unwrap math without an actual
 * YubiKey, and lets the UI swap between "real YubiKey" and "test
 * fixture" cleanly.  Production callers always wire the WebHID
 * transport; tests wire a deterministic stub.
 */

import sodium from 'libsodium-wrappers-sumo';
import { ensureSodium } from '../keygen';
import {
	YUBIKEY_CHALLENGE_BYTES,
	YUBIKEY_HMAC_OUTPUT_BYTES,
	type YubikeySlot,
	type WrappedCekYubikey,
	type YubikeyArgonParams,
	CEK_BYTES,
	CEK_NONCE_BYTES,
	ARGON_SALT_BYTES,
	YUBIKEY_WRAP_SCHEMA_VERSION
} from './protocol';

/** A function that performs HMAC-SHA1 against the YubiKey slot
 *  configured for challenge-response.  Production wires this to
 *  the WebHID transport; tests wire it to a deterministic HMAC.
 *
 *  Contract:
 *   - challenge.length === YUBIKEY_CHALLENGE_BYTES
 *   - returned bytes are HMAC-SHA1(slot_secret, challenge), exactly
 *     YUBIKEY_HMAC_OUTPUT_BYTES (20 bytes).
 *   - rejects if the user removes the YubiKey, denies the touch
 *     prompt, or the slot isn't configured for HMAC-SHA1.
 *
 *  The slot field on a wrap is informational — it tells the UI
 *  which slot to ask the transport for.  The transport itself
 *  doesn't take a slot from this callback shape because the same
 *  transport instance is bound to one slot at construction time;
 *  asking the user to switch slots mid-unlock would be confusing. */
export type YubikeyHmacFn = (challenge: Uint8Array) => Promise<Uint8Array>;

/** Defensive minimums for the wrap-Argon2id params, mirroring the
 *  passphrase wrap floor (see keystore.ts comment for full
 *  rationale).  cp138 C-1: raised from (1, 1 MB) to libsodium's
 *  INTERACTIVE values (2, 64 MiB) to close the M4 latent
 *  downgrade-attack vector identified by the 2026-04-28 batch-I
 *  audit.  A tampered envelope cannot claim weak params here. */
const MIN_ARGON_OPSLIMIT = 2; // crypto_pwhash_OPSLIMIT_INTERACTIVE
const MIN_ARGON_MEMLIMIT = 64 * 1024 * 1024; // 64 MiB = crypto_pwhash_MEMLIMIT_INTERACTIVE

function assertSafeKdfParams(p: YubikeyArgonParams): void {
	if (
		typeof p.opslimit !== 'number' ||
		typeof p.memlimit !== 'number' ||
		p.opslimit < MIN_ARGON_OPSLIMIT ||
		p.memlimit < MIN_ARGON_MEMLIMIT
	) {
		throw new Error('YubiKey wrap has invalid or unsafe KDF parameters');
	}
}

function toB64(bytes: Uint8Array): string {
	return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function fromB64(s: string): Uint8Array {
	return sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
}

/** Argon2id INTERACTIVE params, fetched after sodium is ready.
 *  Mirrors the passphrase wrap's params so a stolen-keystore
 *  attacker doesn't have a cheaper path through the YubiKey wrap. */
function argonParams(): YubikeyArgonParams {
	return {
		opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
		memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
	};
}

/** Argon2id derivation: HMAC output -> wrap key.
 *
 *  We treat the HMAC output as a "password" passed to Argon2id.
 *  This is the same defensive-stretch pattern KeePassXC and
 *  age-yubikey use — even though the HMAC output is already
 *  high-entropy (~160 bits assuming the slot secret is full
 *  entropy), running it through Argon2id costs an attacker GPU
 *  time to brute-force IF they ever obtain a brief read of the
 *  HMAC output during unwrap (T5).  Floors a worst-case
 *  exposure window. */
async function deriveWrapKey(
	hmacOutput: Uint8Array,
	salt: Uint8Array,
	params: YubikeyArgonParams
): Promise<Uint8Array> {
	if (hmacOutput.length !== YUBIKEY_HMAC_OUTPUT_BYTES) {
		throw new Error(
			`deriveWrapKey: HMAC output must be ${YUBIKEY_HMAC_OUTPUT_BYTES} bytes, got ${hmacOutput.length}`
		);
	}
	// libsodium's pwhash takes a string OR Uint8Array.  We pass the
	// raw HMAC bytes — sodium accepts a Uint8Array in this slot.
	return sodium.crypto_pwhash(
		sodium.crypto_secretbox_KEYBYTES,
		hmacOutput,
		salt,
		params.opslimit,
		params.memlimit,
		sodium.crypto_pwhash_ALG_ARGON2ID13
	);
}

/** Build a YubiKey wrap for a layered envelope.  Generates a fresh
 *  64-byte challenge, sends it to the YubiKey via the supplied
 *  HMAC callback, derives a wrap key, encrypts the CEK to it.
 *
 *  Caller responsibilities:
 *   - cek: the CEK to wrap.  Caller owns the buffer; we read it,
 *     don't zero it.  Caller's own finally must wipe.
 *   - hmacFn: must be already bound to the user's intended slot.
 *   - slot: the slot label to record on the envelope (informational).
 *   - label: friendly label ("Work YubiKey").  Empty string OK.
 */
export async function buildYubikeyWrap(
	cek: Uint8Array,
	hmacFn: YubikeyHmacFn,
	slot: YubikeySlot,
	label: string
): Promise<WrappedCekYubikey> {
	await ensureSodium();
	if (cek.length !== CEK_BYTES) {
		throw new Error('buildYubikeyWrap: CEK has wrong length');
	}
	const challenge = sodium.randombytes_buf(YUBIKEY_CHALLENGE_BYTES);
	let hmac: Uint8Array | null = null;
	let wrapKey: Uint8Array | null = null;
	try {
		hmac = await hmacFn(challenge);
		if (hmac.length !== YUBIKEY_HMAC_OUTPUT_BYTES) {
			throw new Error(
				`YubiKey returned ${hmac.length}-byte HMAC, expected ${YUBIKEY_HMAC_OUTPUT_BYTES}`
			);
		}
		const salt = sodium.randombytes_buf(ARGON_SALT_BYTES);
		const params = argonParams();
		wrapKey = await deriveWrapKey(hmac, salt, params);
		// Zero the HMAC output as soon as it's been consumed by the KDF.
		sodium.memzero(hmac);
		hmac = null;
		const wrapNonce = sodium.randombytes_buf(CEK_NONCE_BYTES);
		const wrapCt = sodium.crypto_secretbox_easy(cek, wrapNonce, wrapKey);
		sodium.memzero(wrapKey);
		wrapKey = null;
		return {
			kind: 'yubikey',
			schemaVersion: YUBIKEY_WRAP_SCHEMA_VERSION,
			slot,
			challenge: toB64(challenge),
			kdf: 'argon2id',
			kdfParams: params,
			salt: toB64(salt),
			nonce: toB64(wrapNonce),
			ciphertext: toB64(wrapCt),
			label,
			enrolledAt: Date.now()
		};
	} finally {
		if (hmac) sodium.memzero(hmac);
		if (wrapKey) sodium.memzero(wrapKey);
	}
}

/** Recover a CEK from a YubiKey wrap.  Called during unlock.
 *
 *  Returns the 32-byte CEK on success.  Throws on transport
 *  failure (user yanked the key, denied touch, slot not
 *  configured) or on AEAD failure (envelope was tampered).
 *
 *  Caller owns the returned CEK buffer.  Wipe in a finally. */
export async function recoverCekFromYubikey(
	wrap: WrappedCekYubikey,
	hmacFn: YubikeyHmacFn
): Promise<Uint8Array> {
	await ensureSodium();
	if (wrap.schemaVersion !== YUBIKEY_WRAP_SCHEMA_VERSION) {
		throw new Error(`Unsupported YubiKey wrap schema: ${wrap.schemaVersion}`);
	}
	assertSafeKdfParams(wrap.kdfParams);

	const challenge = fromB64(wrap.challenge);
	if (challenge.length !== YUBIKEY_CHALLENGE_BYTES) {
		throw new Error(
			`YubiKey wrap challenge has wrong length: ${challenge.length} vs ${YUBIKEY_CHALLENGE_BYTES}`
		);
	}
	const salt = fromB64(wrap.salt);
	const wrapNonce = fromB64(wrap.nonce);
	const wrapCt = fromB64(wrap.ciphertext);

	let hmac: Uint8Array | null = null;
	let wrapKey: Uint8Array | null = null;
	try {
		hmac = await hmacFn(challenge);
		if (hmac.length !== YUBIKEY_HMAC_OUTPUT_BYTES) {
			throw new Error(
				`YubiKey returned ${hmac.length}-byte HMAC, expected ${YUBIKEY_HMAC_OUTPUT_BYTES}`
			);
		}
		wrapKey = await deriveWrapKey(hmac, salt, wrap.kdfParams);
		sodium.memzero(hmac);
		hmac = null;
		const cek = sodium.crypto_secretbox_open_easy(wrapCt, wrapNonce, wrapKey);
		sodium.memzero(wrapKey);
		wrapKey = null;
		if (cek.length !== CEK_BYTES) {
			sodium.memzero(cek);
			throw new Error('YubiKey-unwrapped CEK has wrong length');
		}
		return cek;
	} finally {
		if (hmac) sodium.memzero(hmac);
		if (wrapKey) sodium.memzero(wrapKey);
	}
}
