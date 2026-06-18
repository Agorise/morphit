/**
 * Morphit — Bitcoin/Blurt-style WIF decoder.
 *
 * Used by the posting-key-only import path (Batch H) to parse WIFs
 * exported from blurtwallet.com (or any other Blurt frontend).
 *
 * Wire format (Bitcoin WIF, identical to the Steem/Hive/Blurt family):
 *
 *   payload = version_byte(0x80) || scalar_32B || [compression_flag(0x01)]
 *   wif     = base58(payload || sha256d(payload)[0..4])
 *
 * Total WIF length is 51 chars (uncompressed) or 52 chars (compressed,
 * the modern norm — Blurt frontends emit compressed WIFs starting with
 * `5J`, `5K`, or `5H`).  Either form decodes to the same 32-byte scalar;
 * we accept both and discard the compression flag.
 *
 * The decoder does NOT depend on dblurt or @beblurt/dblurt — those carry
 * a far larger graphene-stack surface than we need for one parser.  It
 * uses libsodium's crypto_hash_sha256 (already in our bundle) for the
 * checksum step.
 *
 * Security:
 *   - Constant-time NOT required: WIFs are user-supplied, not secrets
 *     compared against a server. The user pasted it themselves.
 *   - We DO sodium.memzero the decoded scalar in error paths so a
 *     thrown decode failure doesn't leave key material on the heap.
 *
 * Returns the raw 32-byte scalar so the caller (importPostingOnlyIdentity)
 * can hand it directly to keygen's existing keypair plumbing.
 */

import sodium from 'libsodium-wrappers-sumo';
import * as secp256k1 from '@noble/secp256k1';
import { ensureSodium } from './keygen';
import { wifDecodePure, base58Encode } from './base58';

export { looksLikeWif } from './base58';

// ──────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────

/** Decode failure modes we expose to the UI as distinct i18n strings. */
export type WifError =
	| 'too-short'
	| 'too-long'
	| 'bad-charset'
	| 'bad-version'
	| 'bad-checksum'
	| 'bad-length'
	| 'bad-scalar';

export class WifDecodeError extends Error {
	readonly code: WifError;
	constructor(code: WifError, message: string) {
		super(message);
		this.code = code;
		this.name = 'WifDecodeError';
	}
}

// ──────────────────────────────────────────────────────────────────────
// WIF decode
// ──────────────────────────────────────────────────────────────────────

/**
 * Decode a Bitcoin-style WIF to a raw 32-byte secp256k1 scalar.
 *
 * Thin wrapper that wires libsodium's SHA-256 into the pure decoder
 * in `base58.ts`, then translates the verdict into a thrown
 * WifDecodeError on failure.  All of the actual length/version/
 * checksum logic lives in wifDecodePure so smokes can exercise it
 * without libsodium.
 *
 * Throws WifDecodeError with a precise `code` for UI-side i18n.
 *
 * The returned Uint8Array is freshly allocated; caller owns it and is
 * responsible for memzero'ing once consumed.
 */
export async function wifToRawPrivateKey(wif: string): Promise<Uint8Array> {
	await ensureSodium();
	const sha256 = async (b: Uint8Array): Promise<Uint8Array> => sodium.crypto_hash_sha256(b);
	const verdict = await wifDecodePure(wif, sha256);
	if (!verdict.ok) {
		throw new WifDecodeError(verdict.code, `WIF decode failed: ${verdict.code}`);
	}
	// L2 fix: ensure the decoded scalar is in [1, N-1] for secp256k1.
	// wifDecodePure already rejects all-zeros; this catches the
	// vanishingly-rare-but-attacker-constructible case of a scalar
	// >= curve order.
	if (!secp256k1.utils.isValidPrivateKey(verdict.scalar)) {
		// Wipe before throwing so the bad-scalar bytes don't linger.
		for (let i = 0; i < verdict.scalar.length; i++) verdict.scalar[i] = 0;
		throw new WifDecodeError('bad-scalar', 'WIF scalar is not a valid secp256k1 private key');
	}
	return verdict.scalar;
}

/**
 * Encode a raw 32-byte secp256k1 scalar as an (uncompressed) Bitcoin/Blurt
 * WIF — the "5..."-prefixed string that blurtwallet.com and every other
 * Blurt tool accepts for key import.  The inverse of wifToRawPrivateKey,
 * and the export complement ADR-0007 reserved for "Phase 5".  Used by the
 * account-backup "your keys" panel so a Morphit-created account (whose
 * keys are otherwise only reachable through Morphit's BIP-39 seed) is
 * portable to any Blurt frontend.
 *
 * Format (uncompressed — matching what Blurt frontends display and what a
 * user pastes back):
 *   payload  = 0x80 || scalar(32)
 *   checksum = sha256(sha256(payload))[0..4]
 *   wif      = base58(payload || checksum)         // 51 chars, "5..."
 *
 * Best-effort wipes the internal copies that held the scalar on the way
 * out; the caller still owns (and must wipe) `scalar`.
 *
 * Throws if `scalar` is not exactly 32 bytes or is not a valid secp256k1
 * private key — encoding a malformed scalar would hand the user a WIF no
 * chain would ever accept, which is worse than a clear error.
 */
export async function rawPrivateKeyToWif(scalar: Uint8Array): Promise<string> {
	await ensureSodium();
	if (scalar.length !== 32) {
		throw new Error(`rawPrivateKeyToWif: scalar must be 32 bytes, got ${scalar.length}`);
	}
	if (!secp256k1.utils.isValidPrivateKey(scalar)) {
		throw new Error('rawPrivateKeyToWif: scalar is not a valid secp256k1 private key');
	}
	const payload = new Uint8Array(33);
	payload[0] = 0x80;
	payload.set(scalar, 1);
	const checksum = sodium.crypto_hash_sha256(sodium.crypto_hash_sha256(payload));
	const full = new Uint8Array(37);
	full.set(payload, 0);
	full.set(checksum.subarray(0, 4), 33);
	const wif = base58Encode(full);
	// Best-effort wipe of the copies that contained the scalar.
	payload.fill(0);
	full.fill(0);
	return wif;
}
