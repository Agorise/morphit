/**
 * The installed `morphit-ops` launcher (bin/morphit-ops.mjs) and Ctrl+C, run for
 * real under plain node with a stand-in CLI as `dist/main.js`, Ctrl+C sent to
 * the whole process group as a terminal does.
 *
 *  - The CLI decides what Ctrl+C means: when it handles it and goes on (fast-sync
 *    starting the indexer it stopped), the launcher waits and passes its exit
 *    code on. Without the launcher's listener it died first and handed the shell
 *    back while the CLI still ran (2026-10-12).
 *  - When the CLI dies BY the signal, so does the launcher: a script running
 *    `morphit-ops …; next` stops there, as it did before (review, 2026-10-12:
 *    it went on with exit 1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'morphit-ops.mjs');
const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A package dir holding the real launcher and `cli` as dist/main.js. */
function pkg(cli: string): string {
	const root = mkdtempSync(join(tmpdir(), 'launcher-'));
	roots.push(root);
	mkdirSync(join(root, 'bin'));
	mkdirSync(join(root, 'dist'));
	copyFileSync(LAUNCHER, join(root, 'bin', 'morphit-ops.mjs'));
	writeFileSync(join(root, 'dist', 'main.js'), cli);
	return root;
}

/** Run the launcher in its own process group; Ctrl+C the group after `ms`. */
function run(
	root: string,
	ctrlCAfterMs: number | null
): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
	return new Promise((res) => {
		const p = spawn(process.execPath, [join(root, 'bin', 'morphit-ops.mjs')], {
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		p.stdout.on('data', (b) => (out += String(b)));
		p.stderr.on('data', (b) => (out += String(b)));
		if (ctrlCAfterMs !== null) setTimeout(() => process.kill(-p.pid!, 'SIGINT'), ctrlCAfterMs);
		p.on('close', (code, signal) => res({ code, signal, out }));
	});
}

describe('the morphit-ops launcher and Ctrl+C', () => {
	it('waits for a CLI that handles Ctrl+C and goes on, and passes its exit code on', async () => {
		// The stand-in CLI's own timers (it runs in its own process, in real time).
		const root = pkg(`
const CLEAN_UP_MS = 600, STAY_UP_MS = 10000;
process.on('SIGINT', () => {
	setTimeout(() => { console.log('CLI: started the indexer again'); process.exit(7); }, CLEAN_UP_MS);
});
setTimeout(() => {}, STAY_UP_MS);
`);
		const r = await run(root, 700);
		expect(r.out).toContain('CLI: started the indexer again');
		expect([r.code, r.signal]).toEqual([7, null]);
	}, 20_000);

	it('dies by the signal when the CLI does', async () => {
		const root = pkg(`const STAY_UP_MS = 10000; setTimeout(() => {}, STAY_UP_MS);`);
		const r = await run(root, 700);
		expect(r.signal).toBe('SIGINT');
	}, 20_000);

	it('passes a plain exit code on', async () => {
		const root = pkg(`process.exit(5);`);
		const r = await run(root, null);
		expect([r.code, r.signal]).toEqual([5, null]);
	}, 20_000);
});
