/**
 * Morphit — Blurt master-password DETECTION (import safety net).
 *
 * Morphit never uses, generates, or stores a Blurt "master password": our
 * keys come from a BIP-39 seed (see keygen.ts / ADR-0007), not the legacy
 * `account + role + password` derivation. But other Blurt frontends DO use
 * master passwords, so a new user importing a posting-only login may paste
 * their master password into the posting-key field by mistake. A raw WIF
 * decoder just sees "not a valid key" and emits a generic error; this
 * module lets the import flow recognise the specific case and tell the
 * user *exactly* what they pasted ("that's your master password, not your
 * posting key").
 *
 * Derivation (verified byte-for-byte against @beblurt/dblurt's
 * PrivateKey.fromLogin → fromSeed):
 *
 *   scalar = sha256( utf8( account + role + password ) )
 *
 * We then derive the secp256k1 public key from that scalar and format it
 * through the SAME formatPublicKeyBLT path keygen uses, so the resulting
 * BLT-string is directly comparable to the account's on-chain key_auths
 * (what verifyPostingKey checks).
 *
 * This is DETECTION ONLY — Morphit does not log in via master password.
 * The derived scalar is wiped immediately; only the public string is
 * returned. No private material leaves this function.
 */

import sodium from 'libsodium-wrappers-sumo';
import * as secp256k1 from '@noble/secp256k1';
import { ensureSodium, formatPublicKeyBLT, type KeyRole } from './keygen';

/**
 * Derive the BLT-prefixed public key that a Blurt master password would
 * produce for the given account + role. Returns the public-key string, or
 * null if the derived scalar isn't a valid secp256k1 key (so callers can
 * treat "couldn't derive" as "not a master password" without a throw).
 *
 * @param account   lowercase Blurt account name (the user typed it)
 * @param role      which authority to derive ('posting' for login checks)
 * @param password  the candidate string the user pasted
 */
export async function masterPasswordScalar(
	account: string,
	role: KeyRole,
	password: string
): Promise<Uint8Array | null> {
	await ensureSodium();
	// sha256 over UTF-8 bytes of (account + role + password), matching
	// dblurt's PrivateKey.fromSeed(account + role + password).
	const scalar = sodium.crypto_hash_sha256(sodium.from_string(account + role + password));
	if (!secp256k1.utils.isValidPrivateKey(scalar)) return null;
	return scalar;
}

export async function masterPasswordPubKey(
	account: string,
	role: KeyRole,
	password: string
): Promise<string | null> {
	await ensureSodium();
	// Derived in exactly ONE place (`masterPasswordScalar`) so the public and
	// private paths can never disagree about what a master password means.
	const scalar = sodium.crypto_hash_sha256(sodium.from_string(account + role + password));
	try {
		if (!secp256k1.utils.isValidPrivateKey(scalar)) return null;
		// 33-byte compressed point — the shape formatPublicKeyBLT expects
		// and the shape Blurt stores in key_auths.
		const pub = secp256k1.getPublicKey(scalar, true);
		return await formatPublicKeyBLT(pub);
	} catch {
		return null;
	} finally {
		// The scalar is derived key material — wipe it as soon as we have
		// the public string. Best-effort (JS can't truly zero GC copies).
		scalar.fill(0);
	}
}
