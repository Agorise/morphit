/**
 * Morphit — TOTP unlock gate.
 *
 * After `decryptIdentity()` returns a FullIdentity, callers must
 * pass through this gate IF the identity has 2FA enrolled
 * (`totpSecret` present).  The gate verifies the user's supplied
 * code — either a 6-digit TOTP code OR an 8-char backup code —
 * and returns either:
 *
 *   - `{ kind: 'ok' }` for a valid TOTP code (no keystore change needed)
 *   - `{ kind: 'backup_redeemed', updatedIdentity }` for a valid
 *     backup code.  The caller MUST persist `updatedIdentity` back
 *     to the keystore — that slot's `used` flag has been flipped,
 *     and not persisting it means a successful redeem can be
 *     replayed by an attacker who reads the same encrypted blob
 *     before the user notices.
 *   - throws KeystoreError 'totp_invalid' on no match.
 *
 * The helper auto-detects whether the input is a TOTP code or
 * backup code based on character class:
 *   - 6 digits → TOTP
 *   - 8 chars from the Crockford-base32 alphabet (with optional dash) → backup code
 *
 * Whitespace and case are normalized at entry; the user can type
 * "123 456" or "ABCD efgh" or "abcd-EFGH" — all are accepted forms.
 *
 * Honest threat-model framing:
 *
 *   This gate runs AFTER the keystore is already plaintext in
 *   memory.  An attacker who has reached this point with the
 *   correct password has access to the unwrapped keys via the
 *   FullIdentity object directly — the TOTP check doesn't add
 *   cryptographic strength to that attack path.
 *
 *   What it DOES gate is the call-graph leading to the unlocked
 *   session state in the identity store: until this returns 'ok',
 *   `bootFromEnvelope` will not set the internal state to
 *   `'unlocked'` and the rest of the app cannot see the keys.
 *   This is meaningful protection against:
 *     - Shoulder-surfing: someone watching you type a password
 *       can't unlock without also watching you type a code that
 *       expires every 30 seconds.
 *     - Borrowed-laptop: a friend who knows your password from
 *       seeing you log in once still needs your authenticator app.
 *     - Casual local malware that grabs the keystore + password
 *       but doesn't know to also locate and use the TOTP secret.
 *
 *   For cryptographically-meaningful 2FA (where the second
 *   factor's secret never lives on the protected device), the
 *   path forward is FIDO2/WebAuthn — see the yubikey-probe
 *   exploratory route.
 */

import type { Identity } from './keygen';
import { KeystoreError } from './keystore';
import { verifyCode as verifyTotpCode } from '../auth/totp';
import {
	canonicalize as canonicalizeBackup,
	redeemBackupCode,
	BACKUP_CODE_LENGTH
} from '../auth/backupCodes';

/** Result of a TOTP unlock attempt. */
export type TotpUnlockResult =
	| { kind: 'ok' }
	| { kind: 'backup_redeemed'; updatedIdentity: Identity };

/** Auto-detect whether the input looks like a TOTP code or a
 *  backup code, and verify accordingly.  Throws KeystoreError
 *  'totp_invalid' on no match. */
export async function verifyTotpOrBackup(
	identity: Identity,
	userInput: string
): Promise<TotpUnlockResult> {
	if (!identity.totpSecret) {
		// Caller bug — should have checked before invoking.
		throw new Error('verifyTotpOrBackup called on identity with no TOTP enrolled');
	}

	const trimmed = userInput.trim();

	// TOTP code: 6 digits (with optional whitespace/dashes — verifyCode strips ws).
	if (/^[\d\s]+$/.test(trimmed)) {
		const result = await verifyTotpCode(identity.totpSecret, trimmed);
		if (result.valid) {
			return { kind: 'ok' };
		}
		// Fall through — could still be a backup code with all-digit chars,
		// though Crockford-base32 alphabet doesn't include 0/1, so a pure
		// digit string of length 8 IS a possible backup code.  Try it.
	}

	// Backup code: 8 Crockford-base32 chars (with optional dash/whitespace).
	const canonical = canonicalizeBackup(trimmed);
	if (canonical.length === BACKUP_CODE_LENGTH) {
		const slots = identity.totpBackupCodes;
		if (slots && slots.length > 0) {
			const result = await redeemBackupCode(trimmed, slots);
			if (result.kind === 'matched') {
				// Build an updated Identity with the new slots array.
				const updated: Identity = {
					...identity,
					totpBackupCodes: result.slots
				};
				return { kind: 'backup_redeemed', updatedIdentity: updated };
			}
			if (result.kind === 'already_used') {
				// Surface this specifically — the user should know that
				// the code matched but was already redeemed (someone else
				// may have used it).
				throw new KeystoreError(
					'totp_invalid',
					'That backup code has already been used. Each code can only be used once.'
				);
			}
		}
	}

	throw new KeystoreError(
		'totp_invalid',
		'Two-factor code did not verify. Check that your device time is in sync and try again.'
	);
}
