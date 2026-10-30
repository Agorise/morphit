/**
 * morphit-ops `alt-address` — guided setup for a Tor / Lokinet / I2P address.
 *
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

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { resolveOutputPath } from '../init/render.ts';

import { ask, askChoice, askYesNo } from '../init/prompt.ts';
import { sanitizeForTerm } from '../render/term.ts';
import {
	effectiveSettings,
	liveServiceEnvs,
	restartAndCheck,
	settingsFilesFor,
	type RestartOutcome
} from '../lib/laterEnvShadow.ts';
import { offerRestart } from '../lib/restartServices.ts';
import { syncInstanceOrigin } from '../lib/instanceOrigin.ts';
import { startDotsSpinner } from '../init/spinner.ts';
import { resolveWebRoot } from './upgrade.ts';
import { atomicEnvWrite, offerRepublish, registrationBlockers } from './edit.ts';
import { runRegister } from './register.ts';
import { reportHosting, TOR_HS_DIR } from '../lib/altAddressHosted.ts';
import {
	type AltNet,
	validateAltAddress,
	validateI2pName,
	validateEnsName,
	validateNostr,
	ENV_KEY,
	ENS_ENV_KEY,
	GEN_SCRIPT
} from '../lib/altAddressValidate.ts';

// Kept importable from here (alt-address-wizard-smoke and older callers).
export { validateNostr };

/** Restart the indexer for a saved address — after removing any old copy in a
 *  file it reads last (/etc/morphit/indexer.env), which would keep it. Only
 *  when the file saved is the installed one: another copy (--out) has nothing
 *  on this server to clear or check against. Says whether it restarted and
 *  whether the running indexer was CHECKED to have the new value. */
const restartAfterSave = (live: boolean, written: readonly string[]): Promise<RestartOutcome> =>
	restartAndCheck(written, ['morphit-indexer'], {
		offer: (units) => offerRestart(units),
		print: (line) => console.log(line === '' ? '' : `  ${sanitizeForTerm(line)}`),
		envs: live ? liveServiceEnvs() : []
	});

export interface AltAddressCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

function rule(): void {
	console.log('─'.repeat(58));
}

/** Clean a pasted vanity prefix down to the characters the tools allow
 *  (lowercase base32: a–z and 2–7). */
function cleanPrefix(raw: string): string {
	return raw.trim().toLowerCase().replace(/[^a-z2-7]/g, '');
}

/** The home folder of `user` on this server (passwd, as getent reads it), or
 *  null when it cannot be told. */
function homeOf(user: string): string | null {
	try {
		const r = spawnSync('getent', ['passwd', user], { encoding: 'utf8', timeout: 5_000 });
		const home = (r.stdout ?? '').trim().split('\n')[0]?.split(':')[5];
		return r.status === 0 && home !== undefined && home.startsWith('/') ? home : null;
	} catch {
		return null;
	}
}

export interface SshTarget {
	/** user@host for scp. */
	readonly target: string;
	/** The host is a placeholder the operator replaces. */
	readonly placeholder: boolean;
	/** Where that account's files land on this server (its home folder; "~"
	 *  when it could not be looked up). */
	readonly home: string;
}

/** Where the operator's computer reaches this server over SSH, for the copy
 *  commands: the account that ran `sudo` (a hardened server refuses root over
 *  SSH: PermitRootLogin no), root only when there is none; and the public
 *  origin's host when there is one, else a placeholder that says what to put
 *  there. */
export function sshTarget(
	configText: string,
	env: NodeJS.ProcessEnv = process.env,
	home: (user: string) => string | null = homeOf
): SshTarget {
	const sudoUser = (env.SUDO_USER ?? '').trim();
	const user =
		sudoUser !== '' && sudoUser !== 'root' && /^[a-z_][a-z0-9_.-]*\$?$/i.test(sudoUser) ? sudoUser : 'root';
	// Not found: "~" — that account's home when it runs the commands, exact
	// without guessing a path.
	const userHome = user === 'root' ? '/root' : (home(user) ?? '~');
	const origin = parseEnvValue(configText, 'MORPHIT_INSTANCE_ORIGIN');
	if (origin !== null) {
		try {
			const u = new URL(origin);
			if (u.protocol === 'https:' && u.hostname !== '' && !u.hostname.endsWith('.onion'))
				return { target: `${user}@${u.hostname}`, placeholder: false, home: userHome };
		} catch {
			/* not a URL: fall through */
		}
	}
	return { target: `${user}@YOUR-SERVER`, placeholder: true, home: userHome };
}

