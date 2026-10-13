/**
 * fast-sync's restore child and Ctrl+C, under PLAIN node (the installed
 * bundle), never tsx: tsx installs a SIGINT handler of its own, which hid the
 * fault the first time (2026-10-12). The real fastSyncFromChain is bundled the
 * way scripts/build.mjs bundles the CLI and run in its own process group, with
 * a stand-in `node_modules/.bin/tsx` as the restore; Ctrl+C goes to the group.
 *
 *  - Ctrl+C stops the restore only: fastSyncFromChain returns, so its caller
 *    starts the indexer it stopped (the process used to die with it).
 *  - The restore is told when its caller starts the indexer (no second "start
 *    the indexer" line), and exit 4 — the database replaced but not usable — is
 *    passed on, with what to do.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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

/** A bundle that runs fastSyncFromChain on `repo` and prints its result. */
function bundle(root: string, repo: string, callerStarts: boolean): string {
	const entry = join(root, 'entry.ts');
	writeFileSync(
		entry,
		`import { fastSyncFromChain } from ${JSON.stringify(SRC)};
const rc = fastSyncFromChain({ repoRoot: ${JSON.stringify(repo)}, force: true, indexerStartedByCaller: ${callerStarts} });
console.log('AFTER rc=' + rc);
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
	return out;
}

/** A repo whose "tsx" is `script` (run by bash, as fast-sync execs it). */
function repo(script: string): string {
	const root = mkdtempSync(join(tmpdir(), 'fastsync-sig-'));
	roots.push(root);
	mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
	writeFileSync(join(root, 'node_modules', '.bin', 'tsx'), `#!/bin/bash\n${script}\n`, {
		mode: 0o755
	});
	return root;
}

function run(
	file: string,
	ctrlCAfterMs: number | null,
	signal: NodeJS.Signals = 'SIGINT'
): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
	return new Promise((res) => {
		const p = spawn(process.execPath, [file], {
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		p.stdout.on('data', (b) => (out += String(b)));
		p.stderr.on('data', (b) => (out += String(b)));
		if (ctrlCAfterMs !== null) setTimeout(() => process.kill(-p.pid!, signal), ctrlCAfterMs);
		p.on('close', (code, signal) => res({ code, signal, out }));
	});
}

describe('fast-sync and Ctrl+C (plain node)', () => {
	it('Ctrl+C during the restore stops the restore only; fast-sync returns to its caller', async () => {
		const r0 = repo('sleep 5');
		const file = bundle(r0, r0, true);
		const r = await run(file, 1500);
		expect(r.out).toContain('Fast-sync did not complete');
		expect(r.out).toMatch(/AFTER rc=\d+/);
		expect(r.signal).toBeNull();
	}, 60_000);

	it('the terminal closing (SIGHUP) during the restore: fast-sync still returns to its caller', async () => {
		const r0 = repo('sleep 5');
		const r = await run(bundle(r0, r0, true), 1500, 'SIGHUP');
		// Before: morphit-ops died with the terminal, and the indexer it had
		// stopped stayed stopped.
		expect(r.out).toMatch(/AFTER rc=\d+/);
		expect(r.signal).toBeNull();
	}, 60_000);

	it('when tsx dies first (a closed terminal), it waits for the restore itself before judging it', async () => {
		// The restore outlives its tsx wrapper and only then begins replacing the
		// database: before, fast-sync read the marker too early, said "as it
		// was", and its caller started the indexer on it (review, 2026-10-13).
		const r0 = repo(
			[
				'(',
				// $BASHPID read OUTSIDE $( ), which runs in a subshell of its own.
				'  me=$BASHPID',
				'  st=$(sed "s/.*) //" /proc/$me/stat | cut -d" " -f20)',
				'  echo "$me $st" > "$MORPHIT_SNAPSHOT_PID_FILE"',
				'  sleep 1',
				'  echo started > "$MORPHIT_SNAPSHOT_RESTORE_MARKER"',
				'  sleep 1',
				'  rm -f "$MORPHIT_SNAPSHOT_PID_FILE"',
				'  exit 4',
				') &',
				// The restore has said who it is (it does so first thing) before
				// its wrapper dies: waited for, not timed — on a busy CI runner a
				// fixed 0.3 s came before the pid file (2026-10-13).
				'for i in $(seq 1 200); do [ -s "$MORPHIT_SNAPSHOT_PID_FILE" ] && break; sleep 0.05; done',
				'exit 129'
			].join('\n')
		);
		const r = await run(bundle(r0, r0, true), null);
		expect(r.out).toContain('AFTER rc=4');
		expect(r.out).toContain('left STOPPED');
	}, 60_000);

	it('tells the restore when its caller starts the indexer, and only then', async () => {
		const r0 = repo(
			'echo "CALLER_STARTS=${MORPHIT_SNAPSHOT_CALLER_STARTS_INDEXER:-}" > "$PWD/env.txt"; exit 0'
		);
		await run(bundle(r0, r0, true), null);
		expect(readFileSync(join(r0, 'env.txt'), 'utf8').trim()).toBe('CALLER_STARTS=1');
		const r1 = repo(
			'echo "CALLER_STARTS=${MORPHIT_SNAPSHOT_CALLER_STARTS_INDEXER:-}" > "$PWD/env.txt"; exit 0'
		);
		const r = await run(bundle(r1, r1, false), null);
		expect(readFileSync(join(r1, 'env.txt'), 'utf8').trim()).toBe('CALLER_STARTS=');
		expect(r.out).toContain('sudo systemctl start morphit-indexer');
	}, 60_000);

	it('passes exit 4 (database replaced, not usable) on, and says not to start the indexer', async () => {
		const r0 = repo('exit 4');
		const r = await run(bundle(r0, r0, true), null);
		expect(r.out).toContain('AFTER rc=4');
		expect(r.out).toContain('left STOPPED');
		expect(existsSync(join(r0, 'env.txt'))).toBe(false);
	}, 60_000);
});
