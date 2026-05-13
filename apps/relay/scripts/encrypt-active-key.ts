#!/usr/bin/env node --experimental-strip-types
/**
 * Morphit relay — encrypt a plaintext WIF into a v1 envelope.
 *
 * One-shot operator tool for the passphrase-at-boot upgrade
 * path (ADR-0010 §4). Run once during deployment:
 *
 *   tsx scripts/encrypt-active-key.ts <plaintext-file> <output-file>
 *
 * The plaintext file is left untouched. The output file is
 * written atomically (temp file + rename) with mode 0400 so
 * an interrupted run doesn't leave a half-written or
 * world-readable envelope. Operator is prompted for the
 * passphrase twice and the two entries must match.
 *
 * After verifying the envelope decrypts correctly by booting
 * the relay, the operator should destroy the plaintext file.
 * This script doesn't do that — destruction is an ops
 * decision, not a deployment-script responsibility.
 *
 * EXAMPLE
 *   # After deployment:
 *   tsx scripts/encrypt-active-key.ts \
 *     /etc/morphit/keys/relay-active.key \
 *     /etc/morphit/keys/relay-active.enc
 *
 *   # Verify by booting the relay and entering the passphrase.
 *
 *   # Then (if and only if the above worked):
 *   sudo shred -u /etc/morphit/keys/relay-active.key
 */

import { closeSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { encryptEnvelope } from '../src/crypto/keyEnvelope.ts';
import { promptPassphrase } from '../src/crypto/promptPassphrase.ts';

async function main(): Promise<void> {
	const [, , srcArg, dstArg] = process.argv;
	if (!srcArg || !dstArg) {
		die('usage: encrypt-active-key.ts <plaintext-file> <output-file>');
	}

	let wif: string;
	try {
		wif = readFileSync(srcArg, 'utf8').trim();
	} catch (err) {
		die(`cannot read ${srcArg}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (wif.length === 0) {
		die(`${srcArg} is empty`);
	}
	// Minimal shape check — not a real WIF validator, just a
	// "refuse to encrypt something that's obviously not a key"
	// guard against operator-finger slips.
	if (!/^[5KL][1-9A-HJ-NP-Za-km-z]{50,}$/.test(wif)) {
		die(`${srcArg} does not look like a WIF (expected 5.../K.../L... base58 string). Aborting.`);
	}

	log('encryption passphrase will be required every time the relay boots.');
	log('choose something YOU can remember. No password reset exists.');

	let passphrase: string;
	try {
		passphrase = await promptPassphrase({
			prompt: 'Choose passphrase: ',
			minLength: 8
		});
		const confirm = await promptPassphrase({
			prompt: 'Confirm passphrase: ',
			minLength: 8
		});
		if (passphrase !== confirm) {
			die('passphrases do not match. Aborting — no file written.');
		}
	} catch (err) {
		die(`passphrase prompt failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	log('deriving key (scrypt N=2^17, ~1s on a typical VPS)…');
	const envelope = encryptEnvelope(wif, passphrase);

	// Atomic write: temp file + rename in the same directory.
	// Mode 0400 so the file is read-only to owner, no group/world
	// access. The relay enforces the same constraint on boot.
	const tmpPath = `${dstArg}.tmp-${process.pid}`;
	let fd: number;
	try {
		fd = openSync(tmpPath, 'w', 0o400);
	} catch (err) {
		die(`cannot open ${tmpPath} for write: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
		writeSync(fd, serialized, 0, 'utf8');
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmpPath, dstArg);
	} catch (err) {
		die(
			`cannot rename ${tmpPath} -> ${dstArg}: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	log(`wrote encrypted envelope to ${dstArg}`);
	log('');
	log('NEXT STEPS:');
	log(`  1. Point the relay at the new file:`);
	log(`     MORPHIT_RELAY_ACTIVE_KEY_FILE=${dstArg}`);
	log('  2. Restart the relay. It will prompt for the passphrase on stdin.');
	log('     (systemd: StandardInput=tty-force, or run in the foreground once.)');
	log('  3. Once you confirm the relay unlocks successfully:');
	log(`     sudo shred -u ${srcArg}`);
	log('  4. Store the passphrase in your password manager. There is no reset.');
}

function log(msg: string): void {
	// eslint-disable-next-line no-console
	console.log(`[encrypt-active-key] ${msg}`);
}

function die(msg: string): never {
	// eslint-disable-next-line no-console
	console.error(`[encrypt-active-key] FATAL: ${msg}`);
	process.exit(1);
}

main().catch((err) => {
	die(`uncaught: ${err instanceof Error ? err.message : String(err)}`);
});
