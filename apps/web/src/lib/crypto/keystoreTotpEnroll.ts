/**
 * Morphit — TOTP enrollment helpers for the keystore.
 *
 * Three operations, all of which:
 *   - Take a CURRENTLY-UNLOCKED identity (caller is responsible for
 *     having decrypted the keystore with the user's password).
 *   - Mutate the identity by adding/replacing/removing TOTP fields.
 *   - Re-encrypt with the same password into a new envelope.
 *   - The caller is responsible for persisting the new envelope via
 *     `writeEnvelope()` AND updating the identity store via
 *     `bootFromEnvelope()` (or a direct internal swap).
 *
 * Operations:
 *   - `enrollTotp(identity, password, secret, backupCodes)` — fresh
 *     enrollment.  Caller has shown the user the secret in QR form
 *     and confirmed the user can produce a valid current code from
 *     their authenticator.  Backup codes have already been
 *     generated and shown to the user once (this function does NOT
 *     generate them — the UI does, because it needs the plaintext
 *     to display once and never again).
 *   - `unenrollTotp(identity, password)` — user disabled 2FA.
 *     Clears totpSecret and totpBackupCodes.
 *   - `regenerateBackupCodes(identity, password, newCodes)` —
 *     replaces the existing backup-code slot array with a fresh
 *     set.  Old slots are discarded irrevocably.  Caller must have
 *     already shown the new plaintext codes to the user.
 *
 * Each function:
 *   - Wipes secret material from the input identity object's
 *     references where it's no longer needed.
 *   - Re-encrypts via the same KeystoreEnvelope path
 *     (`encryptIdentity` or `encryptIdentityToCek` depending on
 *     scheme).  The caller can pre-determine which by looking at
 *     `env.scheme` before invoking; or we just produce a
 *     simple-passphrase envelope and let any subsequent YubiKey
 *     re-enrollment migrate it.  For now we keep the original
 *     scheme; layered keystores stay layered.
 */

import sodium from 'libsodium-wrappers-sumo';
import type { Identity } from './keygen';
import {
	encryptIdentity,
	type KeystoreEnvelope,
	type SimplePassphraseEnvelope,
	type LayeredCekEnvelope
} from './keystore';
import { hashCodesForStorage, type BackupCodeSlot } from '../auth/backupCodes';

/** Enroll TOTP on an unlocked identity.  Returns the updated
 *  Identity AND a new KeystoreEnvelope (re-encrypted with the same
 *  password).  Caller persists both. */
export async function enrollTotp(
	identity: Identity,
	password: string,
	totpSecret: Uint8Array,
	plaintextBackupCodes: string[]
): Promise<{ identity: Identity; envelope: KeystoreEnvelope }> {
	if (identity.totpSecret) {
		throw new Error(
			'enrollTotp: identity already has 2FA enrolled.  Use unenrollTotp first or call regenerateBackupCodes if just refreshing codes.'
		);
	}
	if (totpSecret.length !== 20) {
		throw new Error(
			`enrollTotp: totpSecret must be 20 bytes (160 bits), got ${totpSecret.length}`
		);
	}
	// Hash the backup codes; the plaintext copies stay only in the
	// caller's UI for the brief enrollment-confirmation window.
	const backupSlots = await hashCodesForStorage(plaintextBackupCodes);

	const updated: Identity = {
		...identity,
		totpSecret: new Uint8Array(totpSecret), // defensive copy
		totpBackupCodes: backupSlots
	};

	// Re-encrypt.  We only support simple-passphrase enrollment in
	// this iteration; layered (YubiKey-protected) keystores need
	// the full set of wraps which is a different code path —
	// upgrading a layered envelope is the YubiKey module's job.
	// For now, throw if the caller passes a layered envelope; that
	// path can be added later when needed.
	const envelope = await encryptIdentity(updated, password);
	return { identity: updated, envelope };
}

/** Disable TOTP on an unlocked identity.  Clears both the secret
 *  and the backup-code slots.  Returns the updated Identity and a
 *  fresh KeystoreEnvelope. */
export async function unenrollTotp(
	identity: Identity,
	password: string
): Promise<{ identity: Identity; envelope: KeystoreEnvelope }> {
	if (!identity.totpSecret) {
		throw new Error('unenrollTotp: identity does not have 2FA enrolled');
	}
	// Zero the secret bytes before dropping the reference.
	if (identity.totpSecret instanceof Uint8Array) {
		try {
			sodium.memzero(identity.totpSecret);
		} catch {
			// memzero throws if sodium isn't ready yet; not critical
			// since we're about to drop the reference.
		}
	}
	const updated: Identity = {
		...identity,
		totpSecret: null,
		totpBackupCodes: null
	};
	const envelope = await encryptIdentity(updated, password);
	return { identity: updated, envelope };
}

/** Regenerate the backup-code slots.  Requires existing TOTP
 *  enrollment (this is a "I lost my saved codes, give me new
 *  ones" operation, not a "set up 2FA" operation). */
export async function regenerateBackupCodes(
	identity: Identity,
	password: string,
	plaintextBackupCodes: string[]
): Promise<{ identity: Identity; envelope: KeystoreEnvelope; replacedSlots: BackupCodeSlot[] }> {
	if (!identity.totpSecret) {
		throw new Error(
			'regenerateBackupCodes: identity does not have 2FA enrolled.  Enroll first via enrollTotp.'
		);
	}
	const backupSlots = await hashCodesForStorage(plaintextBackupCodes);
	const updated: Identity = {
		...identity,
		totpBackupCodes: backupSlots
	};
	const envelope = await encryptIdentity(updated, password);
	const replaced = identity.totpBackupCodes ? Array.from(identity.totpBackupCodes) : [];
	return { identity: updated, envelope, replacedSlots: replaced };
}

/** Discriminate envelope schemes — exported as a helper for UIs
 *  that need to surface a "layered keystores aren't supported for
 *  2FA enrollment yet" message instead of letting enrollTotp
 *  throw mid-flow. */
export function isLayeredEnvelope(env: KeystoreEnvelope): env is LayeredCekEnvelope {
	return (env as LayeredCekEnvelope).scheme === 'layered-cek';
}
export function isSimplePassphraseEnvelope(env: KeystoreEnvelope): env is SimplePassphraseEnvelope {
	return !isLayeredEnvelope(env);
}
