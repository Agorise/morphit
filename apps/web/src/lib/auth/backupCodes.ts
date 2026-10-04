/**
 * Morphit — TOTP backup codes (single-use, hashed at rest).
 *
 * Generated at 2FA enrollment time alongside the TOTP secret.  The
 * user is FORCED to confirm "I've saved these somewhere safe" before
 * the enrollment flow completes — there's no second chance to see
 * the plaintext codes.
 *
 * Codes are:
 *   - 8 characters long
 *   - Drawn from a 32-character alphabet without the look-alikes
 *     0/O and 1/I (A–Z minus I and O, plus 2–9; not Crockford's
 *     base32) → 32^8 ≈ 2^40 possible codes per slot
 *   - Display-formatted as `XXXX-XXXX` for readability (the dash is
 *     ignored at redemption — users can type either form)
 *
 * Storage model:
 *   - 10 codes generated.  Each is hashed with Argon2id at libsodium's
 *     INTERACTIVE cost (64 MiB, 2 passes) before being persisted inside
 *     the encrypted keystore.
 *   - At redemption time: hash the user's input with each stored
 *     hash's salt and check.  First match consumes that slot.
 *   - Each slot is single-use.  The "used" flag is flipped in the
 *     keystore and the keystore is re-saved.
 *
 * Honest framing in the UI:
 *   - These are EQUIVALENT TO YOUR TOTP CODE — losing all 10
 *     means losing recoverable access if you also lose your
 *     authenticator app.
 *   - The codes don't unlock the keystore on their own; you still
 *     need the password.  This is a "second-factor recovery" tool,
 *     not a "password recovery" tool.
 *   - If you lose BOTH password and codes and authenticator, the
 *     keystore is gone.  Morphit can't help — non-custodial.  This
 *     is why the seed phrase exists at signup; that's the disaster-
 *     recovery path.
 */

import sodium from 'libsodium-wrappers-sumo';
import { ensureSodium } from '../crypto/keygen';

/** 32 characters without the look-alikes 0/O and 1/I. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Length of each backup code (in alphabet characters). */
export const BACKUP_CODE_LENGTH = 8;
/** Number of codes generated at enrollment. */
export const BACKUP_CODE_COUNT = 10;

/** One stored backup-code slot.  The codes themselves are NOT
 *  stored plaintext after enrollment — only the Argon2id hash. */
export interface BackupCodeSlot {
	/** Argon2id hash of the canonical code (no dash, uppercased). */
	readonly hash: string;
	/** Whether this slot has been redeemed. */
	used: boolean;
	/** When this slot was redeemed, unix ms (0 = unused). */
	usedAt: number;
}

/** Generate one random 8-character backup code.  Uses
 *  `crypto.getRandomValues` for cryptographic-quality randomness. */
function generateOneCode(): string {
	const bytes = new Uint8Array(BACKUP_CODE_LENGTH);
	crypto.getRandomValues(bytes);
	let code = '';
	for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
		// Modulo-bias from 256 % 32 = 0 → unbiased.  We can use the
		// byte directly.  (If we had a non-power-of-2 alphabet this
		// would need rejection sampling.)
		code += ALPHABET[bytes[i]! & 0x1f];
	}
	return code;
}

/** Canonical form: uppercase, no dashes, no whitespace.  This is
 *  what gets hashed and stored.  Display form has a dash inserted
 *  for readability ("XXXX-XXXX") but the stored hash is over the
 *  canonical form. */
export function canonicalize(code: string): string {
	return code.replace(/[\s-]/g, '').toUpperCase();
}

/** Display form: `XXXX-XXXX` for readability.  No semantic change —
 *  the dash is stripped before any hash/verify operation. */
export function displayFormat(code: string): string {
	const c = canonicalize(code);
	if (c.length !== BACKUP_CODE_LENGTH) return c;
	return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** Generate a fresh set of plaintext backup codes for the user to
 *  see ONCE at enrollment.  Returns them in display format.
 *  The caller is responsible for displaying these prominently and
 *  forcing the user to confirm they've saved them. */
export function generatePlaintextCodes(): string[] {
	const codes: string[] = [];
	for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
		codes.push(displayFormat(generateOneCode()));
	}
	return codes;
}

