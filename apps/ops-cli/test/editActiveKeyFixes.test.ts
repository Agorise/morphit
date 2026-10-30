/**
 * `edit-active-key` — what a deep review of v1.21.18 found (2026-10-29), each
 * run through the real command with its prompts answered:
 *
 *  - a PLAINTEXT key file is converted IN PLACE: it used to be written to
 *    <dir>/keystore.json with only morphit.env pointed at it, while the relay's
 *    unit sources relay.env after morphit.env — the relay kept the old key (and
 *    with "no copy", crash-looped on a deleted file);
 *  - "no copy" really overwrites the old key's bytes (a hard link to the old
 *    file sees them gone) — for an encrypted and for a plaintext key file;
 *  - with the old passphrase unknown, the Tor/I2P/Lokinet address keys are
 *    tried with the relay's sealed passphrase too, and one no known passphrase
 *    opens is named BEFORE the last question, with advice that does not need
 *    the passphrase that was just said to be unknown;
 *  - the input ending (Ctrl+D, no terminal) stops cleanly — "Stopped — the
 *    input ended", 130 — at every question; it is never "I don't know it";
 *  - the owner key is answered with advice for this context ("paste the ACTIVE
 *    key instead"), not "run edit-active-key";
 *  - one node's "this is not the key" is not trusted: the operator may still
 *    save it (default No), and is told what that node said;
 *  - without root it says to use sudo, instead of a raw EACCES;
 *  - the next steps' journal command looks at a time window, not the last 50
 *    lines (which the relay's own logging can push it out of), and names
 *    `morphit-ops status`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	existsSync,
	linkSync,
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

/** Typed answers in order. An Error is thrown at that question (the input
 *  ending); none left is the input ending too. */
const secrets: Array<string | Error> = [];
const answers: Array<[RegExp, boolean]> = [];
const asked: string[] = [];
/** How much had been printed when each question was asked. */
const printedAtQuestion: Array<[string, number]> = [];
vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as { inputEndedError: (d?: string) => Error };
	return {
		...real,
		askPassword: async (q: string) => {
			asked.push(q);
			printedAtQuestion.push([q, out.length]);
			const next = secrets.shift();
			if (next === undefined) throw real.inputEndedError();
			if (next instanceof Error) throw next;
			return next;
		},
		askYesNo: async (q: string, def: boolean) => {
			asked.push(q);
			printedAtQuestion.push([q, out.length]);
			const hit = answers.find(([re]) => re.test(q));
			return hit ? hit[1] : def;
		},
		step: () => {},
		explain: () => {}
	};
});

const pub = (wif: string): string => PrivateKey.fromString(wif).createPublic('BLT').toString();
const OLD_WIF = PrivateKey.fromSeed('relay-old-active').toString();
const NEW_WIF = PrivateKey.fromSeed('relay-new-active').toString();
const OWNER_WIF = PrivateKey.fromSeed('relay-owner').toString();
const POSTING_WIF = PrivateKey.fromSeed('relay-posting').toString();
const OLD_PASS = 'the current passphrase, long enough';
const NEW_PASS = 'a brand new passphrase for the key';

async function chain(account: string, publicKey: string): Promise<KeyOnChain> {
	const { judgeKeyOnChain } = await import('../src/lib/relayKeyChain.ts');
	return judgeKeyOnChain(
		publicKey,
		[
			{
				name: 'relayacct',
				owner: { weight_threshold: 1, account_auths: [], key_auths: [[pub(OWNER_WIF), 1]] },
				active: { weight_threshold: 1, account_auths: [], key_auths: [[pub(NEW_WIF), 1]] },
				posting: { weight_threshold: 1, account_auths: [], key_auths: [[pub(POSTING_WIF), 1]] },
				memo_key: 'BLT-memo'
			}
		],
		account
	);
}

const S = mkdtempSync(join(tmpdir(), 'eakfix-'));
const ROOT = join(S, 'opt', 'morphit');
const CRED = join(S, 'relay_passphrase.cred');
const KS = join(ROOT, 'keystore.json');
const ALT = join(ROOT, 'apps', 'relay', 'altnet');
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
	rmSync(join(S, 'live'), { recursive: true, force: true });
	mkdirSync(join(ROOT, 'apps', 'ops-cli'), { recursive: true });
	mkdirSync(ALT, { recursive: true });
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
	vi.stubEnv('MORPHIT_ENV_ROOT', join(S, 'live'));
	secrets.length = 0;
	answers.length = 0;
	asked.length = 0;
	printedAtQuestion.length = 0;
	out = '';
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out += a.join(' ') + '\n';
	});
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	process.chdir(join(ROOT, 'apps', 'ops-cli'));
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	process.chdir(oldCwd);
});

async function run(
	flags: Record<string, string> = {},
	deps: Record<string, unknown> = {}
): Promise<number> {
	const { runEditActiveKey } = await import('../src/commands/editActiveKey.ts');
	return runEditActiveKey(
		{ flags, positional: [], colorEnabled: false },
		{ checkChain: chain, ...deps }
	);
}

