/**
 * Morphit ops CLI — `edit-active-key` subcommand (menu: "Rotate the relay
 * active key").
 *
 * Puts a different ACTIVE key in the relay's key file without re-running the
 * install. For: a posting key pasted at install by mistake, a key changed on
 * the chain (account_update), or a key that may have been exposed.
 *
 * What it does, in order:
 *   0. Runs as root only (the key file, its sealed passphrase and the settings
 *      are root's): without sudo it says so, instead of a raw EACCES.
 *   1. Finds the install (defaultRepoRoot — the menu runs this in
 *      /opt/morphit/apps/ops-cli, so the working directory is NOT the install;
 *      review 2026-10-29: it looked for apps/ops-cli/morphit.env and told the
 *      operator to run it "from the same directory you ran init in") and reads
 *      morphit.env for the relay account and its key file.
 *   2. Asks for the new key and CHECKS IT AGAINST THE CHAIN before anything is
 *      written (lib/relayKeyChain.ts: a "does not match" needs two RPC
 *      operators that agree). A key that is not one of the account's active
 *      keys is refused, saying which key it is and what to paste instead. When
 *      the chain cannot say for sure (it cannot be read, or only one node
 *      answered), it asks before saving unchecked (default: No).
 *   3. Keeps the unlock passphrase by default (opened with the relay's sealed
 *      copy; nothing to type, nothing else changes). A new one is sealed for
 *      the relay, and the alternative-network key files (Tor/I2P/Lokinet, kept
 *      under the same passphrase) are re-encrypted with it and read back. One
 *      that no known passphrase opens is named BEFORE the final question, with
 *      what can be done about it.
 *   4. Keeps a copy of the old key file by default (or overwrites it so no copy
 *      stays), writes the new one in place — at the SAME path, whatever the
 *      old file held (owner and mode kept, so the relay can still read it) —
 *      and reads it back.
 *   5. Says exactly what to run next on this server: restart the relay, which
 *      checks the key against the chain at startup (policy/activeKeyGuard in
 *      the relay) and refuses to sign with one that is not on the account.
 *
 * What it does NOT touch: morphit.config.env, morphit.env, relay.env. The key
 * file keeps its path: an old plaintext key file is converted in place. It
 * used to become <dir>/keystore.json with only morphit.env pointed at it —
 * but the relay's unit sources /etc/morphit/relay.env AFTER morphit.env, so
 * an install whose relay.env names the key file kept the OLD key (and with
 * "no copy", crash-looped on a deleted file) (review, 2026-10-29). The relay
 * tells an encrypted key file from a plaintext one by its content, not its
 * name.
 */

