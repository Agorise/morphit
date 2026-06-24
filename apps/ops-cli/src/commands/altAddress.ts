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
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { resolve } from 'node:path';

import { ask, askChoice, askYesNo } from '../init/prompt.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { offerRestart } from '../lib/restartServices.ts';
import { atomicEnvWrite } from './edit.ts';
import {
	type AltNet,
	validateAltAddress,
	validateI2pName,
	ENV_KEY,
	GEN_SCRIPT
} from '../lib/altAddressValidate.ts';

export interface AltAddressCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** Walk up from cwd to the repo root (matches the other commands' helper). */
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

// ─── cp311: managed-address CRUD helpers ─────────────────────────
//
// The wizard now manages four addresses, not three: Tor / Lokinet /
// I2P (which have an AltNet generator flow) plus Nostr (a pubkey the
// operator already owns — no generation).  `ManagedNet` widens AltNet
// to include nostr for the menu/CRUD layer only; the generator flow
// (`collectAddress`, `validateAltAddress`, `GEN_SCRIPT`) still uses the
// narrower `AltNet`.

type ManagedNet = AltNet | 'nostr' | 'i2p_name';
type AddrAction = 'replace' | 'clear' | 'back';

const NET_LABEL: Record<ManagedNet, string> = {
	tor: 'Tor (.onion) address',
	lokinet: 'Lokinet (.loki) address',
	i2p: 'I2P b32 address (DOMAIN.b32.i2p)',
	i2p_name: 'I2P vanity name (DOMAIN.i2p)',
	nostr: 'Nostr pubkey'
};

/** Env key(s) per address.  Element [0] is the canonical key we WRITE;
 *  any extras are legacy aliases we also CLEAR (so a stale value can't
 *  shadow the canonical one) and READ as fallback.  i2p historically
 *  used MORPHIT_INSTANCE_I2P_ADDRESS (what `init` writes); the indexer
 *  prefers MORPHIT_INSTANCE_I2P_B32_ADDRESS but falls back to the
 *  legacy key, so we keep both in sync here. */
const ENV_KEYS_FOR: Record<ManagedNet, readonly string[]> = {
	tor: [ENV_KEY.tor],
	lokinet: [ENV_KEY.lokinet],
	i2p: [ENV_KEY.i2p, 'MORPHIT_INSTANCE_I2P_ADDRESS'],
	i2p_name: ['MORPHIT_INSTANCE_I2P_NAME_ADDRESS'],
	nostr: ['MORPHIT_INSTANCE_NOSTR_PUBKEY']
};

/** Current value of a managed address from morphit.config.env text, or
 *  null.  For i2p this checks the modern key then the legacy alias. */
function readManagedValue(text: string, kind: ManagedNet): string | null {
	for (const key of ENV_KEYS_FOR[kind]) {
		const v = parseEnvValue(text, key);
		if (v !== null && v.length > 0) return v;
	}
	return null;
}

/** Minimal KEY=value reader: last assignment wins (matches the indexer's
 *  shell-source semantics), strips one layer of matching single/double
 *  quotes.  Comment + blank lines ignored. */
function parseEnvValue(text: string, key: string): string | null {
	let found: string | null = null;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		if (line.slice(0, eq).trim() !== key) continue;
		let value = line.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		found = value; // keep scanning — last assignment wins
	}
	return found;
}

/** Collect + validate a Nostr public key.  Nothing to "generate" — the
 *  operator already has a Nostr identity; they paste its PUBLIC key.
 *  Accept bech32 npub (npub1…) or 64-char hex; reject obvious secrets. */
