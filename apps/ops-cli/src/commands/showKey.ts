/**
 * Morphit ops CLI — `show-key` subcommand.
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
 *   - It unlocks the keystore as `register` does (register.ts
 *     unlockRelayKey): with the relay's sealed passphrase first, so
 *     there is nothing to type on the relay's own server; only when
 *     that does not open it is the passphrase asked (with retries).
 *   - It derives and prints the PUBLIC key (BLT...) that the saved
 *     private key corresponds to, and CHECKS it against the account's
 *     keys on the chain (lib/relayKeyChain.ts: this node's indexer
 *     first, then the RPC pool): ✓ matches, or ✗ does not match and
 *     which key it is instead (posting, memo, another account's), with
 *     `sudo morphit-ops edit-active-key` as the fix.
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

import { existsSync } from 'node:fs';
import { isAbortError } from '../init/prompt.ts';
import { withSpinner } from '../init/spinner.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { loadInstanceEnv } from '../lib/instanceEnv.ts';
import { checkKeyOnChain, describeKeyOnChain, type KeyOnChain } from '../lib/relayKeyChain.ts';
import { missingSettingsHelp, unlockRelayKey } from './register.ts';

export interface ShowKeyCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
}

/** Test seams (default: the real unlock and the real chain read). */
export interface ShowKeyDeps {
	readonly unlock?: (keyFile: string) => Promise<string>;
	readonly checkChain?: (account: string, publicKey: string) => Promise<KeyOnChain>;
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

export async function runShowKey(_ctx: ShowKeyCtx, deps: ShowKeyDeps = {}): Promise<number> {
	// Load the instance env so MORPHIT_RELAY_ACCOUNT is present on a systemd
	// deploy (only the unit sources morphit.env). OS env wins; best-effort.
	// The install root, wherever the command was started from (the menu runs it
	// in /opt/morphit/apps/ops-cli). Missing settings are named with the real
	// file and the command that sets them — never "source ./morphit.env".
	const loaded = loadInstanceEnv(defaultRepoRoot());
	const account = process.env.MORPHIT_RELAY_ACCOUNT;
	const keyFile = process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE;

	const missing: string[] = [];
	if (!account) missing.push('MORPHIT_RELAY_ACCOUNT');
	if (!keyFile) missing.push('MORPHIT_RELAY_ACTIVE_KEY_FILE');
	if (missing.length > 0) {
		for (const line of missingSettingsHelp(missing, loaded, 'show-key')) {
			console.log(sanitizeForTerm(line));
		}
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
		// The relay's sealed passphrase first (nothing to type), as register does.
		wif = await (deps.unlock ?? ((f: string) => unlockRelayKey(f)))(keyFile!);

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
			console.log('  Re-run `sudo morphit-ops edit-active-key` and paste the');
			console.log("  account's ACTIVE private key (starts with 5...).");
			return 1;
		}
		// Secret no longer needed — drop our reference immediately, well
		// before the console output below.
		wif = '';

		console.log(`  Private key (masked):  ${masked}`);
		console.log(`  Public key:            ${publicKey}`);
		console.log('');
		// Checked against the chain here — this node's own indexer first, then
		// the RPC pool — instead of sending the operator to a clearnet block
		// explorer to compare by eye (review, 2026-10-29).
		const verdict = await withSpinner(
			`Checking it against @${sanitizeForTerm(account!)}'s keys on the Blurt chain…`,
			() => (deps.checkChain ?? ((a: string, p: string) => checkKeyOnChain(a, p)))(account!, publicKey)
		);
		for (const line of describeKeyOnChain(verdict, account!, publicKey)) {
			console.log(`  ${sanitizeForTerm(line)}`);
		}
		console.log('');
		if (verdict.kind === 'wrong' || verdict.kind === 'weak') {
			console.log('  To put the right key in place, on this server:');
			console.log('    sudo morphit-ops edit-active-key');
			console.log('');
			return 1;
		}
		if (verdict.kind === 'no-account') {
			// The key is not the problem: the account name is. edit-active-key
			// cannot change it (review, 2026-10-29).
			const relayEnv = `${process.env.MORPHIT_ENV_ROOT ?? ''}/etc/morphit/relay.env`;
			const both = existsSync(relayEnv);
			console.log(
				`  The name comes from the line MORPHIT_RELAY_ACCOUNT=… in ${loaded.infraPath}` +
					(both ? ` and in ${relayEnv} (the relay reads that one last).` : '.')
			);
			console.log('  Check it on this server:');
			console.log(`    sudo nano ${loaded.infraPath}`);
			if (both) console.log(`    sudo nano ${relayEnv}`);
			console.log('');
			return 1;
		}
		if (verdict.kind === 'unknown') {
			console.log('  Run this again once the chain can be reached, on this server:');
			console.log('    sudo morphit-ops show-key');
			console.log('');
		}
		return 0;
	} catch (err) {
		// Ctrl+C at the passphrase: stopped, not "could not load the key".
		if (isAbortError(err)) throw err;
		console.log(`✗ Could not load the key: ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	} finally {
		// Clear the decrypted secret reference promptly.
		wif = '';
	}
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