import { keepOwnerAndMode } from '../lib/keepOwner.ts';
import { manualSealCommand, relayCredPath, sealRelayPassphrase } from '../lib/relayCred.ts';
import { resolve, join, dirname, basename } from 'node:path';
import {
	existsSync,
	readFileSync,
	writeFileSync,
	chmodSync,
	renameSync,
	openSync,
	fstatSync,
	fsyncSync,
	closeSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { askPassword, askYesNo, step, explain, isAbortError } from '../init/prompt.ts';
import { commandFailed } from '../lib/commandFailed.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { checkPassphraseStrength, type KeyEnvelope } from '../init/encrypt.ts';
import {
	decryptEnvelopeAsync,
	encryptEnvelopeAsync,
	KeyEnvelopeError
} from '../../../relay/src/crypto/keyEnvelope.ts';
import { startDotsSpinner, withSpinner } from '../init/spinner.ts';
import {
	checkKeyOnChain,
	describeKeyOnChain,
	publicKeyOf,
	type KeyOnChain
} from '../lib/relayKeyChain.ts';
import { trySealedRelayPassphrase } from './register.ts';
import {
	altKeystoreFilename,
	decryptAltKey,
	encryptAltKey,
	type AltKeyEnvelope,
	type AltNetwork
} from '../init/altKeystore.ts';

export interface EditActiveKeyArgs {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

interface CurrentKeystore {
	readonly path: string;
	readonly mode: 'encrypted' | 'plaintext';
	readonly relayAccount: string;
	readonly envelope: KeyEnvelope | undefined;
	readonly plaintextWif: string | undefined;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Read morphit.env and pull out MORPHIT_RELAY_ACTIVE_KEY_FILE + MORPHIT_RELAY_ACCOUNT. */
function readCriticalEnv(configDir: string): {
	keystorePath: string;
	relayAccount: string;
} {
	const envPath = resolve(configDir, 'morphit.env');
	if (!existsSync(envPath)) {
		throw new Error(
			`Can't find morphit.env at ${envPath} — the settings file the install writes, which names ` +
				'the relay account and its key file. Morphit is not installed in that folder. If it is ' +
				'installed in another folder on this server, name it: ' +
				'sudo morphit-ops edit-active-key --config-dir=<that folder>'
		);
	}
	const src = readFileSync(envPath, 'utf8');
	let keystorePath = '';
	let relayAccount = '';
	for (const rawLine of src.split('\n')) {
		const line = rawLine.trim();
		if (line.startsWith('#') || line.length === 0) continue;
		const m = /^([A-Z_]+)=(.*)$/.exec(line);
		if (m === null) continue;
		const key = m[1]!;
		// Strip surrounding quotes if present.
		let value = m[2]!.trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key === 'MORPHIT_RELAY_ACTIVE_KEY_FILE') keystorePath = value;
		if (key === 'MORPHIT_RELAY_ACCOUNT') relayAccount = value;
	}
	if (keystorePath.length === 0) {
		throw new Error(
			`${envPath} has no MORPHIT_RELAY_ACTIVE_KEY_FILE line (where the relay's key file is), ` +
				`which the install writes. Add it on this server: sudo nano ${envPath}  ` +
				'(the line: MORPHIT_RELAY_ACTIVE_KEY_FILE=<path of the key file>)'
		);
	}
	if (relayAccount.length === 0) {
		throw new Error(
			`${envPath} has no MORPHIT_RELAY_ACCOUNT line (the relay account name), which the ` +
				`install writes. Add it on this server: sudo nano ${envPath}  ` +
				'(the line: MORPHIT_RELAY_ACCOUNT=<your relay account>)'
		);
	}
	return { keystorePath, relayAccount };
}

/** Load the current keystore so we can report what's there + reuse
 *  the same storage mode for the new key by default. */
function loadCurrentKeystore(keystorePath: string, relayAccount: string): CurrentKeystore {
	if (!existsSync(keystorePath)) {
		throw new Error(
			`The relay's key file ${keystorePath} (named in morphit.env) is missing. If an earlier ` +
				`key change kept a copy (${keystorePath}.bak-<number>), put it back on this server: ` +
				`sudo cp ${keystorePath}.bak-<number> ${keystorePath} — then run this again.`
		);
	}
	const raw = readFileSync(keystorePath, 'utf8').trim();
	// Encrypted envelope is JSON with `v` + `salt` + `nonce` + `ct` fields.
	if (raw.startsWith('{')) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			throw new Error(
				`Keystore at ${keystorePath} starts with '{' but is not valid JSON: ${errMsg(err)}`
			);
		}
		const env = parsed as {
			v?: unknown;
			kdf?: unknown;
			kdf_params?: unknown;
			cipher?: unknown;
			iv?: unknown;
			ct?: unknown;
		};
		if (
			typeof env.v !== 'number' ||
			typeof env.kdf !== 'string' ||
			typeof env.cipher !== 'string' ||
			typeof env.iv !== 'string' ||
			typeof env.ct !== 'string' ||
			env.kdf_params === null ||
			typeof env.kdf_params !== 'object'
		) {
			throw new Error(
				`The relay's key file ${keystorePath} is not a Morphit key file (it is not an encrypted key). Nothing was changed.`
			);
		}
		return {
			path: keystorePath,
			mode: 'encrypted',
			relayAccount,
			envelope: env as unknown as KeyEnvelope,
			plaintextWif: undefined
		};
	}
	// Plaintext WIF — 51 chars starting with '5'.
	if (!/^5[1-9A-HJ-NP-Za-km-z]{50}$/.test(raw)) {
		throw new Error(
			`The relay's key file ${keystorePath} holds neither an encrypted key nor a private key. ` +
				'It is left as it is, so nothing is lost: look at it on this server before replacing it.'
		);
	}
	return {
		path: keystorePath,
		mode: 'plaintext',
		relayAccount,
		envelope: undefined,
		plaintextWif: raw
	};
}

const WIF_RE = /^5[1-9A-HJ-NP-Za-km-z]{50}$/;