async function collectNostr(): Promise<string | null> {
	console.log('');
	console.log('Nostr — link your instance to a Nostr profile.');
	console.log('');
	console.log('Paste your Nostr PUBLIC key. Two forms are accepted:');
	console.log('  - npub1…  (bech32, what most Nostr apps show)');
	console.log('  - a 64-character hex string');
	console.log('NEVER paste your PRIVATE key (nsec… / hex secret).');
	console.log('');
	for (;;) {
		const pasted = (await ask('Paste your Nostr pubkey (or press Enter to go back)', '')).trim();
		if (pasted.length === 0) return null;
		const res = validateNostr(pasted);
		if (res.ok) return res.value;
		console.log(`  ✗ ${res.reason}`);
		console.log('  Try again, or press Enter to go back.');
	}
}

/** Collect + validate an I2P vanity NAME (DOMAIN.i2p).  Nothing to
 *  "generate" — the operator registers a human-readable name with an
 *  i2p naming service / address book, then pastes it here.  This is the
 *  optional pretty alias for the always-resolvable .b32.i2p address. */
async function collectI2pName(): Promise<string | null> {
	console.log('');
	console.log('I2P vanity name — a human-readable alias like "morphit.i2p".');
	console.log('');
	console.log('This is OPTIONAL and separate from your .b32.i2p address: the b32');
	console.log('always resolves; the vanity name only resolves for visitors whose');
	console.log('i2p router has the name in its address book.  Register the name');
	console.log('with an i2p naming service first, then paste it here.');
	console.log('');
	for (;;) {
		const pasted = (await ask('Paste your DOMAIN.i2p vanity name (or press Enter to go back)', '')).trim();
		if (pasted.length === 0) return null;
		const res = validateI2pName(pasted);
		if (res.ok) return res.value;
		console.log(`  ✗ ${res.reason}`);
		console.log('  Try again, or press Enter to go back.');
	}
}

/** Validate a Nostr pubkey: npub1 bech32 or 64-char hex.  Lenient on the
 *  bech32 body (guards typos, not a full checksum verify); rejects nsec. */
export function validateNostr(
	raw: string
): { ok: true; value: string } | { ok: false; reason: string } {
	const v = raw.trim();
	if (v.toLowerCase().startsWith('nsec')) {
		return {
			ok: false,
			reason: 'that looks like a PRIVATE key (nsec…). Paste your PUBLIC key (npub… or hex).'
		};
	}
	if (/^npub1[a-z0-9]{58,}$/i.test(v)) return { ok: true, value: v.toLowerCase() };
	if (/^[0-9a-f]{64}$/i.test(v)) return { ok: true, value: v.toLowerCase() };
	return { ok: false, reason: 'expected an "npub1…" key or a 64-character hex string' };
}