/**
 * The exact steps to make a vanity Tor / I2P address on the operator's own
 * computer and install its key into the hidden service this server ALREADY
 * runs (Ansible's roles/tor and roles/i2pd), so that Tor / i2pd serve the new
 * address with no new configuration. Each line names its machine.
 *
 * (They used to say: copy the directory "root-owned, mode 0700" and add
 * HiddenServiceDir lines to torrc — Tor refuses a hidden-service directory it
 * does not own, and Ansible already manages those torrc lines, so following
 * them broke the onion. Plain `scp` also fails on a hardened server, which
 * turns SSH's SFTP off: `scp -O` uses the older transfer that still works.)
 */
export function vanitySteps(
	net: 'tor' | 'i2p',
	prefix: string,
	ssh: string,
	repoRoot: string,
	/** That account's home folder on this server, where its copies land. */
	home = '/root'
): string[] {
	const script = net === 'tor' ? 'generate-onion.sh' : 'generate-i2p.sh';
	const host = ssh;
	const lines: string[] = [];
	lines.push('Make it on your OWN computer (not this server), so the secret key is never');
	lines.push('born here. Then install its key into the service this server already runs.');
	lines.push('');
	lines.push('1. On your computer, copy the helper script from this server and run it:');
	lines.push(`     scp -O ${host}:${repoRoot}/${GEN_SCRIPT[net]} ~/${script}`);
	lines.push(`     cd ~ && bash ${script} ${prefix} ${host}`);
	lines.push(
		net === 'tor'
			? '   It needs mkp224o (it says how to get it). It prints your new address and the'
			: '   It needs "vain" from i2pd-tools (it says how to get it). It prints your new'
	);
	lines.push(
		net === 'tor'
			? '   folder it saved the key in (a new folder each run).'
			: '   address and the folder it saved the key in (a new folder each run).'
	);
	if (net === 'tor') {
		lines.push('2. On your computer, copy the new key to this server: run the "cd" and "scp -O"');
		lines.push('   lines the script printed under "1. On THIS computer" (they name that folder).');
		lines.push(`   They put hs_ed25519_secret_key, hs_ed25519_public_key and hostname in ${home}/.`);
		lines.push('3. On this server, keep a copy of the current key, put the new one in place');
		lines.push('   (owned by Tor, or Tor refuses it), and restart Tor:');
		lines.push(`     sudo cp -a ${TOR_HS_DIR} "/root/morphit-onion-old-$(date +%s)"`);
		lines.push(
			`     sudo install -o debian-tor -g debian-tor -m 600 ${home}/hs_ed25519_secret_key ${home}/hs_ed25519_public_key ${TOR_HS_DIR}/`
		);
		lines.push(`     sudo install -o debian-tor -g debian-tor -m 644 ${home}/hostname ${TOR_HS_DIR}/hostname`);
		lines.push(`     sudo chown -R debian-tor:debian-tor ${TOR_HS_DIR}`);
		lines.push(`     sudo chmod 700 ${TOR_HS_DIR}`);
		lines.push(`     sudo shred -u ${home}/hs_ed25519_secret_key`);
		lines.push(`     sudo rm -f ${home}/hs_ed25519_public_key ${home}/hostname`);
		lines.push('     sudo systemctl restart tor');
		lines.push('4. On this server, check that Tor now serves it (it prints the address):');
		lines.push(`     sudo cat ${TOR_HS_DIR}/hostname`);
		lines.push('   No new torrc lines are needed: the hidden service is already set up.');
	} else {
		lines.push('2. On your computer, copy the new key to this server: run the "scp -O" line the');
		lines.push('   script printed under "1. On THIS computer" (it names that folder). It puts');
		lines.push(`   the key in ${home}/morphit-web.dat.`);
		lines.push('3. On this server, keep a copy of the current key, put the new one in place');
		lines.push('   (owned by i2pd) and restart i2pd:');
		lines.push(
			'     sudo test -f /var/lib/i2pd/morphit-web.dat && sudo cp -a /var/lib/i2pd/morphit-web.dat "/root/morphit-web.dat.old-$(date +%s)"'
		);
		lines.push(`     sudo install -o i2pd -g i2pd -m 600 ${home}/morphit-web.dat /var/lib/i2pd/morphit-web.dat`);
		lines.push(`     sudo shred -u ${home}/morphit-web.dat`);
		lines.push('     sudo systemctl restart i2pd');
		lines.push('   The [morphit-web] tunnel in /etc/i2pd/tunnels.conf already uses that key file;');
		lines.push('   do not add a second tunnel.');
	}
	return lines;
}