/** Ask for the new active key until one is the account's ACTIVE key on the
 *  chain (or the operator stops). Nothing is written before this returns.
 *  null: stopped — no change made. */
async function promptCheckedActiveKey(
	relayAccount: string,
	check: (account: string, publicKey: string) => Promise<KeyOnChain>
): Promise<string | null> {
	step(1, 3, `New ACTIVE key for @${relayAccount}`);
	explain(
		`The relay signs everything it sends to the Blurt chain — new accounts,\n` +
			'welcome bonuses, power-ups, delegations — with the ACTIVE key of\n' +
			`@${relayAccount}. A posting, owner or memo key cannot do that.\n` +
			'\n' +
			'Find it in your Blurt wallet: open the account → "Keys" or\n' +
			'"Permissions" → the private ACTIVE key (51 characters, starts with 5).\n' +
			'\n' +
			'It is checked against the chain before anything is saved.'
	);
	for (;;) {
		// The input ending (Ctrl+D, no terminal) rejects here and stops the
		// command: it is never read as an empty answer.
		const wif = await askPassword(
			`Active key for @${relayAccount} (paste the 5… key; it is not shown on screen)`
		);
		if (wif.length === 0) {
			console.log('  ✗ Nothing was pasted.  Try again.\n');
			continue;
		}
		if (!WIF_RE.test(wif)) {
			console.log(
				'  ✗ That is not a private key (it should be 51 characters and start with 5).  Try again.\n'
			);
			continue;
		}
		let publicKey: string;
		try {
			publicKey = await publicKeyOf(wif);
		} catch {
			console.log(
				'  ✗ That is not a valid private key (a character is wrong — copy it again).  Try again.\n'
			);
			continue;
		}
		const verdict = await withSpinner(
			`Checking it against @${relayAccount}'s keys on the Blurt chain…`,
			() => check(relayAccount, publicKey)
		);
		for (const line of describeKeyOnChain(verdict, relayAccount, publicKey, 'edit')) {
			console.log(`  ${sanitizeForTerm(line)}`);
		}
		console.log('');
		if (verdict.kind === 'active') return wif;
		if (verdict.kind === 'unknown') {
			const anyway = await askYesNo(
				verdict.unconfirmed !== undefined
					? 'Save this key anyway? (One node says it is not the right key. If that is so, the relay refuses to sign anything until it is fixed.)'
					: 'Save this key WITHOUT the check? (If it is the wrong key, the relay refuses to sign anything until it is fixed.)',
				false
			);
			if (anyway) return wif;
			console.log(
				'\n  No change made.  Run this again on this server once the chain can be reached:'
			);
			console.log('    sudo morphit-ops edit-active-key');
			return null;
		}
		// wrong / weak / owner / no-account: refused — nothing is written.
		console.log('  Nothing has been saved.');
		if (verdict.kind === 'no-account') return null;
		const again = await askYesNo('Paste a different key?', true);
		if (!again) {
			console.log('\n  No change made.');
			return null;
		}
		console.log('');
	}
}

/** Choose a new unlock passphrase (twice). It is never typed again: it is
 *  sealed to this server for the relay. */
async function askPassphraseForNew(): Promise<string> {
	console.log(
		'Choose a new unlock passphrase for the key file.  You will not have to type\n' +
			'it to start the relay: it is sealed to this server, and the relay opens the\n' +
			'key with it by itself.  Keep a copy somewhere safe — it is needed to move\n' +
			'the key to another server.\n' +
			'\n' +
			'Several random words or a long sentence work well.  At least 8 characters.\n'
	);
	while (true) {
		const p1 = await askPassword('New passphrase');
		const strength = checkPassphraseStrength(p1);
		if (!strength.ok) {
			console.log(`  ✗ ${strength.message}  Try again.\n`);
			continue;
		}
		const p2 = await askPassword('The same passphrase again');
		if (p1 !== p2) {
			console.log('  ✗ The two did not match.  Try again.\n');
			continue;
		}
		if (strength.message !== undefined) {
			console.log(`  ⚠ ${strength.message}\n`);
		}
		return p1;
	}
}

/** Open an envelope with a passphrase under the spinner: the key, or null when
 *  the passphrase does not open it. Throws on a damaged file. */
async function openWith(envelope: unknown, passphrase: string): Promise<string | null> {
	const stop = startDotsSpinner('Opening the current key file…');
	try {
		return await decryptEnvelopeAsync(envelope, passphrase);
	} catch (err) {
		if (err instanceof KeyEnvelopeError && err.code === 'decryption_failed') return null;
		throw err;
	} finally {
		stop();
	}
}

