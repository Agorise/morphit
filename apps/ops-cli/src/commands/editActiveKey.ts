/**
 * Morphit ops CLI — `edit-active-key` subcommand.
 *
 * cp167 — dedicated path for rotating the relay's ACTIVE key
 * without re-running the entire setup wizard.  Triggered when:
 *
 *   - An operator pasted the wrong key during initial setup
 *     (e.g. posting key instead of active key — pre-cp167 the
 *     wizard's prompt copy was ambiguous; this is the recovery
 *     path for instances created before that fix landed).
 *   - The active key was rotated on chain (account_update op)
 *     and the relay needs the new WIF.
 *   - Security incident — operator suspects the key may have
 *     been exposed and wants to install a freshly-generated one.
 *
 * Ceremony:
 *   1. Read morphit.env to find MORPHIT_RELAY_ACTIVE_KEY_FILE.
 *   2. Read the current keystore (encrypted envelope OR plaintext
 *      wif) to determine the existing storage mode + filename.
 *   3. Prompt the operator for the relay account name (read from
 *      morphit.env so we can render it into prompts and the
 *      restart hint).  This avoids the operator having to
 *      remember which @account they wired up.
 *   4. Prompt for the new active key (same prompt copy as the
 *      cp167 wizard step 5 — crystal clear that this is the
 *      ACTIVE key for the named relay account, not posting).
 *   5. Optionally re-prompt for a new passphrase if the existing
 *      keystore is an encrypted envelope (default: same passphrase).
 *   6. Atomic write: temp file → fsync → rename, with a
 *      timestamped backup of the prior keystore as
 *      `keystore.<json|wif>.bak-<unix-ms>`.
 *   7. Remind the operator to restart `morphit-relay.service`.
 *
 * What this command does NOT touch:
 *   - morphit.env (path stays, account stays, only the keystore
 *     bytes change).
 *   - morphit.config.env (allowlisted config — no relay-key
 *     state lives there).
 *   - Alt-network keystores (separate file; if the passphrase
 *     changes, the operator must also re-import via
 *     `import-altnet-key`).
 */

import { resolve, join, dirname, basename } from 'node:path';
import {
	existsSync,
	readFileSync,
	writeFileSync,
	chmodSync,
	renameSync,
	openSync,
	fsyncSync,
	closeSync,
	unlinkSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { askPassword, askYesNo, askChoice, step, explain } from '../init/prompt.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { encryptEnvelope, checkPassphraseStrength, type KeyEnvelope } from '../init/encrypt.ts';

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
			`Can't find morphit.env at ${envPath}.  Are you in the right directory?  ` +
				'edit-active-key must be run from the same directory you ran `morphit-ops init` in.'
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
			`morphit.env at ${envPath} doesn't define MORPHIT_RELAY_ACTIVE_KEY_FILE.  ` +
				"The file may be corrupted or pre-init.  Re-run `morphit-ops init` instead."
		);
	}
	if (relayAccount.length === 0) {
		throw new Error(
			`morphit.env at ${envPath} doesn't define MORPHIT_RELAY_ACCOUNT.  ` +
				"The file may be corrupted or pre-init.  Re-run `morphit-ops init` instead."
		);
	}
	return { keystorePath, relayAccount };
}

/** Load the current keystore so we can report what's there + reuse
 *  the same storage mode for the new key by default. */