/** Walk the operator through one network. Returns the validated address to
 *  save, or null if they backed out. */
async function collectAddress(net: AltNet, configText: string, repoRoot: string): Promise<string | null> {
	const ssh = sshTarget(configText);

	if (net === 'tor' || net === 'i2p') {
		console.log('');
		if (net === 'tor') {
			console.log('Tor (.onion) — the most common privacy address.');
			console.log('');
			console.log('You pick the first few letters; a tool tries random keys');
			console.log('until one starts with them. Short = fast, long = slow.');
		} else {
			console.log('I2P (.b32.i2p) — an established privacy network.');
			console.log('');
			console.log('You can pick the first few letters, but only a FEW (the address');
			console.log('is a hash): 1–5 letters is quick, 6 takes minutes, 7+ much longer.');
		}
		const raw = await ask(
			net === 'tor' ? 'First letters you want (e.g. morph)' : 'First letters you want, keep it short (e.g. morph)',
			'morph'
		);
		const prefix = cleanPrefix(raw) || 'morph';
		if (net === 'tor' && prefix.length > 6) console.log('  Heads up: 7+ letters can take hours. 4–6 is a good balance.');
		if (net === 'i2p' && prefix.length > 5) console.log('  Heads up: more than ~5 letters gets slow fast. Shorter is better.');
		console.log('');
		for (const l of vanitySteps(net, prefix, ssh.target, repoRoot, ssh.home)) console.log(l);
		if (ssh.placeholder) {
			console.log('');
			console.log('(Put the address you use with ssh for this server in place of YOUR-SERVER.)');
		}
		if (ssh.target.startsWith('root@')) {
			console.log('');
			console.log('(These use root: no other account ran this command. A hardened server refuses');
			console.log('root over ssh — then use your own login in place of root, and its home folder');
			console.log('in place of /root.)');
		}
	} else {
		// Lokinet — no prefix possible.
		console.log('');
		console.log('Lokinet (.loki) — Lokinet picks the address for you.');
		console.log('You CANNOT choose the letters here (there is no vanity tool).');
		console.log('');
		console.log('On this server (where Lokinet runs):');
		console.log('  1. Open Lokinet\'s settings file (one of these exists):');
		console.log('       sudo nano /etc/loki/lokinet.ini');
		console.log('       sudo nano /var/lib/lokinet/lokinet.ini');
		console.log('     Under [network], add this line so your address stays the same:');
		console.log('       keyfile=/var/lib/lokinet/morphit-snapp.private');
		console.log('  2. Restart Lokinet; it makes the key and logs your ".loki" address:');
		console.log('       sudo systemctl restart lokinet');
		console.log('  3. Read the address:');
		console.log("       sudo journalctl -u lokinet --no-pager | grep -i '\\.loki' | tail");
		console.log('');
		console.log('Want a short name like "yourbrand.loki"? That is ONS — you buy it');
		console.log('with OXEN coin in the Oxen wallet (optional, costs money).');
	}

	// Capture + validate, looping on bad input.
	console.log('');
	for (;;) {
		const pasted = await ask('Paste the new address here (or press Enter to go back)', '');
		if (pasted.trim().length === 0) return null;
		const res = validateAltAddress(net, pasted);
		if (res.ok) {
			if (net === 'lokinet') {
				// Saving puts the pill in the footer. Morphit's installer does not
				// set up serving the site over Lokinet: say so, never imply it.
				console.log('');
				console.log('  Note: Morphit does not set up serving your site over Lokinet. The address');
				console.log('  points at this server\'s Lokinet connection; visitors reach your site there');
				console.log('  only if your web front answers on it. Check from a computer that runs');
				console.log(`  Lokinet by opening http://${sanitizeForTerm(res.value)}/ in its browser.`);
			}
			return res.value;
		}
		console.log(`  ✗ ${res.reason}`);
		console.log('  Try again, or press Enter to go back.');
	}
}

