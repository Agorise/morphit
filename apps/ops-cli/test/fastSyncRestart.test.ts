/**
 * fast-sync starts the indexer again when the restore does not go through.
 *
 * 2026-10-12, a fresh VPS: every download source refused, fast-sync said "did
 * not complete" — and left the indexer it had stopped stopped. Only a success
 * started it again.
 *
 * `systemctl` is a stand-in on PATH that logs what it is asked; the restore
 * itself (the bash child) is made to fail.
 *
 * v1.21.7: never on a database the restore replaced but did not get to check —
 * exit 4, or the restore cut off once it had begun (the child leaves its
 * marker), whatever exit code it managed (review, 2026-10-12: a Ctrl+C on a
 * busy box ended it with 130, read as "nothing changed").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../src/init/prompt.ts', async (orig) => ({
	...(await orig<typeof import('../src/init/prompt.ts')>()),
	askYesNo: async () => true, // stop it? yes. discard the data? yes.
	ask: async () => 'fast-sync'
}));
let restoreRc: number | null = 1;
/** The restore child leaves its "restore started" marker behind. */
let markerLeft = false;
vi.mock('node:child_process', async (orig) => {
	const real = await orig<typeof import('node:child_process')>();
	return {
		...real,
		spawnSync: ((cmd: string, ...rest: unknown[]) => {
			if (cmd !== 'bash') return (real.spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest);
			const marker = (rest[1] as { env?: Record<string, string> } | undefined)?.env
				?.MORPHIT_SNAPSHOT_RESTORE_MARKER;
			if (markerLeft && marker) writeFileSync(marker, 'started\n');
			return { status: restoreRc, stdout: '', stderr: '', pid: 0, output: [], signal: null };
		}) as typeof real.spawnSync
	};
});

const { runFastSync } = await import('../src/commands/fastSync.ts');

let dir = '';
const PATH = process.env.PATH;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fastsync-restart-'));
	writeFileSync(
		join(dir, 'systemctl'),
		[
			'#!/bin/sh',
			`D=${dir}`,
			'echo "$@" >> "$D/log"',
			'case "$1" in',
			'  is-active) if [ -f "$D/stopped" ]; then echo inactive; else echo active; fi ;;',
			'  stop) touch "$D/stopped" ;;',
			'  start) rm -f "$D/stopped" ;;',
			'esac',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${dir}:${PATH}`;
	vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(0);
});
afterEach(() => {
	process.env.PATH = PATH;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

/** The indexer running again, an empty log: the next run starts as the first. */
function fresh(): void {
	writeFileSync(join(dir, 'log'), '');
	rmSync(join(dir, 'stopped'), { force: true });
}

async function run(flags: Record<string, string> = {}): Promise<{ code: number; log: string[] }> {
	const db = {
		query: async () => ({ rows: [{ last_applied_block: '59646157', last_applied_at: null }] }),
		close: async () => {}
	};
	const code = await runFastSync({
		db: db as never,
		config: {} as never,
		flags,
		positional: []
	});
	const log = readFileSync(join(dir, 'log'), 'utf8')
		.trim()
		.split('\n')
		.filter((l) => /^(stop|start)\b/.test(l));
	return { code, log };
}

describe('fast-sync and the indexer it stopped', () => {
	it('a failed restore starts it again', async () => {
		restoreRc = 1;
		const { code, log } = await run();
		expect(code).not.toBe(0);
		expect(log).toEqual(['stop morphit-indexer', 'start morphit-indexer']);
	});

	it('a successful restore starts it again', async () => {
		restoreRc = 0;
		const { code, log } = await run();
		expect(code).toBe(0);
		expect(log).toEqual(['stop morphit-indexer', 'start morphit-indexer']);
	});

	it('exit 4 (replaced, not to be served) leaves it stopped — from the chain and from a file', async () => {
		restoreRc = 4;
		const cases: Record<string, string>[] = [{}, { 'from-file': join(dir, 'snap.tar.gz') }];
		for (const flags of cases) {
			fresh();
			const { code, log } = await run(flags);
			expect(code).toBe(4);
			expect(log).toEqual(['stop morphit-indexer']);
		}
	});

	it('a restore cut off after it began (marker left) leaves it stopped, whatever its exit code', async () => {
		markerLeft = true;
		try {
			const cases: Record<string, string>[] = [{}, { 'from-file': join(dir, 'snap.tar.gz') }];
			for (const flags of cases)
				for (const rc of [130, 137, 1, null]) {
					restoreRc = rc;
					fresh();
					const { code, log } = await run(flags);
					expect(code, `exit ${rc} ${JSON.stringify(flags)}`).toBe(4);
					expect(log, `exit ${rc} ${JSON.stringify(flags)}`).toEqual(['stop morphit-indexer']);
				}
			// It finished (exit 0): the database is restored and checked.
			restoreRc = 0;
			fresh();
			expect((await run()).log).toEqual(['stop morphit-indexer', 'start morphit-indexer']);
		} finally {
			markerLeft = false;
		}
	});
});