async function wifIn(path: string, pass: string): Promise<string> {
	const { decryptEnvelope } = await import('../../relay/src/crypto/keyEnvelope.ts');
	return decryptEnvelope(JSON.parse(readFileSync(path, 'utf8')), pass);
}

describe('a plaintext key file', () => {
	it('is converted in place: the same path holds the new key, encrypted; no other file to point at', async () => {
		const PT = join(ROOT, 'relay.keystore');
		writeFileSync(PT, OLD_WIF + '\n');
		const envBefore = `MORPHIT_RELAY_ACTIVE_KEY_FILE=${PT}\nMORPHIT_RELAY_ACCOUNT=relayacct\n`;
		writeFileSync(join(ROOT, 'morphit.env'), envBefore);
		rmSync(KS);
		rmSync(CRED, { force: true });
		secrets.push(NEW_WIF, NEW_PASS, NEW_PASS);
		answers.push([/^Replace the relay/, true]);
		const rc = await run();
		expect(rc).toBe(0);
		// The path every env file names (morphit.env AND relay.env) now opens to
		// the new key — so the relay, whichever file it reads last, gets it.
		expect(await wifIn(PT, NEW_PASS)).toBe(NEW_WIF);
		expect(existsSync(KS)).toBe(false);
		expect(readFileSync(join(ROOT, 'morphit.env'), 'utf8')).toBe(envBefore);
		// The kept copy holds the old key unencrypted, and is named for deletion.
		const bak = readdirSync(ROOT).find((f) => f.startsWith('relay.keystore.bak-'))!;
		expect(out).toContain(`sudo shred -u ${join(ROOT, bak)}`);
		expect(out).toMatch(/UNENCRYPTED/);
	});

	it('"no copy": the old plaintext bytes are overwritten (a hard link to the old file sees zeros)', async () => {
		const PT = join(ROOT, 'relay.keystore');
		writeFileSync(PT, OLD_WIF + '\n');
		writeFileSync(
			join(ROOT, 'morphit.env'),
			`MORPHIT_RELAY_ACTIVE_KEY_FILE=${PT}\nMORPHIT_RELAY_ACCOUNT=relayacct\n`
		);
		rmSync(CRED, { force: true });
		const probe = join(S, 'probe-plain');
		rmSync(probe, { force: true });
		linkSync(PT, probe);
		secrets.push(NEW_WIF, NEW_PASS, NEW_PASS);
		answers.push([/^Keep a copy of the old key file/, false], [/^Replace the relay/, true]);
		expect(await run()).toBe(0);
		const old = readFileSync(probe);
		expect(old.length).toBeGreaterThan(0);
		expect(old.every((b) => b === 0)).toBe(true);
		expect(await wifIn(PT, NEW_PASS)).toBe(NEW_WIF);
		expect(readdirSync(ROOT).some((f) => f.includes('.bak-') || f.includes('.tmp-'))).toBe(false);
	});
});

describe('"no copy" with an encrypted key file', () => {
	it('the old bytes are overwritten, not just unlinked (hard-link probe)', async () => {
		const probe = join(S, 'probe-enc');
		rmSync(probe, { force: true });
		linkSync(KS, probe);
		const before = readFileSync(probe);
		secrets.push(NEW_WIF);
		answers.push([/^Keep a copy of the old key file/, false], [/^Replace the relay/, true]);
		expect(await run()).toBe(0);
		const after = readFileSync(probe);
		expect(after.length).toBeGreaterThanOrEqual(before.length);
		expect(after.every((b) => b === 0)).toBe(true);
		expect(await wifIn(KS, OLD_PASS)).toBe(NEW_WIF);
	});
});

describe('the address keys when the old passphrase is not known', () => {
	it("the relay's sealed passphrase is tried on them too: the Tor key is moved to the new passphrase", async () => {
		const { encryptEnvelope } = await import('../src/init/encrypt.ts');
		const { encryptAltKey, decryptAltKey } = await import('../src/init/altKeystore.ts');
		// The relay key is under a passphrase nobody here knows; the Tor key is
		// under the one that is sealed.
		writeFileSync(KS, JSON.stringify(encryptEnvelope(OLD_WIF, 'some passphrase nobody remembers')));
		const torPath = join(ALT, 'tor-key.json');
		writeFileSync(
			torPath,
			JSON.stringify(encryptAltKey(Buffer.from('tor-secret'), OLD_PASS, 'tor'))
		);
		secrets.push(NEW_WIF, '', NEW_PASS, NEW_PASS); // Enter at "current passphrase": not known
		answers.push([/^Replace the relay/, true]);
		expect(await run()).toBe(0);
		expect(decryptAltKey(JSON.parse(readFileSync(torPath, 'utf8')), NEW_PASS).toString()).toBe(
			'tor-secret'
		);
		expect(out).toMatch(/tor address key .* now opens with the new passphrase/);
	});

	it('one nothing opens is named BEFORE the last question, with advice that does not need the old passphrase', async () => {
		const { encryptAltKey } = await import('../src/init/altKeystore.ts');
		rmSync(CRED, { force: true });
		const torPath = join(ALT, 'tor-key.json');
		writeFileSync(
			torPath,
			JSON.stringify(encryptAltKey(Buffer.from('x'.repeat(96)), OLD_PASS, 'tor'))
		);
		// The router on this server still holds the live key.
		const live = join(S, 'live', 'var', 'lib', 'tor', 'morphit');
		mkdirSync(live, { recursive: true });
		writeFileSync(join(live, 'hs_ed25519_secret_key'), 'x'.repeat(96));
		secrets.push(NEW_WIF, '', NEW_PASS, NEW_PASS);
		answers.push([/^Replace the relay/, true]);
		expect(await run()).toBe(0);
		const at = printedAtQuestion.find(([q]) => /^Replace the relay/.test(q))![1];
		const before = out.slice(0, at);
		expect(before).toMatch(/tor address key .* locked with the OLD passphrase/);
		expect(before).toContain(
			`sudo morphit-ops import-altnet-key --network=tor --in=${join(live, 'hs_ed25519_secret_key')}`
		);
		// Not the circular advice: export-altnet-key asks for the old passphrase.
		expect(out).not.toContain('export-altnet-key');
	});
});

