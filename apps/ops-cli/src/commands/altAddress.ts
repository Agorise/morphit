/**
 * morphit-ops `alt-address` — guided setup for a Tor / Lokinet / I2P address
 * (cp216).
 *
 * The init flow and `edit` only ever STORED a pasted address. This wizard is
 * the missing "how do I even make one?" layer: it walks the operator through
 * generating the address (on their own hardware, via the scripts/generate-*
 * helpers), captures + validates the result, writes it to morphit.config.env
 * through the same atomic write `edit` uses, and prints the short next steps.
 *
 * All on-screen guidance is deliberately short + plain-English (ELI5): a
 * sysadmin who has never touched Tor/Lokinet/I2P should be able to follow it.
 *
 * Reality the wizard is honest about:
 *   - Tor / I2P: you CAN pick the first few letters (a vanity prefix). I2P
 *     can only match a few letters (the address is a hash).
 *   - Lokinet: you CANNOT pick the letters — Lokinet makes the address for
 *     you. A readable name needs ONS (paid, on-chain). No vanity grinder.
 *   - The secret key is always made on the operator's own machine and never
 *     committed; only the public address goes into config → footer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ask, askChoice, askYesNo } from '../init/prompt.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { offerRestart } from '../lib/restartServices.ts';
import { atomicEnvWrite } from './edit.ts';
import {
	type AltNet,
	validateAltAddress,
	ENV_KEY,
	GEN_SCRIPT
} from '../lib/altAddressValidate.ts';

export interface AltAddressCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** Walk up from cwd to the repo root (matches the other commands' helper). */
function defaultRepoRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		const pkg = `${dir}/package.json`;
		if (existsSync(pkg)) {
			const parent = resolve(dir, '..');
			if (parent === dir) break;
			const parentPkg = `${parent}/package.json`;
			if (!existsSync(parentPkg)) return dir;
			dir = parent;
			continue;
		}
		const parent = resolve(dir, '..');
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}

function rule(): void {
	console.log('─'.repeat(58));
}

/** Clean a pasted vanity prefix down to the characters the tools allow
 *  (lowercase base32: a–z and 2–7). */
function cleanPrefix(raw: string): string {
	return raw.trim().toLowerCase().replace(/[^a-z2-7]/g, '');
}

/** Walk the operator through one network. Returns the validated address to
 *  save, or null if they backed out. */
async function collectAddress(net: AltNet): Promise<string | null> {
	const script = GEN_SCRIPT[net];

	if (net === 'tor') {
		console.log('');
		console.log('Tor (.onion) — the most common privacy address.');
		console.log('');
		console.log('You pick the first few letters; a tool tries random keys');
		console.log('until one starts with them. Short = fast, long = slow.');
		const prefix = cleanPrefix(await ask('First letters you want (e.g. morph)', 'morph'));
		if (prefix.length > 6) {
			console.log('  Heads up: 7+ letters can take hours. 4–6 is a good balance.');
		}
		console.log('');
		console.log('On your OWN computer (not the server), in the Morphit folder, run:');
		console.log(`    ./${script} ${prefix || 'morph'}`);
		console.log('It churns for a while, then prints an address + saves a secret');
		console.log('key file. Copy the key to the server over SSH (the script shows how).');
		console.log('Why your own computer? So the secret key is never born on the server.');
	} else if (net === 'i2p') {
		console.log('');
		console.log('I2P (.b32.i2p) — an established privacy network.');
		console.log('');
		console.log('You can pick the first few letters, but only a FEW (the address');
		console.log('is a hash): 1–5 letters is quick, 6 takes minutes, 7+ much longer.');
		const prefix = cleanPrefix(await ask('First letters you want, keep it short (e.g. morph)', 'morph'));
		if (prefix.length > 5) {
			console.log('  Heads up: more than ~5 letters gets slow fast. Shorter is better.');
		}
		console.log('');
		console.log('On your OWN computer (not the server), in the Morphit folder, run:');
		console.log(`    ./${script} ${prefix || 'morph'}`);
		console.log('It prints an address + saves a secret key file (private.dat).');
		console.log('Copy the key to the server over SSH (the script shows how).');
	} else {
		// Lokinet — no prefix possible.
		console.log('');
		console.log('Lokinet (.loki) — Lokinet picks the address for you.');
		console.log('You CANNOT choose the letters here (there is no vanity tool).');
		console.log('');
		console.log('On the SERVER (where Lokinet runs):');
		console.log('  1. In lokinet.ini under [network], add a keyfile line so your');
		console.log('     address stays the same:');
		console.log('       keyfile=/var/lib/lokinet/morphit-snapp.private');
		console.log('  2. sudo systemctl restart lokinet');
		console.log('     It makes the key and prints your ".loki" address.');
		console.log('  3. See it again later:');
		console.log("       sudo journalctl -u lokinet | grep -i '.loki' | tail");
		console.log(`(The ./${script} helper prints these same steps.)`);
		console.log('');
		console.log('Want a short name like "morphit.loki"? That is ONS — you buy it');
		console.log('with OXEN coin in the Oxen wallet (optional, costs money).');
	}

	// Capture + validate, looping on bad input.
	console.log('');
	for (;;) {
		const pasted = await ask('Paste the address here (or press Enter to go back)', '');
		if (pasted.trim().length === 0) return null;
		const res = validateAltAddress(net, pasted);
		if (res.ok) return res.value;
		console.log(`  ✗ ${res.reason}`);
		console.log('  Try again, or press Enter to go back.');
	}
}

