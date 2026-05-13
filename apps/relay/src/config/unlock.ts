/**
 * Morphit relay — unlock helper (ADR-0010 §4).
 *
 * Takes a Config produced by loadConfig() and returns a Config
 * with relayActiveKeyWif guaranteed defined:
 *
 *   - If the key file was a plaintext WIF, unlock is a no-op:
 *     loadConfig already filled relayActiveKeyWif.
 *   - If the key file was an encrypted envelope, this function
 *     prompts the operator for the passphrase, decrypts the
 *     envelope, and returns a new Config with the resolved WIF.
 *
 * The function retries up to 3 times on wrong-passphrase errors
 * so an operator who typos once or twice doesn't have to restart
 * the service. Any other failure (malformed envelope, TTY not
 * available, etc.) is fatal and throws.
 *
 * After this resolves, the envelope field is stripped from the
 * returned Config so no caller is tempted to re-decrypt it.
 */

import type { Config, UnlockedConfig } from '$config';
import { decryptEnvelope, KeyEnvelopeError } from '$crypto/keyEnvelope';
import { promptPassphrase, PassphrasePromptError } from '$crypto/promptPassphrase';
import { logger } from '$log';

const log = logger('relay-unlock');

/** Maximum passphrase attempts before giving up. */
const MAX_ATTEMPTS = 3;

export class UnlockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnlockError';
	}
}

/** Ensure the Config's relayActiveKeyWif is defined, unlocking
 *  the key envelope via a stdin passphrase prompt if needed.
 *  Returns a new UnlockedConfig (the original is not mutated).
 *
 *  @param cfg The Config loaded from env.
 *  @param promptImpl Optional passphrase provider for tests. Defaults
 *    to the stdin-prompting implementation. Must resolve to the
 *    passphrase string or reject with PassphrasePromptError.
 */
export async function unlockActiveKey(
	cfg: Config,
	promptImpl: (opts: { prompt: string; minLength: number }) => Promise<string> = promptPassphrase
): Promise<UnlockedConfig> {
	// Fast path: plaintext WIF already loaded.
	if (cfg.relayActiveKeyWif !== undefined) {
		return {
			...cfg,
			relayActiveKeyWif: cfg.relayActiveKeyWif,
			relayActiveKeyEnvelope: undefined
		};
	}

	if (cfg.relayActiveKeyEnvelope === undefined) {
		throw new UnlockError(
			'internal: both relayActiveKeyWif and relayActiveKeyEnvelope are undefined'
		);
	}

	log.info('envelope_prompt');

	let lastErr: unknown = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let passphrase: string;
		try {
			passphrase = await promptImpl({
				prompt:
					attempt === 1
						? 'Relay active-key passphrase: '
						: `Wrong passphrase. Retry (${attempt}/${MAX_ATTEMPTS}): `,
				minLength: 1 // the envelope itself enforces the min at encrypt time
			});
		} catch (err) {
			if (err instanceof PassphrasePromptError) {
				// TTY problems / cancellation / timeout are all fatal —
				// no point retrying.
				throw new UnlockError(`passphrase prompt failed: ${err.message}`);
			}
			throw err;
		}

		try {
			const wif = decryptEnvelope(cfg.relayActiveKeyEnvelope, passphrase);
			// Best-effort: scrub the passphrase from memory. V8 may
			// still have copies around, but we clear our local ref.
			passphrase = '';
			return {
				...cfg,
				relayActiveKeyWif: wif,
				relayActiveKeyEnvelope: undefined
			};
		} catch (err) {
			passphrase = '';
			lastErr = err;
			if (!(err instanceof KeyEnvelopeError)) {
				// Unexpected error — don't keep retrying; surface it.
				throw err;
			}
			// Wrong-passphrase errors retry. Other envelope errors
			// (malformed JSON, unsupported version, weak params)
			// don't — re-running the prompt won't help.
			if (err.code !== 'decryption_failed') {
				throw new UnlockError(`envelope is malformed: ${err.message}`);
			}
			// Fall through to next attempt.
		}
	}

	throw new UnlockError(
		`passphrase unlock failed after ${MAX_ATTEMPTS} attempts: ${
			lastErr instanceof Error ? lastErr.message : String(lastErr)
		}`
	);
}
