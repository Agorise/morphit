/**
 * Morphit — posting-key import verification (Batch H).
 *
 * Given a Blurt account fetched from chain and a public-key string
 * derived from a pasted WIF, classify which authority slot (if any)
 * it belongs to.  This is the safety net that prevents:
 *
 *   1. Typos: pasted key doesn't match anything on the named account
 *      → reject with "this key doesn't belong to <account>"
 *   2. Wrong-role pastes: user pasted their ACTIVE or OWNER key
 *      thinking it was their posting key → reject loudly
 *   3. Memo-key pastes: same family of mistake; they wanted posting
 *      → reject with a memo-key-specific message
 *
 * Pure logic — no chain I/O.  The caller does the fetch and hands us
 * the account shape; we hand back a verdict.  This split lets us
 * smoke-test the classification logic without needing dblurt or a
 * live chain connection.
 *
 * Why "in-key_auths" rather than equality on a single key?  Blurt
 * authority objects can carry multiple keys with weights (multisig).
 * The user's posting key just needs to be PRESENT in posting.key_auths
 * with non-zero weight — it doesn't have to be the only one or the
 * primary one.
 *
 * Memo handling: Blurt accounts carry `memo_key` as a single string,
 * not an authority object.  We compare directly.
 */

import type { BlurtAccount } from '$blurt/client';

export type PostingKeyVerdict =
	| { kind: 'ok' }
	| { kind: 'wrong-role'; foundIn: 'active' | 'owner' | 'memo' }
	| { kind: 'not-found' };

/**
 * Classify where (if anywhere) `pubKeyBLT` appears on the given account.
 *
 * @param account  Blurt account as fetched from condenser_api.get_accounts.
 *                 Pass the BlurtAccount object exactly as returned.
 * @param pubKeyBLT  Public key in canonical BLT-prefixed string form
 *                 (the format the chain stores in key_auths).  Use
 *                 `formatPublicKeyBLT(...)` from $crypto/keygen to
 *                 build this from a raw 33-byte compressed point.
 *
 * Returns:
 *   - { kind: 'ok' } when pubKeyBLT is in account.posting.key_auths
 *     with non-zero weight AND NOT in any privileged authority.
 *     This is the only path that lets the import succeed.
 *   - { kind: 'wrong-role', foundIn: 'active' | 'owner' | 'memo' }
 *     when the key was found on the account but in the wrong slot.
 *     If the key appears in BOTH posting and a privileged slot
 *     (very unusual, possible under a hostile RPC), the privileged
 *     slot wins and we surface wrong-role.  The UI surfaces a
 *     screaming-error explaining what the user pasted.
 *   - { kind: 'not-found' } when the key isn't on this account at
 *     all.  Likely a typo in the account name, or the user pasted
 *     a key from a different account.
 *
 * Audit 2026-05 finding 1-9: privileged slots win ties.  Pre-fix,
 * posting won ties — but a hostile RPC could craft a
 * posting.key_auths that contains the user's owner pubkey
 * alongside the legitimate posting key.  The user pastes their
 * OWNER key thinking it's posting; verifyPostingKey returned `ok`
 * because the owner pubkey was also present in posting.key_auths.
 * The owner key would then be used for chat/order signing.
 * Now we check active/owner/memo first and reject any cross-role
 * appearance before checking posting alone.
 */
export function verifyPostingKey(account: BlurtAccount, pubKeyBLT: string): PostingKeyVerdict {
	// Check privileged authorities first.  Any match here is a
	// wrong-role rejection regardless of whether the key also
	// appears in posting.key_auths.
	if (hasKey(account.owner, pubKeyBLT)) {
		return { kind: 'wrong-role', foundIn: 'owner' };
	}
	if (hasKey(account.active, pubKeyBLT)) {
		return { kind: 'wrong-role', foundIn: 'active' };
	}
	if (account.memo_key === pubKeyBLT) {
		return { kind: 'wrong-role', foundIn: 'memo' };
	}
	if (hasKey(account.posting, pubKeyBLT)) {
		return { kind: 'ok' };
	}
	return { kind: 'not-found' };
}

/** Does the authority's key_auths list contain pubKeyBLT with
 *  non-zero weight?  We allow any non-zero weight here; reasoning
 *  for permissive acceptance: even if the key alone wouldn't meet
 *  weight_threshold (e.g. a 2-of-3 multisig), it can still validly
 *  sign Morphit's chain ops because Blurt accumulates signatures
 *  per-tx.  If the key is part of the authority structure with
 *  weight > 0, the user owns this slot.
 *
 *  L10 fix: defensive check against a hostile RPC that returns a
 *  non-array key_auths.  for...of would error on a non-iterable;
 *  treat it as "key not present" instead so the caller surfaces a
 *  meaningful error rather than crashing. */
function hasKey(auth: { key_auths: Array<[string, number]> }, pubKeyBLT: string): boolean {
	if (!auth || !Array.isArray(auth.key_auths)) return false;
	for (const entry of auth.key_auths) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const [k, w] = entry;
		if (k === pubKeyBLT && typeof w === 'number' && w > 0) return true;
	}
	return false;
}