/** Hash a backup code with Argon2id at INTERACTIVE cost. Returns the
 *  libsodium pwhash_str format, which embeds salt + params alongside the
 *  hash, suitable for direct storage.
 *
 *  Why INTERACTIVE and not more: the hashes live INSIDE the encrypted
 *  keystore, so whoever can read them has already got past the password and
 *  holds the keys — the hash cost buys nothing against them. What the cost
 *  does buy is waiting: a redemption verifies up to 10 hashes one after the
 *  other, and at MODERATE (256 MiB, 3 passes) that froze a phone for many
 *  seconds or ran it out of memory. Codes hashed by older builds keep their
 *  embedded MODERATE parameters until they are regenerated (the plaintext
 *  is never available to re-hash them). */
async function hashCode(canonical: string): Promise<string> {
	await ensureSodium();
	// The TS type definitions for libsodium-wrappers-sumo don't expose
	// `crypto_pwhash_str` / `crypto_pwhash_str_verify`, but they exist at
	// runtime in the sumo variant (backupCodes.test.ts uses them).
	const s = sodium as unknown as {
		crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
		crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
		crypto_pwhash_str: (passwd: string, opslimit: number, memlimit: number) => string;
	};
	return s.crypto_pwhash_str(
		canonical,
		s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
		s.crypto_pwhash_MEMLIMIT_INTERACTIVE
	);
}

/** Verify a candidate code against a stored hash string.  Returns
 *  true on match.  Argon2id's str_verify is constant-time. */
async function verifyHash(canonical: string, stored: string): Promise<boolean> {
	await ensureSodium();
	const s = sodium as unknown as {
		crypto_pwhash_str_verify: (stored: string, passwd: string) => boolean;
	};
	try {
		return s.crypto_pwhash_str_verify(stored, canonical);
	} catch {
		return false;
	}
}

/** Hash a fresh set of plaintext codes into stored slots.  The
 *  caller MUST pass the plaintext codes returned from
 *  `generatePlaintextCodes()` — passing already-canonicalized form
 *  is fine; passing arbitrary text isn't (you'd be hashing junk). */
export async function hashCodesForStorage(plaintextCodes: string[]): Promise<BackupCodeSlot[]> {
	const slots: BackupCodeSlot[] = [];
	for (const code of plaintextCodes) {
		const canonical = canonicalize(code);
		if (canonical.length !== BACKUP_CODE_LENGTH) {
			throw new Error(
				`backup-code-slot: code "${code}" canonicalized to ${canonical.length} chars; ` +
					`expected ${BACKUP_CODE_LENGTH}.`
			);
		}
		slots.push({
			hash: await hashCode(canonical),
			used: false,
			usedAt: 0
		});
	}
	return slots;
}

/** Attempt to redeem a user-entered backup code against the stored
 *  slots.  Returns:
 *
 *  - `{ kind: 'matched', index, slots }` where `slots` is a new
 *    array with the matched slot's `used` flag flipped — the
 *    caller MUST persist this updated array to the keystore
 *    (otherwise the user could replay the same code on a future
 *    unlock attempt).
 *  - `{ kind: 'no_match' }` if the code matches no unused slot.
 *  - `{ kind: 'already_used' }` if the code matches a slot but
 *    that slot has already been redeemed.  The caller should
 *    refuse the redemption and warn the user.
 *
 *  Iteration is sequential through all unused slots, each an Argon2id
 *  verify at the cost the slot was hashed with (INTERACTIVE for codes
 *  made by this build: well under a second each).
 */
export async function redeemBackupCode(
	userInput: string,
	storedSlots: ReadonlyArray<BackupCodeSlot>
): Promise<
	| { kind: 'matched'; index: number; slots: BackupCodeSlot[] }
	| { kind: 'already_used' }
	| { kind: 'no_match' }
> {
	const canonical = canonicalize(userInput);
	if (canonical.length !== BACKUP_CODE_LENGTH) {
		return { kind: 'no_match' };
	}
	// Walk ALL slots (used + unused) to distinguish a "no match" from
	// "matched but already used" — that's a security-relevant signal
	// for the user (someone else may have used your codes).
	for (let i = 0; i < storedSlots.length; i++) {
		const slot = storedSlots[i]!;
		const ok = await verifyHash(canonical, slot.hash);
		if (ok) {
			if (slot.used) {
				return { kind: 'already_used' };
			}
			// Flip the used flag, return new slots array.
			const newSlots = storedSlots.map((s, j) =>
				j === i ? { ...s, used: true, usedAt: Date.now() } : s
			);
			return { kind: 'matched', index: i, slots: newSlots };
		}
	}
	return { kind: 'no_match' };
}

/** Count how many backup-code slots are still unused.  Used by the
 *  settings UI to warn the user when they're running low. */
export function unusedSlotCount(slots: ReadonlyArray<BackupCodeSlot>): number {
	return slots.filter((s) => !s.used).length;
}