export async function runAltAddress(ctx: AltAddressCtx): Promise<number> {
	const repoRoot = ctx.flags.out ? resolve(ctx.flags.out) : defaultRepoRoot();
	const configPath = `${repoRoot}/morphit.config.env`;

	console.log('');
	rule();
	console.log('  Alt-network addresses (Tor / Lokinet / I2P / Nostr)');
	rule();
	console.log('');
	console.log('  These give people extra, private ways to reach your Morphit.');
	console.log('  Each one shows up as a pill in your site footer (Nostr links to');
	console.log('  your instance\'s Nostr page). They are all optional — your normal');
	console.log('  web address works fine on its own.');

	const hasConfig = existsSync(configPath);
	if (!hasConfig) {
		console.log('');
		console.log(`  Note: no settings file found at ${configPath}.`);
		console.log('  I can still walk you through setup and print the one line to add');
		console.log('  yourself (for SystemD/Docker-style setups), but I can\'t show or');
		console.log('  delete existing values without a file to read.');
	}

	for (;;) {
		const idx = await askChoice(
			'Which address do you want to manage?',
			[
				'Tor (.onion)',
				'Lokinet (.loki)',
				'I2P b32 (DOMAIN.b32.i2p)',
				'I2P vanity (DOMAIN.i2p)',
				'Nostr (npub… / hex pubkey)',
				'Done / cancel'
			],
			undefined,
			{ showList: true }
		);
		if (idx === 5) {
			console.log('\n  Nothing else to do. Bye!');
			return 0;
		}

		const kind: ManagedNet =
			idx === 0
				? 'tor'
				: idx === 1
					? 'lokinet'
					: idx === 2
						? 'i2p'
						: idx === 3
							? 'i2p_name'
							: 'nostr';
		const label = NET_LABEL[kind];
		const fileText = hasConfig ? readFileSync(configPath, 'utf-8') : '';
		const current = hasConfig ? readManagedValue(fileText, kind) : null;

		// Show what's there now.
		console.log('');
		console.log(`  ${label}`);
		console.log(
			`    Current: ${current !== null ? sanitizeForTerm(current) : '(not set)'}`
		);

		// Per-address action menu.  Options differ by whether a value
		// exists and whether we have a file we can actually rewrite.
		const actions: string[] = [];
		const actionKeys: AddrAction[] = [];
		actions.push(current !== null ? 'Replace it with a new one' : 'Set it up');
		actionKeys.push('replace');
		if (current !== null && hasConfig) {
			actions.push('Delete it (remove from the footer)');
			actionKeys.push('clear');
		}
		actions.push('Back (pick a different address)');
		actionKeys.push('back');

		const aidx = await askChoice(`What do you want to do with your ${label}?`, actions, undefined, {
			showList: true
		});
		const action = actionKeys[aidx] ?? 'back';

		if (action === 'back') {
			console.log('');
			continue;
		}

		if (action === 'clear') {
			console.log('');
			const sure = await askYesNo(`Really delete your ${label}? It disappears from the footer.`, false);
			if (!sure) {
				console.log('  Left it as-is.\n');
				continue;
			}
			// For i2p we clear BOTH the modern (_I2P_B32_ADDRESS) and legacy
			// (_I2P_ADDRESS) keys so the value can't survive under the other
			// name.  Other networks clear their single key.
			const updates = new Map<string, string | null>();
			for (const k of ENV_KEYS_FOR[kind]) updates.set(k, null);
			const result = atomicEnvWrite(configPath, fileText, updates, 'parseEnv');
			if (!result.ok) {
				console.log(`\n  ✗ ${sanitizeForTerm(result.message)}`);
				return 3;
			}
			console.log(`\n  ✓ removed from ${configPath}`);
			console.log(`  ✓ backed up the old version to ${result.backupPath}`);
			await offerRestart(['morphit-indexer']);
			console.log('  Reload your site; the pill is gone from the footer.\n');
			continue;
		}

		// action === 'replace' (or first-time set).
		const address =
			kind === 'nostr'
				? await collectNostr()
				: kind === 'i2p_name'
					? await collectI2pName()
					: await collectAddress(kind);
		if (address === null) {
			console.log('  (Cancelled — back to the list.)\n');
			continue;
		}

		// Confirm.
		const writeKey = ENV_KEYS_FOR[kind][0]!; // canonical key we WRITE
		console.log('');
		console.log(`  Save this ${label}?`);
		console.log(`    ${sanitizeForTerm(address)}`);
		console.log(`    (into ${writeKey})`);
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
			console.log(`    ${writeKey}=${address}`);
			console.log('');
		} else {
			// Write the canonical key.  For i2p, ALSO clear the legacy
			// _I2P_ADDRESS key (if present) so it can't shadow the new
			// value the indexer reads.
			const updates = new Map<string, string | null>([[writeKey, address]]);
			for (const k of ENV_KEYS_FOR[kind].slice(1)) updates.set(k, null);
			const result = atomicEnvWrite(configPath, fileText, updates, 'parseEnv');
			if (!result.ok) {
				console.log(`\n  ✗ ${sanitizeForTerm(result.message)}`);
				return 3;
			}
			console.log(`\n  ✓ saved to ${configPath}`);
			console.log(`  ✓ backed up the old version to ${result.backupPath}`);
			await offerRestart(['morphit-indexer']);
			console.log('  Reload your site; the new pill appears in the footer.');
			console.log('');
		}
	}
}
