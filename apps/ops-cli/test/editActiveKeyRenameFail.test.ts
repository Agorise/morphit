/**
 * `edit-active-key` when the new key file cannot be put in place (the rename
 * fails — a full or read-only disk, say).
 *
 * With "no copy" it used to overwrite the old key FIRST and rename after: a
 * failed rename left the old file zeroed — no key at all — and a .tmp file
 * behind, while it said "The old key file is unchanged" (review, 2026-10-29).
 * Now the old file is overwritten only once the new one is in place, the temp
 * file is removed, and what it says is true.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import type { KeyOnChain } from '../src/lib/relayKeyChain.ts';

let failRenameOnto: string | null = null;
vi.mock('node:fs', async (orig) => {
	const real = (await orig()) as typeof import('node:fs');
	return {
		...real,
		renameSync: (from: string, to: string) => {
			if (failRenameOnto !== null && to === failRenameOnto) {
				throw Object.assign(
					new Error(`ENOSPC: no space left on device, rename '${from}' -> '${to}'`),
					{
						code: 'ENOSPC'
					}
				);
			}
			return real.renameSync(from, to);
		}
	};
});
const secrets: string[] = [];
const answers: Array<[RegExp, boolean]> = [];
vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as { inputEndedError: () => Error };
	return {
		...real,
		askPassword: async () => {
			const next = secrets.shift();
			if (next === undefined) throw real.inputEndedError();
			return next;
		},
		askYesNo: async (q: string, def: boolean) => answers.find(([re]) => re.test(q))?.[1] ?? def,
		step: () => {},
		explain: () => {}
	};
});

const NEW_WIF = PrivateKey.fromSeed('relay-new-active').toString();
const OLD_WIF = PrivateKey.fromSeed('relay-old-active').toString();
const PASS = 'the current passphrase, long enough';
const S = mkdtempSync(join(tmpdir(), 'eak-rename-'));
const ROOT = join(S, 'opt', 'morphit');
const KS = join(ROOT, 'keystore.json');
const CRED = join(S, 'relay_passphrase.cred');
const oldPath = process.env.PATH;
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
	rmSync(S, { recursive: true, force: true });
});
beforeEach(async () => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(ROOT, { recursive: true });
	const { encryptEnvelope } = await import('../src/init/encrypt.ts');
	writeFileSync(KS, JSON.stringify(encryptEnvelope(OLD_WIF, PASS)));
	writeFileSync(
		join(ROOT, 'morphit.env'),
		`MORPHIT_RELAY_ACTIVE_KEY_FILE=${KS}\nMORPHIT_RELAY_ACCOUNT=relayacct\n`
	);
	writeFileSync(CRED, `SEALED:${PASS}`);
	out = '';
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out += a.join(' ') + '\n';
	});
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
	failRenameOnto = null;
	vi.restoreAllMocks();
});

describe('the new key file cannot be put in place', () => {
	it('"no copy": the old key file is really unchanged, no temp file is left, and it says what to do', async () => {
		const before = readFileSync(KS);
		failRenameOnto = KS;
		secrets.push(NEW_WIF);
		answers.push([/^Keep a copy of the old key file/, false], [/^Replace the relay/, true]);
		const { runEditActiveKey } = await import('../src/commands/editActiveKey.ts');
		const rc = await runEditActiveKey(
			{ flags: { 'config-dir': ROOT }, positional: [], colorEnabled: false },
			{ checkChain: async (): Promise<KeyOnChain> => ({ kind: 'active' }) }
		);
		expect(rc).toBe(1);
		expect(out).toMatch(/Could not write the new key file: ENOSPC/);
		expect(readFileSync(KS).equals(before)).toBe(true);
		expect(readdirSync(ROOT).filter((f) => f.includes('.tmp-'))).toEqual([]);
		expect(out).toContain('sudo morphit-ops edit-active-key');
	});
});
