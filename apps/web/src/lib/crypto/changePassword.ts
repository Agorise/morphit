/**
 * Morphit — in-app password change (K1.3).
 *
 * Decrypts the current envelope with the old password, re-encrypts
 * the same FullIdentity with the new password, persists the new
 * envelope, and updates the in-memory identity store.
 *
 * Pre-fix, users with a compromised password had no good recovery
 * path: they had to Sign Out → re-import seed → choose new
 * password.  This helper closes that gap with a single atomic
 * operation that keeps the live session intact (no re-sign-in
 * needed).
 *
 * Safety contract:
 *  - The decrypted FullIdentity is wiped (wipeFullIdentity)
 *    regardless of outcome via a finally block.  Pre-K1.2 this
 *    didn't include the seed string; post-K1.2 it does (seedBytes
 *    is a Uint8Array).
 *  - Persistent envelope is replaced ONLY after the new envelope
 *    is fully built and the decrypt-with-old succeeded.  An error
 *    mid-process leaves the user's old envelope intact.
 *  - In-memory store updated last so a failure during persistence
 *    rolls back cleanly (we re-throw and the caller sees an error
 *    result; the user's session is unchanged).
 *  - Old and new passwords are NOT wiped here — they're string
 *    parameters from the caller's let bindings.  Same contract as
 *    runWithActiveKey: the caller must clear them.
 */

import { get } from 'svelte/store';
import {
	decryptIdentity,
	encryptIdentity,
	KeystoreError,
	type KeystoreEnvelope
} from '$crypto/keystore';
import { wipeFullIdentity } from '$crypto/keygen';
import { writeEnvelope, readKeystoreMode } from '$crypto/persistentKeystore';
import { identity, updateEnvelope } from '$stores/identity';

export type ChangePasswordErrKind =
	/** Either password was an empty string. */
	| 'password_empty'
	/** New password is shorter than 8 characters. */
	| 'new_password_too_short'
	/** New password equals old — pointless rotation. */
	| 'same_password'
	/** Identity store wasn't unlocked when called. */
	| 'locked'
	/** Decryption with the old password failed (wrong password). */
	| 'bad_old_password'
	/** Audit 2026-05 finding 1-8: structural problem with the
	 *  stored envelope.  Retrying with another password will not
	 *  help; the user should re-import from seed/keyfile. */
	| 'envelope_corrupt'
	/** Anything else — re-encryption, persistence, store-update
	 *  failure.  Cause is attached for logging. */
	| 'internal';

export interface ChangePasswordOk {
	readonly ok: true;
}
export interface ChangePasswordErr {
	readonly ok: false;
	readonly kind: ChangePasswordErrKind;
	readonly cause?: unknown;
}
export type ChangePasswordResult = ChangePasswordOk | ChangePasswordErr;

const MIN_NEW_PASSWORD_LENGTH = 8;

/**
 * Change the user's keystore password.
 *
 * Returns a discriminated union: ok or kind-classified error.
 * Never throws.
 */
export async function changePassword(
	oldPassword: string,
	newPassword: string
): Promise<ChangePasswordResult> {
	if (oldPassword.length === 0 || newPassword.length === 0) {
		return { ok: false, kind: 'password_empty' };
	}
	if (newPassword.length < MIN_NEW_PASSWORD_LENGTH) {
		return { ok: false, kind: 'new_password_too_short' };
	}
	if (oldPassword === newPassword) {
		return { ok: false, kind: 'same_password' };
	}

	const state = get(identity);
	if (state.state !== 'unlocked') {
		return { ok: false, kind: 'locked' };
	}

	const currentEnv = state.envelope;

	// Decrypt with the old password.  This is the gate — if it
	// fails, no other state changes.
	let full;
	try {
		full = await decryptIdentity(currentEnv, oldPassword);
	} catch (err) {
		// Audit 2026-05 finding 1-8: typed dispatch instead of
		// "treat all decrypt errors as bad password".  Pre-fix,
		// a structurally corrupt envelope sent the user into an
		// infinite "wrong password, retry" loop.
		if (err instanceof KeystoreError) {
			if (err.kind === 'bad_password') {
				return { ok: false, kind: 'bad_old_password', cause: err };
			}
			if (err.kind === 'envelope_corrupt') {
				return { ok: false, kind: 'envelope_corrupt', cause: err };
			}
			// no_passphrase_wrap / identity_mismatch / unsupported
			// fall through as 'internal' — not retryable here.
			return { ok: false, kind: 'internal', cause: err };
		}
		return { ok: false, kind: 'internal', cause: err };
	}

	let newEnv: KeystoreEnvelope;
	try {
		// Re-encrypt with the new password.  encryptIdentity
		// generates a fresh salt + nonce, so the new envelope's
		// ciphertext is unrelated to the old one's even though the
		// plaintext (the FullIdentity) is identical.
		newEnv = await encryptIdentity(full, newPassword);
	} catch (err) {
		// Wipe before returning.
		wipeFullIdentity(full);
		return { ok: false, kind: 'internal', cause: err };
	}

	// We now have a valid new envelope.  full's job is done; wipe
	// it BEFORE touching persistence.  If persistence fails, the
	// user can still call changePassword again (the live session
	// holds the active envelope; only the disk copy is stale).
	wipeFullIdentity(full);

	try {
		// Persist the new envelope.  Only writes to disk if the
		// user chose 'password' mode at onboarding — seed-only
		// users have no persisted envelope, so this is a no-op
		// for them but the in-memory store still updates.
		//
		// M8 fix: writeEnvelope returns false on storage failure
		// (quota, private mode, disabled).  If the persist fails,
		// the in-memory updateEnvelope below would mean tab-local
		// JIT unlocks use the new password, but a fresh session on
		// this device would fall back to the OLD envelope and
		// expect the OLD password.  Surface as 'internal' so the
		// caller knows persistence didn't take effect.
		if (readKeystoreMode() === 'password') {
			const persisted = writeEnvelope(newEnv);
			if (!persisted) {
				return {
					ok: false,
					kind: 'internal',
					cause: new Error('persist failed — storage unavailable')
				};
			}
		}
		// Update the in-memory store.  Subsequent JIT unlocks
		// will use newEnv with the new password.
		updateEnvelope(newEnv);
	} catch (err) {
		// Persistence failed but we've already wiped full.  The
		// user's session continues with the OLD envelope (since
		// updateEnvelope didn't run if writeEnvelope threw — but
		// safeStorage.set never throws, it returns false silently;
		// updateEnvelope is the more likely failure path).
		// Either way, surface as 'internal'.
		return { ok: false, kind: 'internal', cause: err };
	}

	return { ok: true };
}
