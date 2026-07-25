/**
 * Morphit — resolving an ACTIVE key from what an existing Blurt user actually
 * has in their hands.
 *
 * Context (Ken, tt.txt #11/#12): the 12-word seed and the Keyfile are Morphit
 * inventions. A user who has been on Blurt for years has neither. They have an
 * **Active key** in WIF form (`5…`), copied out of some other wallet — and that
 * is the ONLY thing Morphit accepts here.
 *
 * Morphit never accepts an account-wide secret that deterministically derives
 * every role's key (owner included). Taking one would let this flow reach the
 * OWNER key — the key that can take over the whole account — which flatly
 * violates the security model (security is priority #2, behind privacy). A
 * user whose only wallet secret derives all roles must export their Active key
 * (WIF) in a wallet they already trust and paste THAT; we never touch the
 * account-wide secret, and never mention or ask for one.
 *
 * ─── What this module refuses to do ────────────────────────────────────────
 *
 * It never *assumes* a pasted WIF is the right key. It derives the public key
 * and checks it against the account's on-chain authorities. That matters for
 * three reasons:
 *
 *   1. A user who pastes their **Posting key** here gets told exactly that,
 *      instead of a mystifying "couldn't sign the transfer" after the fact.
 *   2. A user who pastes their **Owner key** — the key that can steal the
 *      account — is refused outright. Owner keys have no business in a
 *      transfer flow, and quietly accepting one teaches a catastrophic habit.
 *   3. A typo produces "that isn't this account's Active key", not a broadcast
 *      that fails at the chain.
 *
 * Everything here is pure: authorities in, verdict out. No fetching, no
 * keystore writes, no UI. That keeps the decision testable, which is the point
 * — this is the gate in front of the money.
 */

import { looksLikeWif, wifToRawPrivateKey } from '$crypto/wif';
import { formatPublicKeyBLT } from '$crypto/keygen';
import * as secp256k1 from '@noble/secp256k1';

/** The on-chain authorities we compare against (from the indexer /keys proxy). */
export interface AccountAuthorityKeys {
	readonly active: readonly string[];
	readonly posting: readonly string[];
	readonly owner: readonly string[];
}

export type UnlockFailure =
	/** Parsed as a WIF, but the string is malformed (bad checksum, bad base58)
	 *  — or isn't a WIF at all. Morphit only accepts an Active-key WIF here. */
	| 'invalid_wif'
	/** A valid WIF, but it is this account's POSTING authority. */
	| 'is_posting_key'
	/** A valid WIF, but it is this account's OWNER authority. */
	| 'is_owner_key'
	/** Derives nothing this account recognises: wrong account, or a typo. */
	| 'not_this_account'
	/** The secret is empty or unusable. */
	| 'empty';

export type UnlockResult =
	| { ok: true; scalar: Uint8Array; source: 'wif' }
	| { ok: false; reason: UnlockFailure };

/** Is the pasted string shaped like a WIF? An Active-key WIF is the only thing
 *  this flow accepts; anything else is rejected (never tried as an account-wide
 *  secret). */
export function classifySecret(secret: string): 'wif' | 'not_wif' | 'empty' {
	const t = secret.trim();
	if (t.length === 0) return 'empty';
	return looksLikeWif(t) ? 'wif' : 'not_wif';
}

/** secp256k1 scalar → BLT-prefixed compressed public key string. */
async function pubKeyOf(scalar: Uint8Array): Promise<string | null> {
	try {
		if (!secp256k1.utils.isValidPrivateKey(scalar)) return null;
		return await formatPublicKeyBLT(secp256k1.getPublicKey(scalar, true));
	} catch {
		return null;
	}
}

/** Constant-ish membership test over a small list of public-key strings. */
function matches(list: readonly string[], pub: string): boolean {
	return list.some((k) => k === pub);
}

/**
 * Given the WIF the user pasted, decide whether it is THIS account's ACTIVE
 * key — and if not, say precisely why. Only an Active-key WIF is accepted; a
 * string that isn't a WIF is rejected as `invalid_wif` rather than tried as any
 * account-wide secret.
 *
 * `account` is retained for the caller's error copy; resolution itself is
 * purely WIF → public key → authority membership.
 */
export async function resolveActiveKey(
	_account: string,
	secret: string,
	authorities: AccountAuthorityKeys
): Promise<UnlockResult> {
	const kind = classifySecret(secret);
	if (kind === 'empty') return { ok: false, reason: 'empty' };
	// Only a raw Active-key WIF is accepted. Anything else — including an
	// account-wide secret that could derive every role's key (owner included) —
	// is refused here; taking such a secret would violate the security model.
	if (kind === 'not_wif') return { ok: false, reason: 'invalid_wif' };
	const t = secret.trim();

	let scalar: Uint8Array;
	try {
		scalar = await wifToRawPrivateKey(t);
	} catch {
		return { ok: false, reason: 'invalid_wif' };
	}
	// cp445 deep-deep — on every REFUSAL path this scalar is real, derived
	// private key material (possibly the OWNER key, which is exactly the one
	// we refuse) and nothing downstream will ever wipe it: only the success
	// path hands it to a caller that does. Zero it before we leave.
	let handedOff = false;
	try {
		const pub = await pubKeyOf(scalar);
		if (pub === null) return { ok: false, reason: 'invalid_wif' };

		if (matches(authorities.active, pub)) {
			handedOff = true;
			return { ok: true, scalar, source: 'wif' };
		}
		// Order matters: owner is the dangerous one, name it first.
		if (matches(authorities.owner, pub)) return { ok: false, reason: 'is_owner_key' };
		if (matches(authorities.posting, pub)) return { ok: false, reason: 'is_posting_key' };
		return { ok: false, reason: 'not_this_account' };
	} finally {
		if (!handedOff) scalar.fill(0);
	}
}
