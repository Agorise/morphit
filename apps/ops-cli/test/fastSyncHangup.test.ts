/**
 * fast-sync and a closed terminal, on a REAL terminal (a pty that is then
 * closed), under plain node — the installed bundle — with the CLI's own
 * last-resort handler (an uncaught error ends the process with 127).
 *
 * Review of v1.21.18, 2026-10-29 (Q2): after the terminal closed (SIGHUP), the
 * next line written to it failed (EIO), nothing listened for that, and the
 * process ended with 127 before it had started the relay it stopped — on a
 * closed SSH session, the relay stayed down.
 *
 * `systemctl` is a stand-in on PATH that logs what it is asked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const SRC = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'src',
	'commands',
	'fastSync.ts'
);
const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Runs `cmd` on a pty, closes the pty once `waitFile` exists, then waits for
 *  the process to end (at most 60 s) and prints "=== EXIT <code>". */
const DRIVER = `
import os, pty, sys, time, select
wait_file, cmd = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
deadline = time.time() + 30
while time.time() < deadline and not os.path.exists(wait_file):
    r, _, _ = select.select([fd], [], [], 0.05)
    if r:
        try:
            os.read(fd, 65536)
        except OSError:
            break
os.close(fd)
end = time.time() + 60
code = None
while time.time() < end:
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        code = os.waitstatus_to_exitcode(st)
        break
    time.sleep(0.05)
print("=== EXIT", code)
`;

describe('fast-sync when the terminal is closed', () => {
	it('starts again what it stopped, without dying on the dead terminal', () => {
		const root = mkdtempSync(join(tmpdir(), 'fastsync-hup-'));
		roots.push(root);
		const log = join(root, 'log');
		writeFileSync(log, '');
		writeFileSync(
			join(root, 'systemctl'),
			[
				'#!/bin/sh',
				`D=${root}`,
				'echo "$@" >> "$D/log"',
				'case "$1" in',
				'  is-active) if [ -f "$D/stopped-$2" ]; then echo inactive; else echo active; fi ;;',
				'  stop) touch "$D/stopped-$2" ;;',
				'  start) rm -f "$D/stopped-$2" ;;',
				'esac',
				''
			].join('\n'),
			{ mode: 0o755 }
		);
		const entry = join(root, 'entry.ts');
		writeFileSync(
			entry,
			`import { withServicesStopped } from ${JSON.stringify(SRC)};
import { appendFileSync, writeFileSync } from 'node:fs';
const D = ${JSON.stringify(root)};
// The CLI's own last resort (apps/ops-cli/src/main.ts).
process.on('uncaughtException', (e) => {
	appendFileSync(D + '/log', 'fatal ' + (e && e.message) + '\\n');
	process.exit(127);
});
// The terminal's hangup, as an event (no clock): the pty is closed by then,
// so every line written after it hits the dead terminal. A signal listener
// does not keep node running, so a timer that never fires does, until then.
const alive = setInterval(() => {}, 3_600_000);
const hup = new Promise<void>((r) =>
	process.on('SIGHUP', () => {
		clearInterval(alive);
		r();
	})
);
const rc = await withServicesStopped(
	{ indexer: true, relay: true },
	async () => {
		writeFileSync(D + '/restoring', '');
		await hup;
		return 1; // the restore did not go through: both start again
	},
	async () => true
);
appendFileSync(D + '/log', 'returned ' + rc + '\\n');
process.exit(0);
`
		);
		const out = join(root, 'entry.mjs');
		buildSync({
			entryPoints: [entry],
			outfile: out,
			bundle: true,
			platform: 'node',
			format: 'esm',
			target: 'node22',
			external: ['pg', '@resvg/resvg-js'],
			logLevel: 'silent',
			banner: {
				js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
			}
		});
		writeFileSync(join(root, 'driver.py'), DRIVER);
		const r = spawnSync(
			'python3',
			['-I', join(root, 'driver.py'), join(root, 'restoring'), process.execPath, out],
			{
				encoding: 'utf8',
				timeout: 120_000,
				env: { ...process.env, PATH: `${root}:${process.env.PATH}` }
			}
		);
		const said = readFileSync(log, 'utf8');
		expect(said, r.stdout + r.stderr).not.toMatch(/^fatal/m);
		expect(r.stdout).toContain('=== EXIT 0');
		const units = said.split('\n').filter((l) => /^(stop|start) /.test(l));
		expect(units).toEqual([
			'stop morphit-relay',
			'stop morphit-indexer',
			'start morphit-indexer',
			'start morphit-relay'
		]);
		expect(said).toContain('returned 1');
	}, 120_000);
});