describe('the input ending (Ctrl+D, no terminal) stops cleanly', () => {
	it('at the key: "Stopped — the input ended", 130, nothing written, no "Try again" loop', async () => {
		const before = readFileSync(KS, 'utf8');
		const rc = await run(); // no answers at all: the input has ended
		expect(rc).toBe(130);
		expect(out).toMatch(/Stopped — the input ended/);
		expect(out).not.toMatch(/Try again/);
		expect(readFileSync(KS, 'utf8')).toBe(before);
	});

	it('at "current passphrase": a stop, never read as "I do not know it"', async () => {
		rmSync(CRED, { force: true });
		const before = readFileSync(KS, 'utf8');
		secrets.push(NEW_WIF); // then the input ends at the passphrase
		const rc = await run();
		expect(rc).toBe(130);
		expect(out).not.toMatch(/Choose a new unlock passphrase/);
		expect(readFileSync(KS, 'utf8')).toBe(before);
	});
});

describe('the verdicts, worded for this command', () => {
	it('the owner key: refused, and told to paste the ACTIVE key — not to run the command it is in', async () => {
		secrets.push(OWNER_WIF);
		answers.push([/^Paste a different key/, false]);
		const before = readFileSync(KS, 'utf8');
		expect(await run()).toBe(1);
		expect(out).toMatch(/OWNER key/);
		expect(out).toMatch(/Paste the ACTIVE key of @relayacct instead/);
		expect(out).not.toContain('sudo morphit-ops edit-active-key');
		expect(readFileSync(KS, 'utf8')).toBe(before);
	});

	it('one node\'s "posting key" (unconfirmed): says what it said, and asks before saving — No (the default) changes nothing', async () => {
		const before = readFileSync(KS, 'utf8');
		secrets.push(NEW_WIF);
		const rc = await run(
			{},
			{
				checkChain: async () => ({
					kind: 'unknown',
					why: 'only one node answered',
					unconfirmed: { kind: 'wrong', foundAs: 'posting', activeKeys: [] }
				})
			}
		);
		expect(rc).toBe(1);
		expect(out).toMatch(/one Blurt node says that this is @relayacct's POSTING key/);
		expect(asked.filter((q) => /^Save this key/.test(q))).toHaveLength(1);
		expect(readFileSync(KS, 'utf8')).toBe(before);
	});

	it('…and Yes saves it', async () => {
		secrets.push(NEW_WIF);
		answers.push([/^Save this key/, true], [/^Replace the relay/, true]);
		const rc = await run(
			{},
			{
				checkChain: async () => ({
					kind: 'unknown',
					why: 'only one node answered',
					unconfirmed: { kind: 'wrong', foundAs: null, activeKeys: [] }
				})
			}
		);
		expect(rc).toBe(0);
		expect(await wifIn(KS, OLD_PASS)).toBe(NEW_WIF);
	});
});

describe('without root', () => {
	it('says to run it with sudo; nothing is read or asked', async () => {
		const rc = await run({}, { isRoot: () => false });
		expect(rc).toBe(1);
		expect(out).toContain('sudo morphit-ops edit-active-key');
		expect(out).not.toMatch(/EACCES/);
		expect(asked).toEqual([]);
	});
});

describe('the next steps', () => {
	it('look at the relay log by time, and name morphit-ops status', async () => {
		secrets.push(NEW_WIF);
		answers.push([/^Replace the relay/, true]);
		expect(await run()).toBe(0);
		expect(out).toContain('sudo morphit-ops status');
		expect(out).toMatch(
			/sudo journalctl -u morphit-relay --since "-15min" --no-pager \| grep active_key/
		);
		expect(out).not.toMatch(/journalctl -u morphit-relay -n 50/);
	});
});