export async function runAltAddress(ctx: AltAddressCtx): Promise<number> {
	const repoRoot = ctx.flags.out ? resolve(ctx.flags.out) : defaultRepoRoot();
	const configPath = `${repoRoot}/morphit.config.env`;

	console.log('');
	rule();
	console.log('  Set up a Tor / Lokinet / I2P address');
	rule();
	console.log('');
	console.log('  This gives people an extra, private way to reach your Morphit.');
	console.log('  The address shows up in your site footer. It is optional —');
	console.log('  your normal web address works fine on its own.');

	const hasConfig = existsSync(configPath);
	if (!hasConfig) {
		console.log('');
		console.log(`  Note: no settings file found at ${configPath}.`);
		console.log('  I will still walk you through it and, at the end, print the one');
		console.log('  line to add yourself (for SystemD/Docker-style setups).');
	}

	for (;;) {
		const idx = await askChoice(
			'Which network?',
			[
				'Tor (.onion) — most people already have it',
				'Lokinet (.loki) — newer, lightweight',
				'I2P (.b32.i2p) — long-established',
				'Done / cancel'
			],
			undefined,
			{ showList: true }
		);
		if (idx === 3) {
			console.log('\n  Nothing else to do. Bye!');
			return 0;
		}
		const net: AltNet = idx === 0 ? 'tor' : idx === 1 ? 'lokinet' : 'i2p';

		const address = await collectAddress(net);
		if (address === null) {
			console.log('  (Skipped — back to the list.)\n');
			continue;
		}

		// Confirm.
		const envKey = ENV_KEY[net];
		console.log('');
		console.log(`  Save this address?`);
		console.log(`    ${sanitizeForTerm(address)}`);
		console.log(`    (into ${envKey})`);
		const ok = await askYesNo('Save it?', true);
		if (!ok) {
			console.log('  Not saved.\n');
			continue;
		}

		if (!hasConfig) {
			// SystemD/Docker case: no file to patch — hand them the line.
			console.log('');
			console.log('  No settings file to write, so add this line to your env');
			console.log('  (SystemD `Environment=` or your Docker env), then restart');
			console.log('  the indexer and reload your site — the pill then appears:');
			console.log(`    ${envKey}=${address}`);
			console.log('');
		} else {
			const text = readFileSync(configPath, 'utf-8');
			const updates = new Map<string, string | null>([[envKey, address]]);
			const result = atomicEnvWrite(configPath, text, updates, 'parseEnv');
			if (!result.ok) {
				console.log(`\n  ✗ ${sanitizeForTerm(result.message)}`);
				return 3;
			}
			console.log(`\n  ✓ saved to ${configPath}`);
			console.log(`  ✓ backed up the old version to ${result.backupPath}`);

			// The indexer reads the address at boot, so it only reaches the
			// footer after a restart.  Offer to do it now (default yes) so the
			// operator doesn't have to run systemctl by hand — then the pill
			// appears on the next page load.
			await offerRestart(['morphit-indexer']);
			console.log('  Reload your site; the new pill appears in the footer.');
			console.log('');
		}

		const more = await askYesNo('Set up another network too?', false);
		if (!more) {
			console.log('\n  All done.');
			return 0;
		}
		console.log('');
	}
}
