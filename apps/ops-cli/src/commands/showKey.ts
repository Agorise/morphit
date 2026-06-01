/**
 * Morphit ops CLI — `show-key` subcommand (cp178).
 *
 * WHY THIS EXISTS.
 * Operators (and the "grandma" persona) hit a dead end when the
 * `register` broadcast failed with a key-signature mismatch: the
 * old guidance said "check that MORPHIT_RELAY_ACTIVE_KEY_FILE
 * points at the active key for this account on chain" — which
 * requires finding the file, decrypting it by hand, and knowing
 * how to compare a private key against an on-chain authority.
 * Nobody can do that from a one-line hint.
 *
 * `show-key` makes the saved key self-verifiable WITHOUT revealing
 * the private key:
 *   - It loads the keystore (prompting for the passphrase exactly
 *     as `register` and the relay do).
 *   - It derives and prints the PUBLIC key (BLT...) that the saved
 *     private key corresponds to.  The operator compares that
 *     against the active authority shown for their account on any
 *     Blurt block explorer.  Match → the right key is saved.
 *     Mismatch → they saved the wrong key (e.g. posting instead of
 *     active, or a different account's key) and should re-run
 *     `edit-active-key`.
 *   - It prints a short MASKED fingerprint of the private WIF
 *     (first 6 + last 4 chars, e.g. `5Jabcd…wXyZ`) so the operator
 *     can confirm WHICH key is on disk at a glance — never the full
 *     secret.
 *
 * SECURITY POSTURE.
 * The full private key is never printed, never logged, and the
 * decrypted WIF is cleared (reassigned) on every exit path.  The
 * public key is, by definition, public.  The masked fingerprint
 * reveals 10 of ~51 base58 chars — not enough to reconstruct the
 * key, enough to distinguish "which key is this" for a human who
 * already knows their own keys.
 */

import { readFileSync } from 'node:fs';
import { askPassword } from '../init/prompt.ts';
import { sanitizeForTerm } from '../render/term.ts';

export interface ShowKeyCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
}

/** Mask a WIF to a short fingerprint: first 6 + ellipsis + last 4.
 *  Never returns enough to reconstruct the key. */
export function maskWif(wif: string): string {
	if (wif.length <= 12) {
		// Pathologically short (not a real WIF) — mask all but the
		// first char so we never echo a near-complete secret.
		return wif.length > 0 ? wif[0] + '…' : '(empty)';
	}
	return `${wif.slice(0, 6)}…${wif.slice(-4)}`;
}

export async function runShowKey(_ctx: ShowKeyCtx): Promise<number> {
	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	const keyFile = process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE;

	const missing: string[] = [];
	if (!account) missing.push('MORPHIT_RELAY_ACCOUNT');
	if (!keyFile) missing.push('MORPHIT_RELAY_ACTIVE_KEY_FILE');
	if (missing.length > 0) {
		console.log(`✗ Missing required environment variables: ${missing.join(', ')}.`);
		console.log('  Source your config first:');
		console.log('    set -a; . ./morphit.env; . ./morphit.config.env; set +a');
		return 1;
	}

	console.log('');
	console.log('━'.repeat(58));
	console.log('Saved relay account key');
	console.log('━'.repeat(58));
	console.log('');
	console.log(`  Account:   @${sanitizeForTerm(account!)}`);
	console.log(`  Key file:  ${sanitizeForTerm(keyFile!)}`);
	console.log('');

	let wif = '';
	try {
		wif = await loadKeyWif(keyFile!);

		// SECURITY: minimize the decrypted WIF's lifetime.  Derive the
		// public key AND the masked fingerprint up front, in one tight
		// block, then drop our reference to the secret BEFORE doing any
		// of the (slower, I/O-bound) console output.  We never log,
		// interpolate, or copy the full WIF anywhere.
		//
		// HONEST LIMITATION: `wif` is a JS string, and V8 strings are
		// immutable — reassigning `wif = ''` drops OUR reference but
		// cannot scrub the original bytes from the heap; they persist
		// until GC reclaims them.  dblurt's PrivateKey.fromString takes
		// a string, so a string WIF is unavoidable at that boundary
		// (the relay's own active-key path has the same constraint).
		// What we control — lifetime, copies, and never emitting it —
		// we do control.  decryptEnvelope already .fill(0)s its Buffer
		// intermediates; the only residue is this short-lived string.
		let publicKey: string;
		let masked: string;
		try {
			const dblurt = (await import('@beblurt/dblurt')) as unknown as {
				PrivateKey: {
					fromString(wif: string): { createPublic(prefix?: string): { toString(): string } };
				};
			};
			publicKey = dblurt.PrivateKey.fromString(wif).createPublic('BLT').toString();
			masked = maskWif(wif);
		} catch (err) {
			// Drop the secret reference before handling the error too.
			wif = '';
			// If the key is malformed, fromString throws — that itself
			// is a useful diagnosis (the saved key isn't a valid WIF).
			console.log(`✗ The saved key is not a valid Blurt private key: ${sanitizeForTerm(errMsg(err))}`);
			console.log('');
			console.log('  Re-run `npx morphit-ops edit-active-key` and paste the');
			console.log("  account's ACTIVE private key (starts with 5...).");
			return 1;
		}
		// Secret no longer needed — drop our reference immediately, well
		// before the console output below.
		wif = '';

		console.log(`  Private key (masked):  ${masked}`);
		console.log(`  Public key:            ${publicKey}`);
		console.log('');
		console.log('━'.repeat(58));
		console.log('');
		console.log('To verify this is the correct key:');
		console.log(`  1. Open @${sanitizeForTerm(account!)} on a Blurt block explorer —`);
		console.log(`     https://blocks.blurtwallet.com/#/@${sanitizeForTerm(account!)}`);
		console.log('  2. Find the "Active Auth" (active authority) public key.');
		console.log('  3. It should match the "Public key" shown above exactly.');
		console.log('');
		console.log('If they match, this server holds the right active key.');
		console.log('If they differ, run `npx morphit-ops edit-active-key` and');
		console.log("supply the account's ACTIVE key (a posting or owner key will");
		console.log('not work for operator registration).');
		console.log('');
		return 0;
	} catch (err) {
		console.log(`✗ Could not load the key: ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	} finally {
		// Clear the decrypted secret reference promptly.
		wif = '';
	}
}

// ─── Helpers (shared shape with register.ts loadKeyWif) ──────────

async function loadKeyWif(keyFile: string): Promise<string> {
	const raw = readFileSync(keyFile, 'utf8').trim();
	if (!raw.startsWith('{')) {
		// Plaintext WIF — no passphrase needed.
		return raw;
	}
	const envelope = JSON.parse(raw);
	const passphrase = await askPassword('Unlock passphrase');
	if (passphrase.length === 0) {
		throw new Error('passphrase required to unlock encrypted keystore');
	}
	const { decryptEnvelope } = await import('../../../relay/src/crypto/keyEnvelope.ts');
	return decryptEnvelope(envelope, passphrase);
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