/** The current unlock passphrase, when it can be had: the relay's sealed copy,
 *  else typed by the operator (Enter = they don't know it). null: unknown. The
 *  input ENDING (Ctrl+D, no terminal) is not "I don't know it": it stops the
 *  command (askPassword rejects). */
async function currentPassphrase(
	current: CurrentKeystore,
	sealed: () => string | null
): Promise<string | null> {
	if (current.mode !== 'encrypted') return null;
	const s = sealed();
	if (s !== null && (await openWith(current.envelope, s)) !== null) return s;
	console.log(
		"  The relay's sealed passphrase could not be read here (or does not open the key file)."
	);
	for (let attempt = 1; attempt <= 3; attempt++) {
		const typed = await askPassword(
			'Current unlock passphrase (press Enter if you do not know it — you then choose a new one)'
		);
		if (typed === '') return null;
		if ((await openWith(current.envelope, typed)) !== null) return typed;
		console.log(`  ✗ That passphrase does not open the current key file (${attempt} of 3 tries).`);
	}
	return null;
}

/** Where the router on this server keeps the live key of each address, when
 *  Morphit's Ansible roles installed it (roles/tor: HiddenServiceDir
 *  /var/lib/tor/morphit; roles/i2pd: /var/lib/i2pd/morphit-web.dat). Lokinet
 *  has no role, so no known place. Under MORPHIT_ENV_ROOT for tests. */
function liveAltKeyPath(net: AltNetwork): string | null {
	const root = process.env.MORPHIT_ENV_ROOT ?? '';
	const p =
		net === 'tor'
			? `${root}/var/lib/tor/morphit/hs_ed25519_secret_key`
			: net === 'i2p'
				? `${root}/var/lib/i2pd/morphit-web.dat`
				: null;
	return p !== null && existsSync(p) ? p : null;
}

/** What to do about an address key file that cannot be moved to the new
 *  passphrase because no known passphrase opens it. */
function lockedAltKeyAdvice(net: AltNetwork, path: string): string[] {
	const live = liveAltKeyPath(net);
	return [
		`⚠ The ${net} address key (${path}) is locked with the OLD passphrase, and only that`,
		'  passphrase can open it — neither the relay’s sealed passphrase nor one typed here does,',
		'  so it cannot be moved to the new passphrase.',
		...(live !== null
			? [
					`  The router on this server still has the live key. Afterwards, store a new copy of it,`,
					'  locked with the new passphrase (it asks for the new passphrase, and whether to',
					'  replace the existing file — answer yes). On this server:',
					`    sudo morphit-ops import-altnet-key --network=${net} --in=${live}`
				]
			: [
					'  Without the old passphrase that copy cannot be opened. The address itself keeps',
					'  working as long as the router on this server keeps its own key.'
				])
	];
}

/** Each alternative-network key file (Tor / I2P / Lokinet), and which of the
 *  `candidates` passphrases opens it (null: none). Sync key derivation per
 *  try; the spinner is the caller's. */
async function altKeysAndOpeners(
	altDir: string,
	candidates: readonly string[]
): Promise<Array<{ net: AltNetwork; path: string; opener: string | null }>> {
	const out: Array<{ net: AltNetwork; path: string; opener: string | null }> = [];
	for (const net of ['tor', 'i2p', 'lokinet'] as const) {
		const path = join(altDir, altKeystoreFilename(net));
		if (!existsSync(path)) continue;
		let opener: string | null = null;
		for (const pass of candidates) {
			// Let the spinner draw between the (blocking) key derivations.
			await new Promise((r) => setImmediate(r));
			try {
				const plain = decryptAltKey(JSON.parse(readFileSync(path, 'utf8')) as AltKeyEnvelope, pass);
				plain.fill(0);
				opener = pass;
				break;
			} catch {
				/* not this one */
			}
		}
		out.push({ net, path, opener });
	}
	return out;
}

/** Re-encrypt each alternative-network key file with the new passphrase,
 *  using the passphrase that opens it, and read it back. */
