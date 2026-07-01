/**
 * Morphit — backup-key derivation for the "your keys" panel.
 *
 * Morphit-created accounts derive their four Blurt keys from a BIP-39 seed
 * (keygen.ts / ADR-0007). The seed and the encrypted keyfile let a user
 * restore the account *inside Morphit*, but other Blurt tools
 * (blurtwallet.com, Blurt Keychain, …) don't understand Morphit's seed —
 * they import the individual role keys as WIFs. So to make a
 * Morphit-created account portable, we expose the four private keys in
 * standard WIF form (plus the public keys) at backup time.
 *
 * This module turns a live FullIdentity into the display/export shape. The
 * WIFs are byte-identical to what dblurt / blurtwallet.com produce (proven
 * against dblurt). It does no I/O and holds nothing: the caller derives,
 * shows, and lets the result go when the user navigates away.
 *
 * SECURITY: the returned WIFs are full private keys. The caller must treat
 * the result as sensitive — show it only behind an explicit reveal, never
 * log it, and don't persist it.
 */

import { KEY_ROLES, formatPublicKeyBLT, type KeyRole, type FullIdentity } from './keygen';
import { rawPrivateKeyToWif } from './wif';

export interface BackupKey {
	readonly role: KeyRole;
	/** BLT-prefixed public key (safe to share — it's on-chain already). */
	readonly pub: string;
	/** Uncompressed "5…" WIF private key (SECRET — never share). */
	readonly wif: string;
}

/**
 * Derive the public (BLT) + private (WIF) string for every key role present
 * on the identity, in the canonical owner→active→posting→memo order.
 *
 * For a 'morphit-seed' identity all four roles are present. For a
 * 'posting-only' identity only `posting` exists; the null owner/active/memo
 * slots are skipped (you can't reconstruct what was never derived).
 */
export async function deriveBackupKeys(full: FullIdentity): Promise<BackupKey[]> {
	const out: BackupKey[] = [];
	for (const role of KEY_ROLES) {
		const kp = full.keys[role];
		if (!kp) continue; // posting-only: owner/active/memo are null
		const pub = await formatPublicKeyBLT(kp.publicKey);
		const wif = await rawPrivateKeyToWif(kp.privateKey);
		out.push({ role, pub, wif });
	}
	return out;
}
