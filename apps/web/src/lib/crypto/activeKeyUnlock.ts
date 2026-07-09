/**
 * Morphit — resolving an ACTIVE key from what an existing Blurt user actually
 * has in their hands.
 *
 * Context (Ken, tt.txt #11/#12): the 12-word seed and the Keyfile are Morphit
 * inventions. A user who has been on Blurt for years has neither. They have:
 *
 *   • an **Active key** in WIF form (`5…`), copied out of some other wallet, or
 *   • a **master password**, from which Blurt derives every role's key
 *     (`sha256(account + role + password)`) — the pre-fork Steem-era model.
 *
 * So the unlock step must accept BOTH, and it must tell the two apart without
 * asking the user which one they pasted — because they frequently don't know.
 *
 * ─── What this module refuses to do ────────────────────────────────────────
 *
 * It never *assumes* a pasted secret is the right key. It derives the public
 * key and checks it against the account's on-chain authorities. That matters
 * for three reasons:
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
import { masterPasswordPubKey, masterPasswordScalar } from '$crypto/masterPassword';
import { formatPublicKeyBLT } from '$crypto/keygen';
import * as secp256k1 from '@noble/secp256k1';

/** The on-chain authorities we compare against (from the indexer /keys proxy). */
export interface AccountAuthorityKeys {
	readonly active: readonly string[];
	readonly posting: readonly string[];
	readonly owner: readonly string[];
}

export type UnlockFailure =
	/** Parsed as a WIF, but the string is malformed (bad checksum, bad base58). */
	| 'invalid_wif'
	/** Valid key/password, but it derives this account's POSTING authority. */
	| 'is_posting_key'
	/** Valid key/password, but it derives this account's OWNER authority. */
	| 'is_owner_key'
	/** Derives nothing this account recognises: wrong account, or a typo. */
	| 'not_this_account'
	/** The secret is empty or unusable. */
	| 'empty';

export type UnlockResult =
	| { ok: true; scalar: Uint8Array; source: 'wif' | 'master_password' }
	| { ok: false; reason: UnlockFailure };

/** Which shape did the user paste? We guess, then verify. */
export function classifySecret(secret: string): 'wif' | 'master_password' | 'empty' {
	const t = secret.trim();
	if (t.length === 0) return 'empty';
	return looksLikeWif(t) ? 'wif' : 'master_password';
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
 * Given what the user pasted, decide whether it unlocks THIS account's active
 * authority — and if not, say precisely why.
 *
 * The master-password branch derives the ACTIVE role. We also derive the
 * posting and owner roles from the same password so that a user who typed a
 * password belonging to a *different* account gets `not_this_account` rather
 * than a misleading `is_posting_key`.
 */
export async function resolveActiveKey(
	account: string,
	secret: string,
	authorities: AccountAuthorityKeys
): Promise<UnlockResult> {
	const kind = classifySecret(secret);
	if (kind === 'empty') return { ok: false, reason: 'empty' };
	const t = secret.trim();

	if (kind === 'wif') {
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

	// Master password: derive each role and see which authority it satisfies.
	const activePub = await masterPasswordPubKey(account, 'active', t);
	if (activePub !== null && matches(authorities.active, activePub)) {
		const scalar = await masterPasswordScalar(account, 'active', t);
		if (scalar !== null) return { ok: true, scalar, source: 'master_password' };
	}
	const ownerPub = await masterPasswordPubKey(account, 'owner', t);
	if (ownerPub !== null && matches(authorities.owner, ownerPub)) {
		// The password derives owner but NOT active: an account whose active
		// authority was rotated away from the master password. Refuse rather than
		// silently reach for the owner key.
		return { ok: false, reason: 'is_owner_key' };
	}
	const postingPub = await masterPasswordPubKey(account, 'posting', t);
	if (postingPub !== null && matches(authorities.posting, postingPub)) {
		return { ok: false, reason: 'is_posting_key' };
	}
	return { ok: false, reason: 'not_this_account' };
}
