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
import { wifDecodePure } from './base58';

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