// ─── managed-address CRUD helpers ─────────────────────────
//
// The wizard now manages four addresses, not three: Tor / Lokinet /
// I2P (which have an AltNet generator flow) plus Nostr (a pubkey the
// operator already owns — no generation).  `ManagedNet` widens AltNet
// to include nostr for the menu/CRUD layer only; the generator flow
// (`collectAddress`, `validateAltAddress`, `GEN_SCRIPT`) still uses the
// narrower `AltNet`.

type ManagedNet = AltNet | 'nostr' | 'i2p_name' | 'ens';
type AddrAction = 'replace' | 'clear' | 'back';

const NET_LABEL: Record<ManagedNet, string> = {
	tor: 'Tor (.onion) address',
	lokinet: 'Lokinet (.loki) address',
	i2p: 'I2P b32 address (DOMAIN.b32.i2p)',
	i2p_name: 'I2P vanity name (DOMAIN.i2p)',
	nostr: 'Nostr pubkey',
	ens: 'ENS name (DOMAIN.eth)'
};

/** The env key per address (element [0] is the key we WRITE). */
const ENV_KEYS_FOR: Record<ManagedNet, readonly string[]> = {
	tor: [ENV_KEY.tor],
	lokinet: [ENV_KEY.lokinet],
	// The legacy single MORPHIT_INSTANCE_I2P_ADDRESS (what older `init`
	// wrote) is read and retired by readManagedValue / managedUpdates.
	i2p: [ENV_KEY.i2p],
	i2p_name: ['MORPHIT_INSTANCE_I2P_NAME_ADDRESS'],
	nostr: ['MORPHIT_INSTANCE_NOSTR_PUBKEY'],
	ens: [ENS_ENV_KEY]
};

const LEGACY_I2P_KEY = 'MORPHIT_INSTANCE_I2P_ADDRESS';

/** Which slot the legacy single I2P setting belongs to, by its ending (the
 *  indexer's own rule): a .b32.i2p is the b32 address, any other .i2p is the
 *  vanity name. PURE. */
function legacyI2pSlot(v: string): 'i2p' | 'i2p_name' {
	return v.toLowerCase().endsWith('.b32.i2p') ? 'i2p' : 'i2p_name';
}

/** Current value of a managed address from morphit.config.env text, or
 *  null. The legacy single I2P setting is read into the slot its ending says
 *  (it used to land in the b32 slot whatever it was). */
function readManagedValue(text: string, kind: ManagedNet): string | null {
	return readManagedFrom((k) => parseEnvValue(text, k), kind);
}

/** {@link readManagedValue} from any reader (the settings in force). */
function readManagedFrom(get: (key: string) => string | null, kind: ManagedNet): string | null {
	const v = get(ENV_KEYS_FOR[kind][0]!);
	if (v !== null && v.length > 0) return v;
	if (kind === 'i2p' || kind === 'i2p_name') {
		const legacy = get(LEGACY_I2P_KEY);
		if (legacy !== null && legacy.length > 0 && legacyI2pSlot(legacy) === kind) return legacy;
	}
	return null;
}

/** The writes that set (or, value null, clear) one managed address. Writing
 *  either I2P slot also retires the legacy single setting — moving a value it
 *  holds for the OTHER slot into that slot's own key, so nothing is lost. */
