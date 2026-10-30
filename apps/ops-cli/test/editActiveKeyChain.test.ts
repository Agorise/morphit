/**
 * Menu 10, "Rotate the relay active key" (`edit-active-key`).
 *
 *  - It finds the install from where the installed launcher runs it
 *    (cwd = <install>/apps/ops-cli): it used to look for
 *    apps/ops-cli/morphit.env and tell the operator to run it "from the same
 *    directory you ran init in" (H1).
 *  - It checks the pasted key against the chain BEFORE writing anything and
 *    refuses one that is not the account's ACTIVE key, saying which key it is
 *    (H2). It used to write whatever was pasted and claim the relay would
 *    check it at startup.
 *  - By default the unlock passphrase is kept (opened with the relay's sealed
 *    copy — nothing to type) and a copy of the old key file is kept; the "next
 *    steps" name the exact restart command and the exact shred command (M12).
 *  - A new passphrase re-encrypts the alternative-network key files that share
 *    it, and reads them back (M12).
 *
 * The real command runs with its prompts answered; `systemd-creds` is a
 * stand-in on PATH that "seals" by prefixing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import type { KeyOnChain } from '../src/lib/relayKeyChain.ts';

const secrets: string[] = [];
const answers: Array<[RegExp, boolean]> = [];
const asked: string[] = [];
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	askPassword: async (q: string) => {
		asked.push(q);
		return secrets.shift() ?? '';
	},
	askYesNo: async (q: string, def: boolean) => {
		asked.push(q);
		const hit = answers.find(([re]) => re.test(q));
		return hit ? hit[1] : def;
	},
	step: () => {},
	explain: () => {}
}));

const pub = (wif: string): string => PrivateKey.fromString(wif).createPublic('BLT').toString();
const OLD_WIF = PrivateKey.fromSeed('relay-old-active').toString();
const NEW_WIF = PrivateKey.fromSeed('relay-new-active').toString();
const POSTING_WIF = PrivateKey.fromSeed('relay-posting').toString();
const OLD_PASS = 'the current passphrase, long enough';

/** The chain as a fixture: @relayacct's active key is NEW_WIF's. */
async function chain(account: string, publicKey: string): Promise<KeyOnChain> {
	const { judgeKeyOnChain } = await import('../src/lib/relayKeyChain.ts');
	return judgeKeyOnChain(
		publicKey,
		[
			{
				name: 'relayacct',
				owner: { weight_threshold: 1, account_auths: [], key_auths: [['BLT-owner', 1]] },
				active: { weight_threshold: 1, account_auths: [], key_auths: [[pub(NEW_WIF), 1]] },
				posting: { weight_threshold: 1, account_auths: [], key_auths: [[pub(POSTING_WIF), 1]] },
				memo_key: 'BLT-memo'
			}
		],
		account
	);
}

const S = mkdtempSync(join(tmpdir(), 'eak-'));
const ROOT = join(S, 'opt', 'morphit');
const CRED = join(S, 'relay_passphrase.cred');
const KS = join(ROOT, 'keystore.json');
const oldPath = process.env.PATH;
const oldCwd = process.cwd();
let out = '';

beforeAll(() => {
	mkdirSync(join(S, 'bin'));
	writeFileSync(
		join(S, 'bin', 'systemd-creds'),
		[
			'#!/bin/sh',
			'for last; do :; done',
			'case "$1" in',
			'  encrypt) { printf "SEALED:"; cat; } > "$last" ;;',
			'  decrypt) for a; do [ "$a" = "-" ] && break; prev="$a"; done; sed "s/^SEALED://" "$prev" ;;',
			'esac'
		].join('\n') + '\n',
		{ mode: 0o755 }
	);
	process.env.PATH = `${join(S, 'bin')}:${oldPath}`;
	process.env.MORPHIT_RELAY_CRED_FILE = CRED;
});
afterAll(() => {
	process.env.PATH = oldPath;
	delete process.env.MORPHIT_RELAY_CRED_FILE;
	process.chdir(oldCwd);
	rmSync(S, { recursive: true, force: true });
});

