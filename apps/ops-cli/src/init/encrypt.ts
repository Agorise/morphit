/**
 * Morphit ops CLI — passphrase-encrypted key envelope.
 *
 * The wizard delegates to the relay's existing keyEnvelope
 * module — single source of truth for the envelope format.
 * Whatever this produces, the relay's unlockActiveKey() at
 * startup will be able to decrypt with the same passphrase.
 *
 * The ADR for the format is apps/relay/src/crypto/keyEnvelope.ts:
 *   v1 = scrypt N=2^17 + AES-256-GCM
 */

export {
	encryptEnvelope,
	KEY_ENVELOPE_VERSION,
	type KeyEnvelope
} from '../../../relay/src/crypto/keyEnvelope.ts';

/** Convenience: validate a passphrase strength.  The envelope
 *  format itself enforces ≥8 chars at encrypt time, but the
 *  wizard catches it earlier with a friendlier message. */
export function checkPassphraseStrength(passphrase: string): {
	ok: boolean;
	message?: string;
} {
	if (passphrase.length < 8) {
		return {
			ok: false,
			message: 'Passphrase must be at least 8 characters.'
		};
	}
	if (passphrase.length < 12) {
		return {
			ok: true,
			message:
				'Heads up: your passphrase is shorter than recommended.  ' +
				'Consider 12+ characters or a multi-word passphrase.'
		};
	}
	return { ok: true };
}