function managedUpdates(text: string, kind: ManagedNet, value: string | null): Map<string, string | null> {
	const updates = new Map<string, string | null>([[ENV_KEYS_FOR[kind][0]!, value]]);
	if (kind === 'i2p' || kind === 'i2p_name') {
		const legacy = parseEnvValue(text, LEGACY_I2P_KEY);
		if (legacy !== null) {
			updates.set(LEGACY_I2P_KEY, null);
			const slot = legacy.length > 0 ? legacyI2pSlot(legacy) : kind;
			const otherKey = ENV_KEYS_FOR[slot][0]!;
			if (slot !== kind && (parseEnvValue(text, otherKey) ?? '') === '') updates.set(otherKey, legacy);
		}
	}
	return updates;
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
	console.log('I2P vanity name — a human-readable alias like "yourbrand.i2p".');
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

/** Collect + validate an ENS name (DOMAIN.eth).  Nothing to "generate" — the
 *  operator registers the name on Ethereum (ENS), points it at their instance
 *  (typically an ENS contenthash → IPFS site), then pastes the name here.
 *  Advertised as a footer pill; Morphit does not resolve it. */
async function collectEns(): Promise<string | null> {
	console.log('');
	console.log('ENS name — a decentralized .eth name like "yourbrand.eth".');
	console.log('');
	console.log('This is OPTIONAL. Register the name on Ethereum (ENS) and point it');
	console.log('at your instance — usually by setting its contenthash to an IPFS');
	console.log('copy of your site. Visitors open it with an ENS-aware browser or an');
	console.log('ENS gateway. Paste just the name (e.g. yourbrand.eth), not a URL.');
	console.log('');
	for (;;) {
		const pasted = (await ask('Paste your DOMAIN.eth name (or press Enter to go back)', '')).trim();
		if (pasted.length === 0) return null;
		const res = validateEnsName(pasted);
		if (res.ok) return res.value;
		console.log(`  ✗ ${res.reason}`);
		console.log('  Try again, or press Enter to go back.');
	}
}

/** The addresses that ride in the on-chain registration (register.ts
 *  alt_addresses). Nostr does not. */
const REGISTERED: ReadonlySet<ManagedNet> = new Set(['tor', 'lokinet', 'i2p', 'i2p_name', 'ens']);

const isDenied = (err: unknown): boolean => {
	const code = (err as { code?: unknown } | null)?.code;
	return code === 'EACCES' || code === 'EPERM' || /EACCES|EPERM/.test(err instanceof Error ? err.message : String(err));
};
const SUDO_HINT = 'Run it with sudo: sudo morphit-ops alt-address';

export async function runAltAddress(ctx: AltAddressCtx): Promise<number> {
	// A relative --out is relative to where the operator ran the command.
	const repoRoot = resolveOutputPath(ctx.flags.out, defaultRepoRoot());
	const configPath = `${repoRoot}/morphit.config.env`;
	const where = settingsFilesFor(configPath, `${repoRoot}/morphit.env`);

	console.log('');
	rule();
	console.log('  Alt-network addresses (Tor / Lokinet / I2P / Nostr / ENS)');
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
				'ENS (DOMAIN.eth)',
				'Done / cancel'
			],
			undefined,
			{ showList: true }
		);
		if (idx === 6) {
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
							: idx === 4
								? 'nostr'
								: 'ens';
		const label = NET_LABEL[kind];
		let fileText = '';
		if (hasConfig) {
			try {
				fileText = readFileSync(configPath, 'utf-8');
			} catch (err) {
				if (!isDenied(err)) throw err;
				console.log(`\n  ✗ Can't read your settings (${configPath}) as this user.`);
				console.log(`  ${SUDO_HINT}`);
				return 1;
			}
		}
		// What the indexer runs with: every file it reads, the last one wins (an
		// older server keeps a copy in /etc/morphit/indexer.env, read last).
		let current: string | null = null;
		if (hasConfig) {
			const inForce = effectiveSettings(where.indexer, [...ENV_KEYS_FOR[kind], LEGACY_I2P_KEY]);
			current = readManagedFrom((k) => inForce.get(k) ?? null, kind);
		}

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

		let address: string | null = null;
		if (action === 'clear') {
			console.log('');
			const sure = await askYesNo(`Really delete your ${label}? It disappears from the footer.`, false);
			if (!sure) {
				console.log('  Left it as-is.\n');
				continue;
			}
		} else {
			// action === 'replace' (or first-time set).
			address =
				kind === 'nostr'
					? await collectNostr()
					: kind === 'i2p_name'
						? await collectI2pName()
						: kind === 'ens'
							? await collectEns()
							: await collectAddress(kind, fileText, repoRoot);
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
				continue;
			}
		}

		const updates = managedUpdates(fileText, kind, address);
		const result = atomicEnvWrite(configPath, fileText, updates, 'parseEnv');
		if (!result.ok) {
			console.log(`\n  ✗ ${sanitizeForTerm(result.message)}`);
			if (isDenied(result.message)) console.log(`  ${SUDO_HINT}`);
			return 3;
		}
		console.log(`\n  ✓ ${address === null ? 'removed from' : 'saved to'} ${configPath}`);
		console.log(`  ✓ backed up the old version to ${result.backupPath}`);
		const outcome = await restartAfterSave(where.live, [...updates.keys()]);
		if (outcome.live === true) {
			// Checked: the running indexer has it.
			console.log(
				address === null
					? '  Reload your site; the pill is gone from the footer.'
					: '  Reload your site; the new pill appears in the footer.'
			);
		} else if (outcome.live === false) {
			// What the check found was just said (not running, or another value).
			console.log('  Your footer changes once the indexer runs with it (see the check above).');
		} else if (outcome.restarted) {
			console.log('  Reload your site to see your footer: whether the running indexer has the');
			console.log('  new setting could not be checked from here.');
		} else {
			// The restart commands were just printed (offerRestart, on decline).
			console.log('  Your footer changes after that restart.');
		}
		console.log('');

		// Does this server's Tor / i2pd serve what was just saved?
		if (address !== null && (kind === 'tor' || kind === 'i2p'))
			await reportHosting(kind, address, { fix: 'follow the steps shown above, then run this again.' });

		// The served pages, sitemap and robots.txt name the onion on a
		// hidden-only node: put a changed Tor address on the live site, as
		// `edit` does.
		if (kind === 'tor') {
			try {
				const webRoot = resolveWebRoot(process.env);
				const r = syncInstanceOrigin(
					{
						info: (m) => console.log(`  ${m}`),
						warn: (m) => console.log(`  ! ${m}`),
						spinner: (l) => startDotsSpinner(l)
					},
					{ installDir: repoRoot, webRoot: existsSync(webRoot) ? webRoot : null }
				);
				if (r.detail !== '') console.log(`  ${r.verified ? '' : '! '}${sanitizeForTerm(r.detail)}`);
			} catch (err) {
				console.log(
					`  ! The site's pages were not updated (${sanitizeForTerm(err instanceof Error ? err.message : String(err))}). On this server run: sudo morphit-ops upgrade`
				);
			}
		}

		// Saving only changes this site's footer. The address is also part of
		// the on-chain registration other instances read: offer to re-publish it.
		if (REGISTERED.has(kind)) await offerRegistrationUpdate(fileText, updates, outcome);
		console.log('');
	}
}

