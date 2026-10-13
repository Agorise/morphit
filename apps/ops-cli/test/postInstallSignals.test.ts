/**
 * A real Ctrl+C in a step's own program after the install (the canary setup,
 * `register`, branding) stops only that program; the wizard goes on.
 *
 * The signal reaches the wizard too (same terminal). It is ignored while a
 * program runs, and for one more turn of the event loop, so the signal that
 * arrived during the program is read before "a Ctrl+C at a wait" counts again.
 * One `setImmediate` was not enough right after an answer was read: that turn
 * ends before the signal is read, so the wizard stopped too (review,
 * 2026-10-12: 3 of 3 runs under a real terminal). Run here under PLAIN node,
 * with a real SIGINT sent by the program itself, right after a real readline
 * answer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const SRC = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'src',
	'init',
	'runAnsibleInstall.ts'
);
const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function runScenario(mode: 'afterRead' | 'afterTimer' | 'atWait'): string {
	const root = mkdtempSync(join(tmpdir(), 'post-install-sig-'));
	roots.push(root);
	const entry = join(root, 'entry.ts');
	writeFileSync(
		entry,
		`import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { postInstallSignals } from ${JSON.stringify(SRC)};
const sig = postInstallSignals();
const mode = ${JSON.stringify(mode)};
// This program's own pauses (a timer between the answer and the step; time for
// a signal to be read before the wizard checks for it).
const TIMER_MS = 50, SETTLE_MS = 100;
const rl = createInterface({ input: process.stdin });
const a = await rl.question('');
rl.close();
if (mode === 'afterTimer') await new Promise((r) => setTimeout(r, TIMER_MS));
if (mode === 'atWait') {
	process.kill(process.pid, 'SIGINT');
	await new Promise((r) => setTimeout(r, SETTLE_MS));
} else {
	// The step's program, Ctrl+C'd: the terminal signals the whole group.
	await sig.child(() =>
		spawnSync('bash', ['-c', 'kill -INT $PPID; sleep 0.3; exit 130'], { stdio: 'ignore' })
	);
	await new Promise((r) => setTimeout(r, SETTLE_MS));
}
try {
	sig.checkStop();
	console.log('RESULT goes-on ' + a);
} catch {
	console.log('RESULT stopped ' + a);
}
sig.release();
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
	const r = spawnSync(process.execPath, [out], { input: 'y\n', encoding: 'utf8', timeout: 60_000 });
	return (r.stdout.match(/RESULT \S+ \S+/) ?? [
		`no result: ${r.status} ${r.signal} ${r.stderr}`
	])[0];
}

describe('Ctrl+C in a step’s program after the install', () => {
	it('right after an answer was read: only the program stops', () => {
		for (let i = 0; i < 5; i++) expect(runScenario('afterRead')).toBe('RESULT goes-on y');
	}, 120_000);

	it('later on: the same', () => {
		expect(runScenario('afterTimer')).toBe('RESULT goes-on y');
	}, 60_000);

	it('at a wait, with no program running: the wizard stops', () => {
		expect(runScenario('atWait')).toBe('RESULT stopped y');
	}, 60_000);
});
