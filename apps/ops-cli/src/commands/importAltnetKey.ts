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
import { inspectI2pKeyFile } from '../lib/i2pDestination.ts';
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


/** The `.b32.i2p` address this instance currently advertises, if any.
 *  Read from the address KEY — never by scanning for the first b32 in the file,
 *  which on a box that also lists other nodes' hidden addresses would pick up a
 *  stranger's and compare the key against the wrong thing. */
function readConfiguredI2pAddress(): string | null {
	const repo = defaultRepoRoot();
	for (const key of ['MORPHIT_INSTANCE_I2P_B32_ADDRESS', 'MORPHIT_INSTANCE_I2P_ADDRESS']) {
		for (const file of [join(repo, 'morphit.config.env'), join(repo, 'morphit.env')]) {
			try {
				if (!existsSync(file)) continue;
				const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+)$`, 'm').exec(
					readFileSync(file, 'utf8')
				);
				if (m) {
					const v = m[1]!.trim().replace(/^["']|["']$/g, '');
					if (v.endsWith('.b32.i2p')) return v;
				}
			} catch {
				/* unreadable config must never block an import */
			}
		}
	}
	return null;
}

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

	// For I2P, do better than a length hint: DERIVE the address this key hosts
	// and show it. A length check cannot tell a correct key from a plausible
	// wrong one, and importing the wrong key surfaces much later as "peers
	// cannot reach this box" — the same shape of failure as advertising an
	// address your router does not host. The derived address is the one fact
	// that settles it, and the operator can compare it to what they registered.
	if (net === 'i2p') {
		const insp = inspectI2pKeyFile(plaintext);
		if (insp.address === null) {
			console.log(`This does not look like an I2P private-key file: ${insp.problem ?? 'unknown'}`);
			const goOn = await askYesNo('Import it anyway?', false);
			if (!goOn) {
				console.log('Nothing was written.');
				return 1;
			}
		} else if (insp.destinationOnly) {
			// This is the address, not the key. Importing it cannot work: i2pd
			// cannot prove ownership, so the address would silently never serve —
			// and the operator would only find out when peers could not reach them.
			console.log('');
			console.log(`  ✗ That is your PUBLIC address, not a private key.`);
			console.log(`    It decodes to ${insp.destinationBytes} bytes — a destination and nothing more.`);
			console.log(`    Address:  ${insp.address}`);
			console.log('');
			console.log(`    i2pd cannot host with this: without the private half it cannot prove`);
			console.log(`    ownership, so ${insp.address.slice(0, 16)}… would never serve.`);
			console.log('');
			console.log(`    Look for the PRIVATE key file from whatever generated the address —`);
			console.log(`    commonly eepPriv.dat or <name>.dat. Morphit's own installer writes`);
			console.log(`    one at 679 bytes (908 base64 characters). On a configured box it is`);
			console.log(`    what the "keys =" line in i2pd's tunnels.conf points at.`);
			console.log('');
			console.log('Nothing was written.');
			return 1;
		} else {
			console.log(
				`  ✓ Valid I2P private key (destination ${insp.destinationBytes} bytes` +
					`${insp.wasBase64 ? ', decoded from base64' : ''}).`
			);
			console.log(`    This key hosts:  ${insp.address}`);
			const configured = readConfiguredI2pAddress();
			if (configured !== null && configured !== '') {
				if (configured === insp.address) {
					console.log(`    Matches the address in your config. This is the right key.`);
				} else {
					console.log('');
					console.log(`    ⚠ Your config advertises a DIFFERENT address:`);
					console.log(`        config: ${configured}`);
					console.log(`        key:    ${insp.address}`);
					console.log(`      Peers use the ADVERTISED one, so these must agree. Either this is`);
					console.log(`      the wrong key file, or your config needs updating to the address`);
					console.log(`      above (then re-publish your registration).`);
					const goOn = await askYesNo('Import this key anyway?', false);
					if (!goOn) {
						console.log('Nothing was written.');
						return 1;
					}
				}
			} else {
				console.log(`    Set MORPHIT_INSTANCE_I2P_B32_ADDRESS to this address so peers learn it.`);
			}
			console.log('');
		}
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