function reencryptAltnetKeys(
	keys: ReadonlyArray<{ net: AltNetwork; path: string; opener: string | null }>,
	newPass: string
): Array<{ net: AltNetwork; path: string; ok: boolean; locked: boolean; why?: string }> {
	return keys.map(({ net, path, opener }) => {
		if (opener === null) return { net, path, ok: false, locked: true };
		try {
			const env = JSON.parse(readFileSync(path, 'utf8')) as AltKeyEnvelope;
			const plain = decryptAltKey(env, opener);
			const next = encryptAltKey(plain, newPass, net);
			plain.fill(0);
			atomicWrite(path, JSON.stringify(next, null, 2));
			const back = decryptAltKey(JSON.parse(readFileSync(path, 'utf8')) as AltKeyEnvelope, newPass);
			back.fill(0);
			return { net, path, ok: true, locked: false };
		} catch (err) {
			return { net, path, ok: false, locked: false, why: errMsg(err) };
		}
	});
}

/** Overwrite the bytes of an open file in place: random bytes, then zeros,
 *  each synced to disk. Opened read-write WITHOUT truncating, so the bytes go
 *  over the old ones (a truncating rewrite may be given fresh blocks and leave
 *  the old key in the freed ones). */
function overwriteFd(fd: number): void {
	const size = Math.max(fstatSync(fd).size, 64);
	for (const fill of [randomBytes(size), Buffer.alloc(size)]) {
		writeSync(fd, fill, 0, size, 0);
		fsyncSync(fd);
	}
}

/** Write `targetPath` atomically (temp file → fsync → rename), with the owner,
 *  group and mode of `modelPath` (default: the target itself) — the relay key
 *  file is root:morphit-relay 0640 so the relay, running as its own user, can
 *  read it. A new file with no model stays 0600 root.
 *
 *  `overwriteOld`: the file being replaced is overwritten in place — AFTER the
 *  new one is in place (through a handle opened before the rename, so it is
 *  the old file's own bytes), never before: an overwrite followed by a failed
 *  rename used to leave no key at all while saying "the old key file is
 *  unchanged" (review, 2026-10-29). The temp file never outlives a failure.
 *  Throws when the new file could not be put in place (the old one is then
 *  untouched); an overwrite that fails after that is returned, not thrown. */
function atomicWrite(
	targetPath: string,
	content: string,
	modelPath: string = targetPath,
	opts: { readonly overwriteOld?: boolean } = {}
): { readonly overwriteError: string | null } {
	const dir = dirname(targetPath);
	const tmpPath = join(dir, `${basename(targetPath)}.tmp-${Date.now()}`);
	let oldFd: number | null = null;
	let overwriteError: string | null = null;
	try {
		if (opts.overwriteOld === true) oldFd = openSync(targetPath, 'r+');
		writeFileSync(tmpPath, content, { mode: 0o600 });
		// fsync the file so the content hits disk before the rename.
		const fd = openSync(tmpPath, 'r');
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(tmpPath, 0o600);
		// Keep the model file's owner, group and mode (see above).
		keepOwnerAndMode(modelPath, tmpPath);
		renameSync(tmpPath, targetPath);
		if (oldFd !== null) {
			try {
				overwriteFd(oldFd);
			} catch (err) {
				overwriteError = errMsg(err);
			}
		}
	} finally {
		if (oldFd !== null) closeSync(oldFd);
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch {
			/* reported by the caller's message: the temp file name is printed */
		}
	}
	return { overwriteError };
}

function backupExistingKeystore(currentPath: string): string {
	const bakPath = `${currentPath}.bak-${Date.now()}`;
	const raw = readFileSync(currentPath);
	writeFileSync(bakPath, raw, { mode: 0o600 });
	chmodSync(bakPath, 0o600);
	return bakPath;
}

/** Best-effort secure delete of a key file: overwrite it in place (random
 *  bytes, then zeros, each synced), then remove it.
 *
 *  Caveats — what this CAN'T guarantee:
 *    - On copy-on-write filesystems (btrfs, ZFS, APFS) the
 *      original blocks may persist as snapshots / older
 *      generations.  Same for LVM thin-provisioned volumes
 *      with snapshots.  In those environments, full disk
 *      encryption is the only real defense.
 *    - On SSDs with wear-leveling, blocks holding the prior
 *      ciphertext may still exist physically; the controller
 *      may have remapped them.  Again, FDE is the answer.
 *
 *  What this DOES guarantee on a standard ext4/xfs without
 *  snapshots: the file's directory entry is gone, the inode's
 *  freed, and the blocks no longer contain readable ciphertext
 *  via the same path.  That's the practical bar for "no trace
 *  on disk" without specialist forensic tooling. */
