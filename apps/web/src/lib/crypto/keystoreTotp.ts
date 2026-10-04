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
 *   - 8 chars from the backup-code alphabet (A–Z without I/O, 2–9; optional dash) → backup code
 *
 * Whitespace and case are normalized at entry; the user can type
 * "123 456" or "ABCD efgh" or "abcd-EFGH" — all are accepted forms.
 *
 * An authenticator code is accepted ONCE: its time step must be later than
 * the last step accepted for the same secret in this page session. The
 * ±1-step window keeps a code valid for up to 90 s, and someone who watched
 * it being typed could otherwise use it again within that time. Kept in
 * memory only — writing it to storage would tell anyone reading this
 * browser's storage that 2FA is enrolled.
 *
 * Honest threat-model framing:
 *
 *   This gate runs AFTER the keystore is already plaintext in
 *   memory.  An attacker who has reached this point with the
 *   correct password (or the YubiKey) has access to the unwrapped
 *   keys via the FullIdentity object directly — the TOTP check
 *   doesn't add cryptographic strength to that attack path. It is
 *   a gate in this app, not cryptography.
 *
 *   What it DOES gate is the call-graph leading to the unlocked
 *   session state in the identity store: until this returns 'ok',
 *   neither `bootFromEnvelope` nor `bootFromEnvelopeWithYubikey`
 *   sets the internal state to `'unlocked'` and the rest of the app
 *   cannot see the keys. This is meaningful protection against:
 *     - Shoulder-surfing: someone watching you type a password
 *       can't unlock without also watching you type a code that
 *       expires within 90 seconds and is accepted only once.
 *     - Casual local malware that grabs the keystore + password
 *       but doesn't know to also locate and use the TOTP secret.
 */

import type { Identity } from './keygen';
import { KeystoreError } from './keystore';
import { sodium, ensureSodium } from './sodium';
import { verifyCode as verifyTotpCode } from '../auth/totp';
import { webCryptoAvailable } from '$lib/security/secureContext';
import {
	canonicalize as canonicalizeBackup,
	redeemBackupCode,
	BACKUP_CODE_LENGTH
} from '../auth/backupCodes';

/** Result of a TOTP unlock attempt. */
export type TotpUnlockResult =
	| { kind: 'ok' }
	| { kind: 'backup_redeemed'; updatedIdentity: Identity };

/** Last accepted authenticator time step per TOTP secret, this page
 *  session only. Keyed by a short keyed hash of the secret. */
const acceptedSteps = new Map<string, number>();

async function stepMemoryKey(secret: Uint8Array): Promise<string> {
	await ensureSodium();
	const key = new TextEncoder().encode('morphit-totp-step-memory');
	return sodium.to_hex(sodium.crypto_generichash(16, new Uint8Array(secret), new Uint8Array(key)));
}

/** Auto-detect whether the input looks like a TOTP code or a
 *  backup code, and verify accordingly.  Throws KeystoreError
 *  'totp_invalid' on no match, and on an authenticator code whose
 *  time step was already accepted (a replay). */
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
		// v1.20.0 review (F-9): authenticator codes need WebCrypto (HMAC-SHA1),
		// which the browser removes outside a secure context — a plain-HTTP
		// I2P address. Say so specifically instead of crashing with a
		// TypeError. An all-digit 8-char entry may still be a backup code
		// (Argon2id via libsodium, available everywhere), so let it through.
		if (!webCryptoAvailable()) {
			if (canonicalizeBackup(trimmed).length !== BACKUP_CODE_LENGTH) {
				throw new KeystoreError(
					'totp_unavailable',
					'Authenticator codes cannot be checked over this connection (no WebCrypto outside a secure context). Use a backup code, or open the site over https:// or its .onion address.'
				);
			}
		} else {
			const result = await verifyTotpCode(identity.totpSecret, trimmed);
			if (result.valid && result.usedStep !== undefined) {
				const memoryKey = await stepMemoryKey(identity.totpSecret);
				const last = acceptedSteps.get(memoryKey);
				if (last !== undefined && result.usedStep <= last) {
					throw new KeystoreError(
						'totp_invalid',
						'That code was already used. Wait for the next one from your authenticator.'
					);
				}
				acceptedSteps.set(memoryKey, result.usedStep);
				return { kind: 'ok' };
			}
		}
		// Fall through — could still be a backup code with all-digit chars,
		// though the backup-code alphabet has no 0 or 1, so a pure
		// digit string of length 8 IS a possible backup code.  Try it.
	}

	// Backup code: 8 chars of the backup-code alphabet (with optional dash/whitespace).
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
