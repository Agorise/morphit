/**
 * The relay's sealed unlock passphrase:
 * `register` and the fee-recipient heal (run by every upgrade) decrypted it
 * into /run/morphit-reg-<pid>-<hex>.pass, created with the default umask
 * (0644) — readable by every local user until it was removed. It is now read
 * from systemd-creds' standard output; no file. The upgrade removes any such
 * file an interrupted older run left behind.
 *
 * `systemd-creds` is a stand-in on PATH that records its arguments and, like
 * the real one, writes the secret to the output path it is given ('-' =
 * standard output).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = mkdtempSync(join(tmpdir(), 'sealed-pass-'));
const LOG = join(S, 'args.log');
const oldPath = process.env.PATH;
beforeAll(() => {
	mkdirSync(join(S, 'bin'));
	writeFileSync(
		join(S, 'bin', 'systemd-creds'),
		`#!/bin/sh\nprintf '%s\\n' "$*" >> "${LOG}"\nfor last; do :; done\nif [ "$last" = "-" ]; then printf 'hunter2\\n'; else printf 'hunter2\\n' > "$last"; fi\n`,
		{ mode: 0o755 }
	);
	writeFileSync(join(S, 'relay_passphrase.cred'), 'sealed');
	process.env.PATH = `${join(S, 'bin')}:${oldPath}`;
	process.env.MORPHIT_RELAY_CRED_FILE = join(S, 'relay_passphrase.cred');
});
afterAll(() => {
	process.env.PATH = oldPath;
	delete process.env.MORPHIT_RELAY_CRED_FILE;
	rmSync(S, { recursive: true, force: true });
});

describe('the sealed relay passphrase', () => {
	it('is read from systemd-creds’ standard output, never through a file', async () => {
		const reg = (await import('../src/commands/register.ts')) as Record<string, unknown>;
		const read = reg.trySealedRelayPassphrase as (() => string | null) | undefined;
		expect(read, 'trySealedRelayPassphrase is not exported').toBeTypeOf('function');
		expect(read!()).toBe('hunter2');
		const args = readFileSync(LOG, 'utf8').trim().split('\n').pop()!.split(' ');
		expect(args.at(-1), 'decrypted to a file').toBe('-');
	});

	it('a leftover /run passphrase file from an older run is removed by the upgrade', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const { healStaleRegPassFiles } = (await import('../src/commands/upgrade.ts')) as {
			healStaleRegPassFiles?: (dir: string) => void;
		};
		expect(healStaleRegPassFiles).toBeTypeOf('function');
		const run = join(S, 'run');
		mkdirSync(run);
		writeFileSync(join(run, 'morphit-reg-1234-0123456789ab.pass'), 'hunter2\n');
		writeFileSync(join(run, 'something-else.pass'), 'keep');
		healStaleRegPassFiles!(run);
		expect(existsSync(join(run, 'morphit-reg-1234-0123456789ab.pass'))).toBe(false);
		expect(existsSync(join(run, 'something-else.pass'))).toBe(true);
	});
});
