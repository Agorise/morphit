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
 * The output file (if specified) is CREATED with mode 0600; a path that
 * already exists (file or symlink) is refused, never written through.
 * Operators on a privacy-conscious system should prefer tmpfs
 * (`/dev/shm`, `/run/user/<uid>`) so the plaintext never touches
 * persistent disk.
 */

import {
	existsSync,
	readFileSync,
	openSync,
	writeSync,
	fchmodSync,
	closeSync,
	constants as fsConstants
} from 'node:fs';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { resolve, join } from 'node:path';
import { askPassword } from '../init/prompt.ts';
import {
	decryptAltKey,
	altKeystoreFilename,
	type AltKeyEnvelope,
	type AltNetwork
} from '../init/altKeystore.ts';
import { inspectI2pKeyFile } from '../lib/i2pDestination.ts';

/** Printed when a stored I2P key is base64 TEXT, exported as binary instead. */
export const LEGACY_BASE64_NOTICE =
	'This I2P key was stored as base64 text by an older morphit-ops (1.17.15). i2pd ' +
	'cannot host a key in that form, so it is written in the binary form i2pd loads. ' +
	'To store it that way too, import the exported file again: ' +
	'morphit-ops import-altnet-key --network=i2p --in=<the exported file>\n';

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

	// v1.18.0 (F38) — AN ENVELOPE AN OLDER IMPORT WROTE. 1.17.15's importer
	// validated a base64 key by decoding it and then stored the ORIGINAL text
	// (F26). Fixing the importer protects new imports only; a key already stored
	// that way would still come out as text, which i2pd loads as no destination
	// at all and logs nothing about. A genuinely binary key never reads as
	// base64, so this converts exactly the keys that were stored wrong.
	if (net === 'i2p') {
		const insp = inspectI2pKeyFile(plaintext);
		if (insp.wasBase64 && insp.keyBytes !== null) {
			const binary = Buffer.from(insp.keyBytes);
			insp.keyBytes.fill(0);
			plaintext.fill(0);
			plaintext = binary;
			writeStderr(LEGACY_BASE64_NOTICE);
		}
	}

	const outPath = ctx.flags.out;
	if (outPath) {
		const outAbs = resolve(outPath);
		// This was writeFileSync(..., {mode:0o600})
		// then chmod: the mode applies only to a NEW file, so a file another user
		// had pre-created at this predictable path (mode 0666) was written
		// through and stayed theirs to read, and a symlink there redirected the
		// write. Create it exclusively (O_EXCL) and never through a symlink
		// (O_NOFOLLOW); an existing path is refused.
		let fd: number | null = null;
		try {
			fd = openSync(
				outAbs,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
				0o600
			);
			writeSync(fd, plaintext);
			fchmodSync(fd, 0o600);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			writeStderr(
				code === 'EEXIST' || code === 'ELOOP'
					? `${outAbs} already exists, so nothing was written. Remove it (or pick a new path) and run this again.\n`
					: `Failed to write ${outAbs}: ${err instanceof Error ? err.message : String(err)}\n`
			);
			plaintext.fill(0);
			return 3;
		} finally {
			if (fd !== null) closeSync(fd);
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

