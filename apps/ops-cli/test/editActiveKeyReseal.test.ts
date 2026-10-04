/**
 * Rotating the relay's active key: the new
 * keystore is encrypted with a new passphrase, and the relay opens it with the
 * passphrase sealed in /etc/morphit/relay_passphrase.cred. `edit-active-key`
 * never re-sealed it, so following the documented rotation left the relay
 * unable to start. It now re-seals (and keeps the old credential if sealing
 * fails).
 *
 * The real command runs with its prompts answered; `systemd-creds` is a
 * stand-in on PATH that "seals" by prefixing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';

const NEW_PASS = 'correct horse battery staple forty two';
const secrets: string[] = [];
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	askPassword: async () => secrets.shift() ?? '',
	askYesNo: async (q: string) => /^Rotate/.test(q),
	step: () => {},
	explain: () => {}
}));

const S = mkdtempSync(join(tmpdir(), 'reseal-'));
const CRED = join(S, 'relay_passphrase.cred');
const oldPath = process.env.PATH;
beforeAll(async () => {
	mkdirSync(join(S, 'bin'));
	writeFileSync(
		join(S, 'bin', 'systemd-creds'),
		[
			'#!/bin/sh',
			'for last; do :; done',
			'case "$1" in',
			'  encrypt) { printf "SEALED:"; cat; } > "$last" ;;',
			'  decrypt) for a; do f="$a"; [ "$a" = "-" ] && break; prev="$a"; done; sed "s/^SEALED://" "$prev" ;;',
			'esac'
		].join('\n') + '\n',
		{ mode: 0o755 }
	);
	process.env.PATH = `${join(S, 'bin')}:${oldPath}`;
	process.env.MORPHIT_RELAY_CRED_FILE = CRED;
	writeFileSync(CRED, 'SEALED:the old passphrase');
	const { encryptEnvelope } = await import('../src/init/encrypt.ts');
	writeFileSync(
		join(S, 'keystore.json'),
		JSON.stringify(
			encryptEnvelope(PrivateKey.fromSeed('old').toString(), 'the old passphrase is long')
		)
	);
	writeFileSync(
		join(S, 'morphit.env'),
		`MORPHIT_RELAY_ACTIVE_KEY_FILE=${join(S, 'keystore.json')}\nMORPHIT_RELAY_ACCOUNT=relayacct\n`
	);
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
	process.env.PATH = oldPath;
	delete process.env.MORPHIT_RELAY_CRED_FILE;
	rmSync(S, { recursive: true, force: true });
});

describe('edit-active-key', () => {
	it('re-seals the relay passphrase credential with the new passphrase', async () => {
		const { runEditActiveKey } = await import('../src/commands/editActiveKey.ts');
		secrets.push(PrivateKey.fromSeed('new').toString(), NEW_PASS, NEW_PASS);
		const rc = await runEditActiveKey({
			flags: { 'config-dir': S, 'keep-backup': 'true' },
			positional: [],
			colorEnabled: false
		});
		expect(rc).toBe(0);
		expect(readFileSync(CRED, 'utf8'), 'the relay would still try the old passphrase').toBe(
			`SEALED:${NEW_PASS}`
		);
		expect(existsSync(`${CRED}.new`)).toBe(false);
	}, 60_000);
});
