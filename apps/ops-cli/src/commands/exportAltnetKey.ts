/**
 * Morphit ops CLI — `export-altnet-key` subcommand.
 *
 * Decrypt an alt-network service key envelope and emit the
 * plaintext to stdout (binary) or a destination file.
 *
 * Typical use: an operator's systemd unit or shell script runs
 * this just before launching the alt-network daemon, prompts
 * for the passphrase once, writes the plaintext to a tmpfs path,
 * starts the daemon pointed at that path, then deletes it.
 *
 * Usage:
 *   morphit-ops export-altnet-key --network=tor --out=/dev/shm/morphit-tor-key
 *   morphit-ops export-altnet-key --network=lokinet --out=/dev/shm/morphit-loki-seed
 *   morphit-ops export-altnet-key --network=i2p --out=/dev/shm/morphit-i2p-eep
 *
 * If --out is omitted, plaintext is written to stdout (suitable
 * for piping).  Stdout writes are binary-safe.
 *
 * The output file (if specified) is written with mode 0600.
 * Operators on a privacy-conscious system should prefer tmpfs
 * (`/dev/shm`, `/run/user/<uid>`) so the plaintext never touches
 * persistent disk.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { resolve, join } from 'node:path';
import { askPassword } from '../init/prompt.ts';
import {
	decryptAltKey,
	altKeystoreFilename,
	type AltKeyEnvelope,
	type AltNetwork
} from '../init/altKeystore.ts';

export interface ExportAltnetKeyCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

const VALID_NETWORKS: ReadonlySet<AltNetwork> = new Set(['tor', 'lokinet', 'i2p']);

export async function runExportAltnetKey(ctx: ExportAltnetKeyCtx): Promise<number> {
	const network = ctx.flags.network;
	if (!network || !VALID_NETWORKS.has(network as AltNetwork)) {
		writeStderr('Specify --network=tor, --network=lokinet, or --network=i2p.\n');
		return 1;
	}
	const net = network as AltNetwork;

	const repoRoot = ctx.flags.repo ? resolve(ctx.flags.repo) : defaultRepoRoot();
	const inPath = join(repoRoot, 'apps', 'relay', 'altnet', altKeystoreFilename(net));
	if (!existsSync(inPath)) {
		writeStderr(`No keystore found at ${inPath}.\n`);
		writeStderr("Run 'morphit-ops import-altnet-key' first to create one.\n");
		return 1;
	}

	let envelope: AltKeyEnvelope;
	try {
		const text = readFileSync(inPath, 'utf-8');
		envelope = JSON.parse(text) as AltKeyEnvelope;
	} catch (err) {
		writeStderr(
			`Failed to read or parse ${inPath}: ${err instanceof Error ? err.message : String(err)}\n`
		);
		return 3;
	}

	if (envelope.network !== net) {
		writeStderr(
			`Keystore at ${inPath} claims network=${envelope.network} ` +
				`but you asked for ${net}.\n` +
				'Refusing to decrypt — likely a misnamed file.\n'
		);
		return 3;
	}

	// Passphrase prompting goes to STDERR so STDOUT stays clean
	// for binary output when --out is not specified.
	writeStderr(`Enter relay passphrase to decrypt ${net} key:\n`);
	const passphrase = await askPassword('Passphrase');

	let plaintext: Buffer;
	try {
		plaintext = decryptAltKey(envelope, passphrase);
	} catch (err) {
		writeStderr(`Decryption failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 3;
	}

	const outPath = ctx.flags.out;
	if (outPath) {
		const outAbs = resolve(outPath);
		try {
			writeFileSync(outAbs, plaintext, { mode: 0o600 });
			chmodSync(outAbs, 0o600);
		} catch (err) {
			writeStderr(
				`Failed to write ${outAbs}: ${err instanceof Error ? err.message : String(err)}\n`
			);
			plaintext.fill(0);
			return 3;
		}
		writeStderr(`Wrote ${plaintext.length} bytes to ${outAbs} (mode 600).\n`);
	} else {
		// Stdout — binary-safe.  Use process.stdout.write rather
		// than console.log (the latter would utf-8-encode and
		// mutilate binary data).
		process.stdout.write(plaintext);
	}

	plaintext.fill(0);
	return 0;
}

function writeStderr(s: string): void {
	process.stderr.write(s);
}

