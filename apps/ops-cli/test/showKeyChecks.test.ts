/**
 * `show-key` (menu: "Show my active public key").
 *
 *  - It opens the key with the relay's sealed passphrase first, as register
 *    does — on the relay's own server there is nothing to type (M6); a wrong
 *    typed passphrase is said in plain words and may be retried (LOW).
 *  - Ctrl+C at the passphrase is a stop (exit 130 via commandFailed), not
 *    "✗ Could not load the key: Aborted with Ctrl+C" and exit 1 (M7).
 *  - The public key is checked against the chain and the answer printed as
 *    ✓ matches / ✗ does not match — no clearnet explorer link (M8).
 *  - Missing settings name the real file (<install>/morphit.env, found from
 *    where the menu runs it) and the command to run (M9).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyOnChain } from '../src/lib/relayKeyChain.ts';

const typed: Array<string | Error> = [];
let askedPass = 0;
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	askPassword: async () => {
		askedPass++;
		const t = typed.shift() ?? '';
		if (t instanceof Error) throw t;
		return t;
	}
}));

const WIF = PrivateKey.fromSeed('show-key-active').toString();
const PASS = 'the relay key passphrase, long';
const S = mkdtempSync(join(tmpdir(), 'showkey-'));
const ROOT = join(S, 'opt', 'morphit');
const KS = join(ROOT, 'keystore.json');
const CRED = join(S, 'relay_passphrase.cred');
const oldPath = process.env.PATH;
const oldCwd = process.cwd();
let out = '';

beforeAll(async () => {
	mkdirSync(join(S, 'bin'));
	writeFileSync(
		join(S, 'bin', 'systemd-creds'),
		[
			'#!/bin/sh',
			'case "$1" in',
			'  decrypt) for a; do [ "$a" = "-" ] && break; prev="$a"; done; [ -f "$prev" ] || exit 1; sed "s/^SEALED://" "$prev" ;;',
			'esac'
		].join('\n') + '\n',
		{ mode: 0o755 }
	);
	mkdirSync(join(ROOT, 'apps', 'ops-cli'), { recursive: true });
	writeFileSync(
		join(ROOT, 'package.json'),
		JSON.stringify({ name: 'morphit', workspaces: ['apps/*'] })
	);
	const { encryptEnvelope } = await import('../src/init/encrypt.ts');
	writeFileSync(KS, JSON.stringify(encryptEnvelope(WIF, PASS)));
});
afterAll(() => {
	process.chdir(oldCwd);
	rmSync(S, { recursive: true, force: true });
});
beforeEach(() => {
	process.env.PATH = `${join(S, 'bin')}:${oldPath}`;
	vi.stubEnv('MORPHIT_RELAY_CRED_FILE', CRED);
	vi.stubEnv('MORPHIT_RELAY_ACCOUNT', 'relayacct');
	vi.stubEnv('MORPHIT_RELAY_ACTIVE_KEY_FILE', KS);
	typed.length = 0;
	askedPass = 0;
	out = '';
	rmSync(CRED, { force: true });
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out += a.join(' ') + '\n';
	});
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	process.chdir(join(ROOT, 'apps', 'ops-cli'));
});
afterEach(() => {
	process.env.PATH = oldPath;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	process.chdir(oldCwd);
});

const active = async (): Promise<KeyOnChain> => ({ kind: 'active' });
const { runShowKey } = await import('../src/commands/showKey.ts');

describe('show-key', () => {
	it("opens the key with the relay's sealed passphrase: nothing is asked", async () => {
		writeFileSync(CRED, `SEALED:${PASS}`);
		const rc = await runShowKey({ flags: {}, positional: [] }, { checkChain: active });
		expect(rc).toBe(0);
		expect(askedPass).toBe(0);
		expect(out).toContain(PrivateKey.fromString(WIF).createPublic('BLT').toString());
	});

	it('a wrong typed passphrase is said plainly and may be tried again', async () => {
		typed.push('not the passphrase at all', PASS);
		const rc = await runShowKey({ flags: {}, positional: [] }, { checkChain: active });
		expect(rc).toBe(0);
		expect(askedPass).toBe(2);
		expect(out).toMatch(/That passphrase does not open the relay key file\. Try again/);
		expect(out).not.toMatch(/tampered|decryption failed|envelope/);
	});

	it('Ctrl+C at the passphrase is a stop (thrown on; the CLI makes it 130), not "could not load the key" (1)', async () => {
		const { abortError, isAbortError } = await import('../src/init/prompt.ts');
		typed.push(abortError());
		await expect(
			runShowKey({ flags: {}, positional: [] }, { checkChain: active })
		).rejects.toSatisfy((e: unknown) => isAbortError(e));
		expect(out).not.toMatch(/Could not load the key/);
	});

	it('the saved key is checked against the chain: ✗ does not match, the fix, exit 1 — no explorer link', async () => {
		writeFileSync(CRED, `SEALED:${PASS}`);
		const rc = await runShowKey(
			{ flags: {}, positional: [] },
			{
				checkChain: async () => ({
					kind: 'wrong',
					foundAs: 'posting',
					activeKeys: ['BLTsomethingelse']
				})
			}
		);
		expect(rc).toBe(1);
		expect(out).toMatch(/✗ Does not match/);
		expect(out).toContain('sudo morphit-ops edit-active-key');
		expect(out).not.toMatch(/blurtwallet|block explorer/);
	});

	it('listed, but below the threshold: ✗ with its own words, the fix, exit 1 (it used to exit 0)', async () => {
		writeFileSync(CRED, `SEALED:${PASS}`);
		const rc = await runShowKey(
			{ flags: {}, positional: [] },
			{ checkChain: async () => ({ kind: 'weak', weight: 1, threshold: 2 }) }
		);
		expect(rc).toBe(1);
		expect(out).toMatch(/Listed, but cannot sign alone/);
		expect(out).toContain('sudo morphit-ops edit-active-key');
	});

	it('no such account: the fix is the account name in the settings, not edit-active-key', async () => {
		writeFileSync(CRED, `SEALED:${PASS}`);
		const rc = await runShowKey(
			{ flags: {}, positional: [] },
			{ checkChain: async () => ({ kind: 'no-account' }) }
		);
		expect(rc).toBe(1);
		expect(out).toMatch(/MORPHIT_RELAY_ACCOUNT=/);
		expect(out).toContain(`sudo nano ${join(ROOT, 'morphit.env')}`);
		expect(out).not.toContain('edit-active-key');
	});

	it('the real chain check goes through this node’s indexer', async () => {
		const http = await import('node:http');
		const pub = PrivateKey.fromString(WIF).createPublic('BLT').toString();
		const srv = http.createServer((req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(
				JSON.stringify({
					result: [
						{
							name: 'relayacct',
							active: { weight_threshold: 1, account_auths: [], key_auths: [[pub, 1]] },
							owner: { weight_threshold: 1, account_auths: [], key_auths: [] },
							posting: { weight_threshold: 1, account_auths: [], key_auths: [] }
						}
					]
				})
			);
		});
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
		const { checkKeyOnChain } = await import('../src/lib/relayKeyChain.ts');
		const v = await checkKeyOnChain('relayacct', pub, {
			indexerBases: [base],
			hiddenOnly: () => true
		});
		srv.close();
		expect(v).toEqual({ kind: 'active' });
	});

	it('missing settings: the real file (<install>/morphit.env) and the command — not "set -a; . ./morphit.env"', async () => {
		vi.stubEnv('MORPHIT_RELAY_ACCOUNT', '');
		vi.stubEnv('MORPHIT_RELAY_ACTIVE_KEY_FILE', '');
		writeFileSync(join(ROOT, 'morphit.env'), '# nothing here\n');
		const rc = await runShowKey({ flags: {}, positional: [] }, { checkChain: active });
		rmSync(join(ROOT, 'morphit.env'));
		expect(rc).toBe(1);
		expect(out).toContain(
			`the relay account name (MORPHIT_RELAY_ACCOUNT, in ${join(ROOT, 'morphit.env')})`
		);
		expect(out).toContain(`sudo nano ${join(ROOT, 'morphit.env')}`);
		expect(out).toContain('sudo morphit-ops show-key');
		expect(out).not.toMatch(/set -a|\. \.\/morphit\.env/);
	});
});