beforeEach(async () => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(join(ROOT, 'apps', 'ops-cli'), { recursive: true });
	mkdirSync(join(ROOT, 'apps', 'relay', 'altnet'), { recursive: true });
	writeFileSync(
		join(ROOT, 'package.json'),
		JSON.stringify({ name: 'morphit', workspaces: ['apps/*'] })
	);
	writeFileSync(join(ROOT, 'apps', 'ops-cli', 'package.json'), JSON.stringify({ name: 'ops-cli' }));
	const { encryptEnvelope } = await import('../src/init/encrypt.ts');
	writeFileSync(KS, JSON.stringify(encryptEnvelope(OLD_WIF, OLD_PASS)));
	writeFileSync(
		join(ROOT, 'morphit.env'),
		`MORPHIT_RELAY_ACTIVE_KEY_FILE=${KS}\nMORPHIT_RELAY_ACCOUNT=relayacct\n`
	);
	writeFileSync(CRED, `SEALED:${OLD_PASS}`);
	secrets.length = 0;
	answers.length = 0;
	asked.length = 0;
	out = '';
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out += a.join(' ') + '\n';
	});
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	// Where the installed launcher runs it: npm exec --workspace apps/ops-cli.
	process.chdir(join(ROOT, 'apps', 'ops-cli'));
});
afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(oldCwd);
});

async function run(flags: Record<string, string> = {}): Promise<number> {
	const { runEditActiveKey } = await import('../src/commands/editActiveKey.ts');
	return runEditActiveKey({ flags, positional: [], colorEnabled: false }, { checkChain: chain });
}

async function keystoreWif(pass: string): Promise<string> {
	const { decryptEnvelope } = await import('../../relay/src/crypto/keyEnvelope.ts');
	return decryptEnvelope(JSON.parse(readFileSync(KS, 'utf8')), pass);
}