function loadCurrentKeystore(keystorePath: string, relayAccount: string): CurrentKeystore {
	if (!existsSync(keystorePath)) {
		throw new Error(
			`Keystore file not found at ${keystorePath}.  ` +
				'The path is defined in morphit.env but the file is missing.  ' +
				'Re-run `morphit-ops init` to start fresh, or restore from backup.'
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
				`Keystore at ${keystorePath} looks like JSON but isn't a valid encrypted envelope.`
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
			`Keystore at ${keystorePath} is neither a JSON envelope nor a valid WIF.  ` +
				"Refusing to overwrite — you may want to investigate manually."
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

/** Prompt the operator for the new active key.  Same crystal-
 *  clear prompt copy as the cp167 wizard step 5. */
async function promptNewActiveKey(relayAccount: string): Promise<string> {
	step(1, 3, `New ACTIVE key for @${relayAccount}`);
	explain(
		`You are rotating the ACTIVE key for the @${relayAccount} account.\n` +
			'\n' +
			'Blurt has four key types per account; the relay needs the ACTIVE\n' +
			'key because every operation it broadcasts on chain is an\n' +
			'active-authority operation:\n' +
			'\n' +
			'  • create_claimed_account     (signing up a new Morphit user)\n' +
			'  • transfer                   (sending the welcome bonus)\n' +
			'  • transfer_to_vesting        (powering up donated BLURT)\n' +
			'  • delegate_vesting_shares    (delegating BP for posting)\n' +
			'\n' +
			'The posting key CANNOT sign any of these — the chain will reject\n' +
			'every relay op with "missing required active authority", so your\n' +
			'relay will fail to start (the unlock step checks the public key\n' +
			'against the chain).\n' +
			'\n' +
			'Find the ACTIVE key in your Blurt wallet under "Permissions" or\n' +
			'"Keys" — make sure you copy ACTIVE, not posting or owner.\n' +
			'\n' +
			'Format: 51 characters, starts with 5.'
	);
	let wif: string;
	while (true) {
		wif = await askPassword(
			`Active key for @${relayAccount} (paste the 5J... string; it will not be echoed)`
		);
		if (wif.length === 0) {
			console.log('  ✗ Required.  Try again.\n');
			continue;
		}
		if (!/^5[1-9A-HJ-NP-Za-km-z]{50}$/.test(wif)) {
			console.log(
				`  ✗ Doesn't look like a valid WIF (expected 51 chars starting with 5).  Try again.\n`
			);
			continue;
		}
		break;
	}
	console.log('  ✓ Key shape looks valid.\n');
	return wif;
}

async function askStorageMode(current: CurrentKeystore): Promise<'encrypted' | 'plaintext'> {
	step(2, 3, 'Storage mode for the new key');
	console.log(
		`Your current keystore at ${current.path} is ${current.mode === 'encrypted' ? 'ENCRYPTED' : 'PLAINTEXT'}.\n`
	);
	const choiceIdx = await askChoice(
		'How should the new key be stored?',
		[
			'Encrypted (recommended).  Prompt for an unlock passphrase, encrypt the key, ' +
				'relay prompts for the passphrase at startup.',
			'Plaintext.  Key sits in a file in plain text.  Easier (no passphrase) but ' +
				'if someone reads the file they can spend BLURT as you.'
		],
		current.mode === 'encrypted' ? 0 : 1
	);
	return choiceIdx === 0 ? 'encrypted' : 'plaintext';
}

async function askPassphraseForNew(): Promise<string> {
	console.log(
		"Choose an unlock passphrase.  This is what you'll type when starting\n" +
			'your relay; it never leaves this machine.\n' +
			'\n' +
			'Use a passphrase you can remember but is hard to guess — several\n' +
			'random words or a long sentence work well.  Length ≥8.\n'
	);
	while (true) {
		const p1 = await askPassword('Passphrase');
		const strength = checkPassphraseStrength(p1);
		if (!strength.ok) {
			console.log(`  ✗ ${strength.message}  Try again.\n`);
			continue;
		}
		const p2 = await askPassword('Confirm passphrase');
		if (p1 !== p2) {
			console.log('  ✗ Passphrases do not match.  Try again.\n');
			continue;
		}
		if (strength.message !== undefined) {
			console.log(`  ⚠ ${strength.message}\n`);
		}
		return p1;
	}
}

function atomicWrite(targetPath: string, content: string): void {
	const dir = dirname(targetPath);
	const tmpPath = join(dir, `${basename(targetPath)}.tmp-${Date.now()}`);
	writeFileSync(tmpPath, content, { mode: 0o600 });
	// fsync the file so the content hits disk before the rename.
	const fd = openSync(tmpPath, 'r');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(tmpPath, 0o600);
	renameSync(tmpPath, targetPath);
}

function backupExistingKeystore(currentPath: string): string {
	const bakPath = `${currentPath}.bak-${Date.now()}`;
	const raw = readFileSync(currentPath);
	writeFileSync(bakPath, raw, { mode: 0o600 });
	chmodSync(bakPath, 0o600);
	return bakPath;
}

/** Best-effort secure delete of the prior keystore.  Used when the
 *  operator declares the prior key was wrong/compromised and wants
 *  no trace left.  Approach:
 *    1. Read the prior file size.
 *    2. Overwrite the file in place with cryptographic random
 *       bytes of the same length, then fsync (so the random
 *       payload hits disk).
 *    3. Overwrite a second time with zeros + fsync.
 *    4. unlink.
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
	const size = readFileSync(currentPath).length;
	// Pass 1: random overwrite.
	const rand = randomBytes(Math.max(size, 64));
	writeFileSync(currentPath, rand.subarray(0, Math.max(size, 64)), { mode: 0o600 });
	let fd = openSync(currentPath, 'r');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	// Pass 2: zeros.
	const zeros = Buffer.alloc(Math.max(size, 64));
	writeFileSync(currentPath, zeros, { mode: 0o600 });
	fd = openSync(currentPath, 'r');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	// Unlink.
	unlinkSync(currentPath);
}

export async function runEditActiveKey(args: EditActiveKeyArgs): Promise<number> {
	const configDir =
		typeof args.flags['config-dir'] === 'string' && args.flags['config-dir'].length > 0
			? resolve(args.flags['config-dir'])
			: process.cwd();

	console.log('');
	console.log('  ═══════════════════════════════════════════════════════════════');
	console.log('  Morphit ops — rotate the relay account ACTIVE key');
	console.log('  ═══════════════════════════════════════════════════════════════');
	console.log('');
	console.log(`  Config directory: ${sanitizeForTerm(configDir)}`);
	console.log('');

	// Step 0: read state.
	let critical: { keystorePath: string; relayAccount: string };
	try {
		critical = readCriticalEnv(configDir);
	} catch (err) {
		console.log(`✗ ${errMsg(err)}`);
		return 1;
	}
	console.log(`  Relay account: @${critical.relayAccount}`);
	console.log(`  Keystore path: ${critical.keystorePath}`);

	let current: CurrentKeystore;
	try {
		current = loadCurrentKeystore(critical.keystorePath, critical.relayAccount);
	} catch (err) {
		console.log(`✗ ${errMsg(err)}`);
		return 1;
	}
	console.log(`  Current storage mode: ${current.mode}`);
	console.log('');

	// Determine wipe-prior vs backup-prior policy.  Three paths:
	//   1. --wipe-prior flag set (non-interactive sysadmin use).
	//   2. --keep-backup flag set (force-keep, even for "wrong key").
	//   3. Otherwise, ask interactively.
	let wipePrior: boolean;
	const wipeFlag = args.flags['wipe-prior'] === 'true';
	const keepFlag = args.flags['keep-backup'] === 'true';
	if (wipeFlag && keepFlag) {
		console.log('✗ --wipe-prior and --keep-backup are mutually exclusive.');
		return 1;
	}
	if (wipeFlag) {
		wipePrior = true;
		console.log('  Wipe policy: --wipe-prior flag set; prior keystore will be securely overwritten + unlinked, no .bak.');
	} else if (keepFlag) {
		wipePrior = false;
		console.log('  Wipe policy: --keep-backup flag set; prior keystore will be copied to .bak-<unix-ms>.');
	} else {
		// Interactive — ask whether prior key was compromised/wrong.
		console.log(
			'  Two rotation modes:\n' +
				'\n' +
				'    Safe rotation (default).  Keeps a timestamped backup of the\n' +
				'      prior keystore alongside the new one as\n' +
				`      ${basename(critical.keystorePath)}.bak-<unix-ms>.  Recommended\n` +
				"      for routine key rotation — you can roll back if the new\n" +
				"      key paste was wrong or chain refused it.\n" +
				'\n' +
				'    No-trace rotation.  Overwrites the prior keystore with random\n' +
				"      bytes and unlinks it.  No .bak is created.  Use this if\n" +
				'      the prior key was wrong/compromised and you want zero\n' +
				'      record of it on the server.'
		);
		console.log('');
		wipePrior = await askYesNo(
			'Was the previous key wrong or compromised?  (Yes = no-trace rotation; No = safe rotation with .bak)',
			false
		);
		console.log('');
	}

	// Confirm before overwriting.
	if (wipePrior) {
		console.log(
			'⚠  NO-TRACE rotation: the existing keystore file will be overwritten\n' +
				'   with random bytes (then zeros) and unlinked.  There will be NO\n' +
				'   backup.  If the new key paste is wrong, you must re-paste — you\n' +
				"   cannot roll back to the prior key from this command's output."
		);
	} else {
		console.log(
			'⚠  SAFE rotation: a timestamped backup of the current file will be\n' +
				`   written alongside it as ${basename(critical.keystorePath)}.bak-<unix-ms>.\n` +
				'   You can roll back by renaming that .bak file back to the\n' +
				'   original name.'
		);
	}
	console.log('');
	const proceed = await askYesNo(`Rotate the active key for @${critical.relayAccount}?`, false);
	if (!proceed) {
		console.log('\nAborted.  No files modified.');
		return 0;
	}
	console.log('');

	// Step 1: collect new key.
	const newWif = await promptNewActiveKey(critical.relayAccount);

	// Step 2: storage mode.
	const newMode = await askStorageMode(current);
	console.log('');

	// Step 3: render new file content.
	step(3, 3, 'Write new keystore atomically');
	let newContent: string;
	let newPath: string;
	if (newMode === 'encrypted') {
		const passphrase = await askPassphraseForNew();
		console.log('  Encrypting your new active key (takes ~1 second)...');
		const env = encryptEnvelope(newWif, passphrase);
		newContent = JSON.stringify(env, null, 2);
		console.log('  ✓ Encrypted.');
		// If the prior keystore was plaintext, switch the filename.
		newPath =
			current.mode === 'encrypted'
				? current.path
				: join(dirname(current.path), 'keystore.json');
	} else {
		newContent = newWif;
		// If the prior keystore was encrypted, switch the filename.
		newPath =
			current.mode === 'plaintext'
				? current.path
				: join(dirname(current.path), 'keystore.wif');
	}

	// Handle the prior file according to the wipe/backup policy.
	let bakPath: string | null = null;
	if (wipePrior) {
		try {
			wipePriorKeystore(current.path);
		} catch (err) {
			console.log(`✗ Failed to wipe prior keystore: ${errMsg(err)}`);
			return 1;
		}
		console.log(`  ✓ Prior keystore at ${current.path} overwritten (random + zeros) and unlinked.`);
	} else {
		try {
			bakPath = backupExistingKeystore(current.path);
		} catch (err) {
			console.log(`✗ Failed to back up existing keystore: ${errMsg(err)}`);
			return 1;
		}
		console.log(`  ✓ Existing keystore backed up to ${bakPath}`);
	}

	// Atomic write of the new file.
	try {
		atomicWrite(newPath, newContent);
	} catch (err) {
		console.log(`✗ Failed to write new keystore: ${errMsg(err)}`);
		if (bakPath !== null) {
			console.log(`  Your previous keystore is intact at ${bakPath}.`);
		} else {
			console.log(`  The prior keystore was already wiped.  Re-run edit-active-key`);
			console.log('  with the correct key to install one.');
		}
		return 1;
	}
	console.log(`  ✓ New keystore written to ${newPath} (0600 permissions)`);

	// If the filename changed (encrypted ↔ plaintext), update morphit.env.
	if (newPath !== current.path) {
		const envPath = resolve(configDir, 'morphit.env');
		try {
			const envSrc = readFileSync(envPath, 'utf8');
			const oldQuoted = JSON.stringify(current.path);
			const newQuoted = JSON.stringify(newPath);
			let envSrcNew = envSrc;
			// Try a few likely shapes (with or without surrounding quotes).
			if (envSrc.includes(`MORPHIT_RELAY_ACTIVE_KEY_FILE=${oldQuoted}`)) {
				envSrcNew = envSrc.replace(
					`MORPHIT_RELAY_ACTIVE_KEY_FILE=${oldQuoted}`,
					`MORPHIT_RELAY_ACTIVE_KEY_FILE=${newQuoted}`
				);
			} else if (envSrc.includes(`MORPHIT_RELAY_ACTIVE_KEY_FILE=${current.path}`)) {
				envSrcNew = envSrc.replace(
					`MORPHIT_RELAY_ACTIVE_KEY_FILE=${current.path}`,
					`MORPHIT_RELAY_ACTIVE_KEY_FILE=${newPath}`
				);
			}
			if (envSrcNew !== envSrc) {
				atomicWrite(envPath, envSrcNew);
				console.log(`  ✓ morphit.env updated to point at the new keystore filename.`);
			} else {
				console.log(
					`  ⚠ Couldn't find the old keystore path in morphit.env to rewrite.\n` +
						`     You'll need to edit MORPHIT_RELAY_ACTIVE_KEY_FILE manually to point\n` +
						`     at ${newPath} before restarting the relay.`
				);
			}
		} catch (err) {
			console.log(
				`  ⚠ Could not update morphit.env: ${errMsg(err)}.  ` +
					`Edit it manually to point MORPHIT_RELAY_ACTIVE_KEY_FILE at ${newPath} ` +
					'before restarting the relay.'
			);
		}
	}

	console.log('');
	console.log('  ─────────────────────────────────────────────────────────────');
	console.log('  Next steps:');
	console.log('    1. Restart the relay so it loads the new key:');
	console.log('         sudo systemctl restart morphit-relay.service');
	console.log('    2. The relay will prompt for the unlock passphrase at');
	console.log('       startup (if you chose encrypted mode).  It then');
	console.log('       verifies the new active pubkey matches what the');
	console.log(`       chain says @${critical.relayAccount}'s active authority`);
	console.log('       is, and refuses to start if there is a mismatch — so');
	console.log("       a wrong-key paste won't silently break signup.");
	if (bakPath !== null) {
		console.log('    3. Once the relay is up, the old key in the .bak file');
		console.log(`       (${bakPath})`);
		console.log('       can be securely deleted with `shred -u`.  Until');
		console.log("       you've confirmed the new one works, KEEP the .bak.");
	} else {
		console.log('    3. No backup was created — the prior keystore was');
		console.log('       overwritten and unlinked.  If the relay refuses to');
		console.log('       start (chain pubkey mismatch), run');
		console.log('       `morphit-ops edit-active-key` again with the');
		console.log('       correct key.');
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