/** After a saved address that is part of the on-chain registration: offer to
 *  re-publish it — or, when register could not run (no name, no address),
 *  say exactly what to set. */
async function offerRegistrationUpdate(
	before: string,
	updates: ReadonlyMap<string, string | null>,
	outcome: RestartOutcome
): Promise<void> {
	// `register` reads these from the file just written; no older value in
	// this process's environment may stand in for one.
	for (const [k, v] of updates) {
		if (v === null) delete process.env[k];
		else process.env[k] = v;
	}
	const eff = (k: string): string => {
		const fromFile = updates.has(k) ? (updates.get(k) ?? '') : (parseEnvValue(before, k) ?? '');
		return ((process.env[k] ?? '').trim() || fromFile).trim();
	};
	console.log('');
	console.log('  Other Morphit instances list your addresses from your on-chain registration;');
	console.log('  saving here changes only your own footer until that is re-published.');
	const blockers = registrationBlockers({
		MORPHIT_INSTANCE_NAME: eff('MORPHIT_INSTANCE_NAME'),
		MORPHIT_INSTANCE_ORIGIN: eff('MORPHIT_INSTANCE_ORIGIN'),
		MORPHIT_INSTANCE_TOR_ADDRESS: eff('MORPHIT_INSTANCE_TOR_ADDRESS')
	});
	if (blockers.length > 0) {
		console.log('  It cannot be re-published yet:');
		for (const b of blockers) console.log(`    • ${b}`);
		console.log('  Set it with  sudo morphit-ops edit  (on this server), then publish with');
		console.log('  sudo morphit-ops register');
		return;
	}
	console.log('');
	await offerRepublish({
		askYesNo,
		register: (flags) => runRegister({ flags, positional: [] }),
		print: (l) => console.log(l),
		restarted: outcome.restarted,
		live: outcome.live
	});
}
