/**
 * Morphit — in-app password change (K1.3).
 *
 * Decrypts the current envelope with the old password, re-encrypts
 * the same FullIdentity with the new password, and commits the new
 * envelope to the session and — only when this session's keystore is
 * the one this device remembers — to disk (commitSessionEnvelope).
 *
 * Which envelope is re-keyed: the session's, unless the device holds a
 * DIFFERENT keystore for the SAME account (it decrypts with the old
 * password to the same posting key) — then the device's copy is the
 * newer truth (a YubiKey or 2FA change saved by another tab, or by an
 * older build that wrote only the disk copy) and is the one re-keyed.
 * Re-keying a stale session copy and writing it back is how a removed
 * YubiKey used to come back.
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
 *  - Session and disk move together or not at all; a session that
 *    is not the remembered one never writes to disk.
 *  - Old and new passwords are NOT wiped here — they're string
 *    parameters from the caller's let bindings.  Same contract as
 *    runWithActiveKey: the caller must clear them.
 */

import { get } from 'svelte/store';
import {
	decryptIdentity,
	encryptIdentity,
	rewrapLayeredPassphrase,
	KeystoreError,
	type KeystoreEnvelope
} from '$crypto/keystore';
import { wipeFullIdentity } from '$crypto/keygen';
import { readEnvelope, readKeystoreMode } from '$crypto/persistentKeystore';
import { identity, updateEnvelope, commitSessionEnvelope } from '$stores/identity';
import { sodium } from '$crypto/sodium';

export type ChangePasswordErrKind =
	/** Either password was an empty string. */
	| 'password_empty'
	/** New password is shorter than 10 characters (the keystore
	 *  floor enforced by encryptIdentity / buildPassphraseWrap; the
	 *  UI's passwordStrength check demands at least this). */
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

// Must match the keystore's own floor (encryptIdentity /
// buildPassphraseWrap both throw below 10).  Keeping this in sync
// means an 8–9 char password is rejected here with a clear
// 'new_password_too_short' instead of throwing later and surfacing
// as a confusing generic 'internal'.
const MIN_NEW_PASSWORD_LENGTH = 10;

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

	let currentEnv = state.envelope;
	let adoptDeviceCopy = false;
	const device = readKeystoreMode() === 'password' ? readEnvelope() : null;
	if (device !== null && JSON.stringify(device) !== JSON.stringify(currentEnv)) {
		try {
			const f = await decryptIdentity(device, oldPassword);
			try {
				adoptDeviceCopy = sodium.memcmp(f.keys.posting.publicKey, state.live.posting.publicKey);
			} finally {
				wipeFullIdentity(f);
			}
		} catch {
			// Not decryptable with this password, or not this account's: the
			// device's keystore is someone else's — leave it alone.
		}
		if (adoptDeviceCopy) currentEnv = device;
	}

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
		if (currentEnv.scheme === 'layered-cek') {
			// Layered keystore (a YubiKey is enrolled).  Rotate ONLY the
			// passphrase wrap, preserving the CEK, the identity ciphertext,
			// and every yubikey wrap.  encryptIdentity() here would emit a
			// simple-passphrase envelope and silently drop the YubiKey
			// unlock path — the bug this branch fixes.  (TOTP 2FA lives in
			// the identity ciphertext, which is preserved byte-for-byte on
			// both paths, so it survives a password change regardless.)
			newEnv = await rewrapLayeredPassphrase(currentEnv, oldPassword, newPassword);
		} else {
			// simple-passphrase keystore (covers TOTP-only enrollments,
			// whose totpSecret rides inside the identity blob).  Re-encrypt
			// the FullIdentity under the new password: encryptIdentity
			// generates a fresh salt + nonce, so the new ciphertext is
			// unrelated to the old one's even though the plaintext is
			// identical.
			newEnv = await encryptIdentity(full, newPassword);
		}
	} catch (err) {
		// Wipe before returning.
		wipeFullIdentity(full);
		return { ok: false, kind: 'internal', cause: err };
	}

	// We now have a valid new envelope.  full's job is done; wipe
	// it BEFORE touching persistence.
	wipeFullIdentity(full);

	// The session first takes the device's copy it was re-keyed from (so
	// the commit below sees the session as the remembered keystore).
	if (adoptDeviceCopy) updateEnvelope(currentEnv);
	const committed = commitSessionEnvelope(newEnv);
	if (committed === 'persist_failed') {
		// writeEnvelope returns false on storage failure (quota, private
		// mode, disabled). Nothing changed: the session and the device both
		// keep the old password.
		return {
			ok: false,
			kind: 'internal',
			cause: new Error('persist failed — storage unavailable')
		};
	}
	if (committed === 'locked') return { ok: false, kind: 'locked' };

	return { ok: true };
}
