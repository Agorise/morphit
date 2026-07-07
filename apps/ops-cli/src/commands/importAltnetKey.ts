/**
 * Morphit ops CLI — `import-altnet-key` subcommand.
 *
 * Read a plaintext alt-network service key from a file path,
 * encrypt it with the operator's passphrase, store at the
 * canonical location.
 *
 * Usage:
 *   morphit-ops import-altnet-key --network=tor --in=/path/to/hs_ed25519_secret_key
 *   morphit-ops import-altnet-key --network=lokinet --in=/path/to/seed.private
 *   morphit-ops import-altnet-key --network=i2p --in=/path/to/eep.dat
 *
 * The plaintext file is NOT removed automatically — operator
 * decides whether to shred it (recommended) or back it up
 * elsewhere (also fine; the encrypted form is the runtime path).
 *
 * The same passphrase that protects the relay's active key
 * also protects this keystore.  ADR-0010 §4 envelope, with a
 * per-network AAD binding so an attacker who steals all three
 * files can't swap their contents.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { resolve, dirname, join } from 'node:path';
import { askPassword, askYesNo } from '../init/prompt.ts';
import { encryptAltKey, altKeystoreFilename, type AltNetwork } from '../init/altKeystore.ts';
import { sanitizeForTerm } from '../render/term.ts';

export interface ImportAltnetKeyCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

const VALID_NETWORKS: ReadonlySet<AltNetwork> = new Set(['tor', 'lokinet', 'i2p']);

export async function runImportAltnetKey(ctx: ImportAltnetKeyCtx): Promise<number> {
	const network = ctx.flags.network;
	const inputPath = ctx.flags.in;

	if (!network || !VALID_NETWORKS.has(network as AltNetwork)) {
		console.log(
			'Specify --network=tor, --network=lokinet, or --network=i2p.\n' +
				'Example:\n' +
				'  morphit-ops import-altnet-key --network=tor --in=/var/lib/tor/morphit/hs_ed25519_secret_key'
		);
		return 1;
	}
	const net = network as AltNetwork;

	if (!inputPath) {
		console.log('Specify --in=PATH where PATH is the plaintext key file.');
		return 1;
	}
	const inAbs = resolve(inputPath);
	if (!existsSync(inAbs)) {
		console.log(`Input file not found: ${inAbs}`);
		return 1;
	}

	let plaintext: Buffer;
	try {
		plaintext = readFileSync(inAbs);
	} catch (err) {
		console.log(`Failed to read ${inAbs}: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}`);
		return 1;
	}
	if (plaintext.length === 0) {
		console.log(`Input file is empty: ${inAbs}`);
		return 1;
	}

	// Sanity-check the input file looks like a service key.
	// Tor v3 hs_ed25519_secret_key is 96 bytes (32-byte header
	// + 64-byte key).  Lokinet and I2P keys vary.  We don't hard
	// enforce a specific length — this is a friendly hint only.
	if (net === 'tor' && plaintext.length !== 96) {
		console.log(
			`Note: Tor v3 hs_ed25519_secret_key is normally 96 bytes; this file is\n` +
				`${plaintext.length} bytes.  Continuing — this is a hint, not an error.\n`
		);
	}

	const repoRoot = ctx.flags.out ? resolve(ctx.flags.out) : defaultRepoRoot();
	const altDir = join(repoRoot, 'apps', 'relay', 'altnet');
	const outPath = join(altDir, altKeystoreFilename(net));

	if (existsSync(outPath)) {
		const overwrite = await askYesNo(`A keystore already exists at ${outPath}.  Overwrite?`, false);
		if (!overwrite) {
			console.log('Aborted.  Existing keystore unchanged.');
			return 1;
		}
		// Backup before overwriting.
		const backup = `${outPath}.bak-${Date.now()}`;
		try {
			const old = readFileSync(outPath);
			writeFileSync(backup, old, { mode: 0o600 });
			chmodSync(backup, 0o600);
			console.log(`  ✓ Backed up existing keystore to ${backup}`);
		} catch (err) {
			console.log(`Could not back up: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}`);
			return 3;
		}
	}

	console.log('');
	console.log(
		`This will encrypt your ${net} service key with your relay\n` +
			'passphrase (the same one you set during the wizard).  Type\n' +
			'the passphrase below — it will not be echoed.  Forgetting it\n' +
			'means you cannot recover the key from this file; back up the\n' +
			'plaintext separately if that worries you.\n'
	);

	const passphrase = await askPassword('Relay passphrase');
	if (passphrase.length < 8) {
		console.log('Passphrase too short.  Aborted.');
		return 1;
	}

	const passphraseConfirm = await askPassword('Confirm passphrase');
	if (passphrase !== passphraseConfirm) {
		console.log("Passphrases didn't match.  Aborted.");
		return 1;
	}

	let envelope;
	try {
		envelope = encryptAltKey(plaintext, passphrase, net);
	} catch (err) {
		console.log(`Encryption failed: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}`);
		return 3;
	}

	// Wipe plaintext buffer (best-effort).
	plaintext.fill(0);

	try {
		mkdirSync(altDir, { recursive: true });
		chmodSync(altDir, 0o700);
	} catch (err) {
		console.log(`Could not create ${altDir}: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}`);
		return 3;
	}

	try {
		writeFileSync(outPath, JSON.stringify(envelope, null, 2), {
			mode: 0o600
		});
		chmodSync(outPath, 0o600);
	} catch (err) {
		console.log(`Could not write ${outPath}: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}`);
		return 3;
	}

	console.log('');
	console.log(`  ✓ encrypted ${net} key written to ${outPath}`);
	console.log('  ✓ permissions set to 600');
	console.log('');
	console.log('Next steps:');
	console.log(`  - Decide what to do with the plaintext at ${inAbs}: shred it`);
	console.log('    (most operators), back it up offline, or leave it.');
	console.log('  - At relay startup, the same passphrase you set during the');
	console.log("    wizard will unlock this keystore.  Use 'morphit-ops");
	console.log("    export-altnet-key' to extract the plaintext when your");
	console.log(`    ${net} daemon needs it.`);
	console.log('');

	return 0;
}