describe('edit-active-key from the menu (cwd = <install>/apps/ops-cli)', () => {
	it('finds the install, keeps the passphrase and a copy, and says exactly what to run next', async () => {
		secrets.push(NEW_WIF);
		answers.push([/^Replace the relay/, true]);
		const rc = await run();
		expect(out).not.toMatch(/Can't find morphit\.env/);
		expect(rc).toBe(0);
		expect(out).toMatch(/Relay account:\s+@relayacct/);
		expect(out).toMatch(/✓ Matches: this is @relayacct's ACTIVE key/);
		// Kept passphrase: opened with the sealed copy — nothing typed but the key.
		expect(asked.filter((q) => /passphrase/i.test(q) && !/^Keep the same/.test(q))).toEqual([]);
		expect(await keystoreWif(OLD_PASS)).toBe(NEW_WIF);
		const bak = readdirSync(ROOT).find((f) => f.startsWith('keystore.json.bak-'));
		expect(bak).toBeDefined();
		expect(out).toContain('sudo systemctl restart morphit-relay');
		expect(out).toContain(`sudo shred -u ${join(ROOT, bak!)}`);
		expect(out).not.toMatch(
			/what you'll type when starting|WIF|unix-ms|No-trace|unlinks|keystore /
		);
	});

	it('the posting key is refused before anything is written, naming it and what to paste', async () => {
		const before = readFileSync(KS, 'utf8');
		secrets.push(POSTING_WIF);
		answers.push([/^Paste a different key/, false], [/^Replace the relay/, true]);
		const rc = await run();
		expect(rc).toBe(1);
		expect(out).toMatch(/✗ Does not match/);
		expect(out).toMatch(/It is @relayacct's POSTING key\. The relay needs the ACTIVE key\./);
		expect(out).toMatch(/private ACTIVE key/);
		expect(readFileSync(KS, 'utf8')).toBe(before);
		expect(readdirSync(ROOT).some((f) => f.includes('.bak-'))).toBe(false);
		expect(asked.some((q) => /^Replace the relay/.test(q))).toBe(false);
	});

	it('a chain that cannot be read: asks before saving unchecked, and No (the default) changes nothing', async () => {
		const before = readFileSync(KS, 'utf8');
		secrets.push(NEW_WIF);
		const { runEditActiveKey } = await import('../src/commands/editActiveKey.ts');
		const rc = await runEditActiveKey(
			{ flags: {}, positional: [], colorEnabled: false },
			{ checkChain: async () => ({ kind: 'unknown', why: 'the chain could not be read (test)' }) }
		);
		expect(rc).toBe(1);
		expect(asked.some((q) => /WITHOUT the check/.test(q))).toBe(true);
		expect(readFileSync(KS, 'utf8')).toBe(before);
	});

	it('a new passphrase is sealed and the Tor key file that shares it is moved to it', async () => {
		const { encryptAltKey, decryptAltKey } = await import('../src/init/altKeystore.ts');
		const torPlain = Buffer.from('tor-secret-key-bytes');
		const torPath = join(ROOT, 'apps', 'relay', 'altnet', 'tor-key.json');
		writeFileSync(torPath, JSON.stringify(encryptAltKey(torPlain, OLD_PASS, 'tor')));
		const NEW_PASS = 'a brand new passphrase for the key';
		secrets.push(NEW_WIF, NEW_PASS, NEW_PASS);
		answers.push([/^Keep the same unlock passphrase/, false], [/^Replace the relay/, true]);
		const rc = await run();
		expect(rc).toBe(0);
		expect(await keystoreWif(NEW_PASS)).toBe(NEW_WIF);
		expect(readFileSync(CRED, 'utf8')).toBe(`SEALED:${NEW_PASS}`);
		expect(decryptAltKey(JSON.parse(readFileSync(torPath, 'utf8')), NEW_PASS).toString()).toBe(
			'tor-secret-key-bytes'
		);
		expect(out).toMatch(/tor address key .* now opens with the new passphrase/);
	});

	it('"no copy" overwrites the old key: no .bak, and no restore line', async () => {
		secrets.push(NEW_WIF);
		answers.push([/^Keep a copy of the old key file/, false], [/^Replace the relay/, true]);
		const rc = await run();
		expect(rc).toBe(0);
		expect(readdirSync(ROOT).some((f) => f.includes('.bak-'))).toBe(false);
		expect(await keystoreWif(OLD_PASS)).toBe(NEW_WIF);
		expect(out).not.toContain('shred');
	});
});

describe('docs/RECOVERING-FROM-WRONG-RELAY-KEY.md walks through the questions the command really asks', () => {
	it('every bold question in its procedure is asked, and no storage-mode step or "0600" is described', async () => {
		const doc = readFileSync(
			join(import.meta.dirname, '..', '..', '..', 'docs', 'RECOVERING-FROM-WRONG-RELAY-KEY.md'),
			'utf8'
		);
		const procedure = doc.slice(doc.indexOf('## The procedure'), doc.indexOf('## After'));
		const bold = [...procedure.matchAll(/\*\*([^*]+\?)\*\*/g)].map((m) =>
			m[1]!.replace(/\s+/g, ' ').replace('@<account>', '@relayacct')
		);
		expect(bold.length).toBeGreaterThanOrEqual(3);
		secrets.push(NEW_WIF);
		answers.push([/^Replace the relay/, true]);
		expect(await run()).toBe(0);
		for (const q of bold)
			expect(
				asked.some((a) => a.startsWith(q)),
				q
			).toBe(true);
		expect(doc).not.toMatch(/storage mode|0600/i);
	});
});

describe('edit-active-key with no install where it looks', () => {
	it('names the file it looked for and how to point at another folder — not "the directory you ran init in"', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'eak-empty-'));
		const { runEditActiveKey } = await import('../src/commands/editActiveKey.ts');
		const rc = await runEditActiveKey(
			{ flags: { 'config-dir': empty }, positional: [], colorEnabled: false },
			{ checkChain: chain }
		);
		expect(rc).toBe(1);
		expect(out).toContain(join(empty, 'morphit.env'));
		expect(out).toContain('sudo morphit-ops edit-active-key --config-dir=');
		expect(out).not.toMatch(/same directory you ran/);
		expect(existsSync(join(empty, 'morphit.env'))).toBe(false);
		rmSync(empty, { recursive: true, force: true });
	});
});