function wipePriorKeystore(currentPath: string): void {
	const fd = openSync(currentPath, 'r+');
	try {
		overwriteFd(fd);
	} finally {
		closeSync(fd);
	}
	unlinkSync(currentPath);
}

/** Test seams (default: the real chain check, the relay's sealed passphrase,
 *  and whether this process runs as root). */
export interface EditActiveKeyDeps {
	readonly checkChain?: (account: string, publicKey: string) => Promise<KeyOnChain>;
	readonly sealed?: () => string | null;
	readonly isRoot?: () => boolean;
}

export async function runEditActiveKey(
	args: EditActiveKeyArgs,
	deps: EditActiveKeyDeps = {}
): Promise<number> {
	try {
		return await editActiveKey(args, deps);
	} catch (err) {
		// Ctrl+C, or the input ending (Ctrl+D, no terminal, piped answers that
		// ran out): one plain "Stopped — …" line and 130. Nothing is written
		// before the last question is answered.
		if (isAbortError(err)) return commandFailed(err);
		throw err;
	}
}

async function editActiveKey(args: EditActiveKeyArgs, deps: EditActiveKeyDeps): Promise<number> {
	// Root only: the key file, the sealed passphrase and the install's settings
	// are root's. Without sudo it used to stop on a raw "EACCES" (review,
	// 2026-10-29). The menu's own root gate covers the menu; this covers anyone
	// calling the command directly.
	const isRoot =
		deps.isRoot ?? (() => typeof process.getuid !== 'function' || process.getuid() === 0);
	if (!isRoot()) {
		console.log('');
		console.log("✗ This changes the relay's key file, which only root can read and write.");
		console.log('  Nothing was changed. Run it with sudo, on this server:');
		console.log('    sudo morphit-ops edit-active-key');
		return 1;
	}

	// The install root — NOT the working directory: the menu runs this in
	// /opt/morphit/apps/ops-cli (review, 2026-10-29).
	const configDir =
		typeof args.flags['config-dir'] === 'string' && args.flags['config-dir'].length > 0
			? resolve(args.flags['config-dir'])
			: defaultRepoRoot();
	const check = deps.checkChain ?? ((a: string, p: string) => checkKeyOnChain(a, p));
	const sealed = deps.sealed ?? trySealedRelayPassphrase;

	console.log('');
	console.log('  ═══════════════════════════════════════════════════════════════');
	console.log("  Morphit ops — replace the relay's ACTIVE key");
	console.log('  ═══════════════════════════════════════════════════════════════');
	console.log('');

	// Step 0: read state.
	let critical: { keystorePath: string; relayAccount: string };
	try {
		critical = readCriticalEnv(configDir);
	} catch (err) {
		console.log(`✗ ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	}
	console.log(`  Relay account:  @${sanitizeForTerm(critical.relayAccount)}`);
	console.log(`  Its key file:   ${sanitizeForTerm(critical.keystorePath)}`);
	console.log('');

	let current: CurrentKeystore;
	try {
		current = loadCurrentKeystore(critical.keystorePath, critical.relayAccount);
	} catch (err) {
		console.log(`✗ ${sanitizeForTerm(errMsg(err))}`);
		return 1;
	}

	const wipeFlag = args.flags['wipe-prior'] === 'true';
	const keepFlag = args.flags['keep-backup'] === 'true';
	if (wipeFlag && keepFlag) {
		console.log('✗ --wipe-prior and --keep-backup cannot be used together.');
		return 1;
	}

	// Step 1: the new key, checked against the chain before anything is written.
	const newWif = await promptCheckedActiveKey(critical.relayAccount, check);
	if (newWif === null) return 1;

	// Step 2: the unlock passphrase — kept by default.
	step(2, 3, 'Unlock passphrase');
	const oldPass = await currentPassphrase(current, sealed);
	// Typed rather than opened with the sealed copy: the sealed copy is missing
	// or stale, so it is sealed again below even when the passphrase is kept —
	// or the relay could not open the new key file.
	const sealedNow = sealed();
	const sealedIsCurrent = oldPass !== null && sealedNow === oldPass;
	let newPass: string;
	let passChanged: boolean;
	if (oldPass !== null) {
		const keep = await askYesNo(
			'Keep the same unlock passphrase? (Recommended: nothing else has to change)',
			true
		);
		if (keep) {
			newPass = oldPass;
			passChanged = false;
		} else {
			newPass = await askPassphraseForNew();
			passChanged = true;
		}
	} else {
		if (current.mode === 'plaintext') {
			console.log(
				`  The current key file is not encrypted.  The new key is stored encrypted,\n` +
					'  so choose a passphrase for it.\n'
			);
		}
		newPass = await askPassphraseForNew();
		passChanged = true;
	}
	console.log('');

	// The Tor / I2P / Lokinet address key files share the passphrase. With a new
	// one, find out NOW which can be moved to it — with the passphrase in use
	// (when known) or the relay's sealed one (it may still open them even when
	// it does not open the relay key) — and say which cannot, before the last
	// question rather than after the change.
	let altKeys: Array<{ net: AltNetwork; path: string; opener: string | null }> = [];
	if (passChanged) {
		const candidates = [...new Set([oldPass, sealedNow].filter((p): p is string => p !== null))];
		const altDir = join(configDir, 'apps', 'relay', 'altnet');
		const any = (['tor', 'i2p', 'lokinet'] as const).some((n) =>
			existsSync(join(altDir, altKeystoreFilename(n)))
		);
		if (any)
			altKeys = await withSpinner('Checking the Tor / I2P / Lokinet address key files…', () =>
				altKeysAndOpeners(altDir, candidates)
			);
		for (const a of altKeys.filter((k) => k.opener === null)) {
			for (const line of lockedAltKeyAdvice(a.net, a.path)) console.log(`  ${line}`);
			console.log('');
		}
	}

	// Step 3: the old key file — a copy is kept by default.
	step(3, 3, 'Save the new key');
	let wipePrior: boolean;
	if (wipeFlag) wipePrior = true;
	else if (keepFlag) wipePrior = false;
	else {
		wipePrior = !(await askYesNo(
			'Keep a copy of the old key file on this server, so you can go back if something is wrong? (No = overwrite it so no copy of the old key stays here — choose No if the old key was exposed)',
			true
		));
	}
	const proceed = await askYesNo(
		`Replace the relay's active key for @${critical.relayAccount} now?`,
		false
	);
	if (!proceed) {
		console.log('\n  Stopped.  No files were changed.');
		return 0;
	}
	console.log('');

	const envelope = await withSpinner('Encrypting the new key…', () =>
		encryptEnvelopeAsync(newWif, newPass)
	);
	const newContent = JSON.stringify(envelope, null, 2);

	// The old file: copy kept, or overwritten.
	let bakPath: string | null = null;
	if (!wipePrior) {
		try {
			bakPath = backupExistingKeystore(current.path);
		} catch (err) {
			console.log(`✗ Could not keep a copy of the old key file: ${sanitizeForTerm(errMsg(err))}`);
			console.log('  Nothing was changed.');
			return 1;
		}
		console.log(`  ✓ A copy of the old key file is kept at ${bakPath}`);
	}

	// Write the new one IN PLACE — the same path, so every file that names it
	// (morphit.env, relay.env) still does — keeping the old file's owner and
	// mode (the relay runs as its own user), then read it back.
	let written: { readonly overwriteError: string | null };
	try {
		written = atomicWrite(current.path, newContent, current.path, { overwriteOld: wipePrior });
	} catch (err) {
		// The new file is put in place by one rename, and the old one is only
		// overwritten after it: when this fails, the old file is as it was.
		console.log(`✗ Could not write the new key file: ${sanitizeForTerm(errMsg(err))}`);
		console.log(
			bakPath !== null
				? `  The old key file is unchanged (and copied to ${bakPath}). Nothing else was changed.`
				: '  The old key file is unchanged. Nothing else was changed.'
		);
		console.log('  Once the cause is fixed, run this again on this server:');
		console.log('    sudo morphit-ops edit-active-key');
		return 1;
	}
	try {
		const back = await openWith(JSON.parse(readFileSync(current.path, 'utf8')), newPass);
		if (back !== newWif) throw new Error('it did not read back as the key that was pasted');
	} catch (err) {
		console.log(`✗ The new key file did not read back correctly: ${sanitizeForTerm(errMsg(err))}`);
		console.log(
			bakPath !== null
				? `  Put the old one back on this server:  sudo cp ${bakPath} ${current.path}`
				: `  No copy of the old key was kept. Run this again on this server:  sudo morphit-ops edit-active-key`
		);
		return 1;
	}
	console.log(
		current.mode === 'plaintext'
			? `  ✓ New key saved in ${current.path} — encrypted now (the file keeps its name) — and read back.`
			: `  ✓ New key saved in ${current.path} (encrypted) and read back.`
	);

	if (wipePrior) {
		if (written.overwriteError === null)
			console.log(
				'  ✓ The old key was overwritten (random bytes, then zeros) once the new one was in place.'
			);
		else
			console.log(
				`  ⚠ The old key's bytes could not be overwritten (${sanitizeForTerm(written.overwriteError)}).\n` +
					'    The old file is already replaced, so its bytes may remain in unused space on the disk;\n' +
					'    only full-disk encryption protects against that.'
			);
	}

	// The relay opens the key file with its host-sealed passphrase: seal a new
	// one, or the relay cannot start.
	let sealedOk = true;
	if (passChanged || !sealedIsCurrent) {
		const r = sealRelayPassphrase(newPass);
		sealedOk = r.ok && sealed() === newPass;
		if (sealedOk)
			console.log(`  ✓ The unlock passphrase is sealed for the relay (${relayCredPath()}).`);
		else {
			console.log(
				`  ✗ Could not seal the unlock passphrase for the relay (${r.ok ? 'it did not read back' : r.reason}).`
			);
			console.log('    The relay cannot open the new key until it is sealed.  On this server run:');
			console.log(`      ${manualSealCommand()}`);
		}
	}
	if (passChanged) {
		for (const a of reencryptAltnetKeys(altKeys, newPass)) {
			if (a.ok)
				console.log(`  ✓ The ${a.net} address key (${a.path}) now opens with the new passphrase.`);
			else if (a.locked) {
				for (const line of lockedAltKeyAdvice(a.net, a.path)) console.log(`  ${line}`);
			} else {
				const live = liveAltKeyPath(a.net);
				console.log(
					`  ⚠ The ${a.net} address key (${a.path}) could not be moved to the new passphrase (${sanitizeForTerm(a.why ?? '')});\n` +
						'    it is still locked with the passphrase that was in use before.' +
						(live !== null
							? '\n    Store a new copy of the live key, locked with the new passphrase (it asks for the new\n' +
								'    passphrase, and whether to replace the existing file — answer yes). On this server:\n' +
								`      sudo morphit-ops import-altnet-key --network=${a.net} --in=${live}`
							: '')
				);
			}
		}
	}

	console.log('');
	console.log('  ─────────────────────────────────────────────────────────────');
	console.log('  Next, on this server:');
	if (!sealedOk) {
		console.log('    0. Seal the passphrase first (the command above), or the relay cannot start.');
	}
	console.log('    1. Restart the relay so it uses the new key:');
	console.log('         sudo systemctl restart morphit-relay');
	console.log('    2. When it starts, the relay checks its key against the chain.  To see the');
	console.log('       result (the line "Relay key:"):');
	console.log('         sudo morphit-ops status');
	console.log('       or its log ("active_key_matches_chain" means all is well):');
	console.log(
		'         sudo journalctl -u morphit-relay --since "-15min" --no-pager | grep active_key'
	);
	console.log('       If the key does not match, the relay keeps running but signs nothing');
	console.log('       (signups are refused, payments wait) until it is fixed.');
	if (bakPath !== null) {
		console.log(
			current.mode === 'plaintext'
				? '    3. Once the relay works with the new key, delete the copy of the old key\n' +
						'       (it holds the old key UNENCRYPTED):'
				: '    3. Once the relay works with the new key, delete the copy of the old key:'
		);
		console.log(`         sudo shred -u ${bakPath}`);
	}
	console.log('  ─────────────────────────────────────────────────────────────');
	console.log('');
	return 0;
}

// ─── Test exports ────────────────────────────────────────────────
// Pure file/parse helpers exposed for smoke coverage.  Not part
// of the public command surface — prefixed `_test` so the only
// import site is the smoke runner.

export const _testReadCriticalEnv = readCriticalEnv;
export const _testLoadCurrentKeystore = loadCurrentKeystore;
export const _testAtomicWrite = atomicWrite;
export const _testBackupExistingKeystore = backupExistingKeystore;
export const _testWipePriorKeystore = wipePriorKeystore;
