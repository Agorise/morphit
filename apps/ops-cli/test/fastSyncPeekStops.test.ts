/**
 * fast-sync: what it says when the snapshot lookup does not give a snapshot,
 * and how it stops.
 *
 * Review of v1.21.18, 2026-10-29:
 *  - a Ctrl+C while it looked for the snapshot died without a word (M1);
 *  - a lookup that failed read "No snapshot to restore: usage:" (a --from-file
 *    path that names nothing) or "…: config validation failed:" (the indexer's
 *    settings did not load), and a relative --from-file was looked up inside
 *    /opt/morphit, not where the operator typed it (M2);
 *  - Ctrl+C while it waited for the indexer after a restore returned 0 without
 *    a line (L2);
 *  - "Could not confirm the indexer stopped" gave no next step (L3);
 *  - it waited for the indexer only on 127.0.0.1:8081, whatever the indexer's
 *    settings say (L4);
 *  - the database reset ignored the database's port and socket folder, and
 *    made it differently from the installer (L1).
 *
 * The restore (the bash child) is mocked; `systemctl` is a stand-in on PATH;
 * the real snapshot-bootstrap is run for the lookups that need no chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

vi.mock('../src/init/prompt.ts', async (orig) => ({
	...(await orig<typeof import('../src/init/prompt.ts')>()),
	askYesNo: async () => true,
	ask: async () => 'fast-sync'
}));
vi.mock('node:child_process', async (orig) => {
	const real = await orig<typeof import('node:child_process')>();
	return {
		...real,
		spawnSync: ((cmd: string, ...rest: unknown[]) => {
			// Only the restore is a stand-in (the env-file reader runs bash too).
			const script = String((rest[0] as string[] | undefined)?.[1] ?? '');
			if (cmd !== 'bash' || !script.includes('snapshot-bootstrap.ts'))
				return (real.spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest);
			return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null };
		}) as typeof real.spawnSync
	};
});
/** Waits are instant (the stop poll sleeps 1 s twenty times). */
vi.mock('../src/lib/spinRun.ts', async (orig) => ({
	...(await orig<typeof import('../src/lib/spinRun.ts')>()),
	sleepMs: async () => undefined
}));
/** The install root runFastSync works on: a temporary tree when set. */
const fakeRepo = { dir: '' };
vi.mock('../src/lib/repoRoot.ts', async (orig) => {
	const real = await orig<typeof import('../src/lib/repoRoot.ts')>();
	return {
		...real,
		defaultRepoRoot: () => (fakeRepo.dir !== '' ? fakeRepo.dir : real.defaultRepoRoot())
	};
});

const {
	runFastSync,
	peekSnapshot,
	peekFailureWhy,
	replacedUnusableWayOut,
	localIndexerHealthBase
} = await import('../src/commands/fastSync.ts');

let dir = '';
let out = '';
const PATH = process.env.PATH;
const CALLER = process.env.MORPHIT_OPS_CALLER_CWD;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fastsync-peek-'));
	writeFileSync(join(dir, 'log'), '');
	writeFileSync(
		join(dir, 'systemctl'),
		[
			'#!/bin/sh',
			`D=${dir}`,
			'echo "$@" >> "$D/log"',
			'case "$1" in',
			'  is-active) if [ -f "$D/stuck-$2" ]; then echo active; elif [ -f "$D/stopped-$2" ]; then echo inactive; else echo active; fi ;;',
			'  stop) touch "$D/stopped-$2" ;;',
			'  start) rm -f "$D/stopped-$2" ;;',
			'esac',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${dir}:${PATH}`;
	vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(0);
	out = '';
	vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
		out += String(s);
		return true;
	});
	fakeRepo.dir = '';
});
afterEach(() => {
	process.env.PATH = PATH;
	if (CALLER === undefined) delete process.env.MORPHIT_OPS_CALLER_CWD;
	else process.env.MORPHIT_OPS_CALLER_CWD = CALLER;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

const db = {
	query: async () => ({ rows: [{ last_applied_block: '59646157', last_applied_at: null }] }),
	close: async () => {}
};
type Deps = NonNullable<Parameters<typeof runFastSync>[1]>;
const goodPeek: Deps['peek'] = async () => ({
	ok: true,
	block: 59_700_000,
	indexerVersion: '1.21.17',
	lines: ['This snapshot is from block 59,700,000.']
});
const run = (flags: Record<string, string>, deps: Deps): Promise<number> =>
	runFastSync({ db: db as never, config: {} as never, flags, positional: [] }, deps);
const log = (): string[] =>
	readFileSync(join(dir, 'log'), 'utf8')
		.split('\n')
		.filter((l) => /^(stop|start)\b/.test(l));

describe('the snapshot lookup', () => {
	it('a relative --from-file is the operator’s folder, and a missing one is said plainly', async () => {
		const here = join(dir, 'where-i-typed-it');
		mkdirSync(here);
		process.env.MORPHIT_OPS_CALLER_CWD = here;
		const asked: Array<string | null> = [];
		const peek: Deps['peek'] = async (o) => {
			asked.push(o.fromFile);
			return goodPeek!(o);
		};
		const code = await run({ 'from-file': 'snap.tar.gz' }, { peek });
		expect(code).toBe(1);
		expect(out).toContain(`There is no file at ${join(here, 'snap.tar.gz')}.`);
		expect(out).toContain('Nothing was changed.');
		expect(out).not.toMatch(/usage:/);
		expect(asked).toEqual([]);
		expect(log()).toEqual([]);

		writeFileSync(join(here, 'snap.tar.gz'), 'x');
		out = '';
		await run({ 'from-file': 'snap.tar.gz' }, { peek, indexerAnswers: async () => true });
		expect(asked).toEqual([join(here, 'snap.tar.gz')]);
	});

	it('the indexer’s settings did not load: said as that, with the next step — never "…failed:"', async () => {
		// The real snapshot-bootstrap, with none of the indexer's settings here.
		const saved = Object.fromEntries(
			Object.entries(process.env).filter(([k]) => k.startsWith('MORPHIT_'))
		);
		for (const k of Object.keys(saved)) delete process.env[k];
		try {
			const r = await peekSnapshot(REPO, { fromFile: null });
			expect(r).toMatchObject({ ok: false, kind: 'settings' });
			expect(r.ok === false && r.kind === 'settings' ? r.lines.join('\n') : '').toContain(
				'MORPHIT_INDEXER_CHAIN_ID: Required'
			);
			await run({}, { peek: async () => r });
			expect(out).toContain('The indexer’s settings did not load');
			expect(out).toContain('MORPHIT_INDEXER_CHAIN_ID: Required');
			expect(out).toContain('sudo morphit-ops doctor');
			expect(out).not.toMatch(/No snapshot to restore|failed:\s*$/m);
		} finally {
			Object.assign(process.env, saved);
		}
	}, 60_000);

	it('the tool’s own words, never a dangling "usage:" or "…failed:"', () => {
		expect(
			peekFailureWhy(
				'snapshot-bootstrap: usage:\n  own-box:     snapshot-bootstrap.ts <snapshot.tar.gz> --i-trust-this-source\n'
			)
		).not.toMatch(/usage|:$/);
		expect(
			peekFailureWhy(
				'[hidden-dispatcher] installed\nsnapshot-bootstrap failed: could not reach:\n  - every RPC node refused\n'
			)
		).toBe('could not reach: every RPC node refused');
		expect(
			peekFailureWhy('snapshot-bootstrap: no indexer_snapshot_v1 op from @morphit yet.\n')
		).toBe('no indexer_snapshot_v1 op from @morphit yet.');
	});

	it('Ctrl+C while it looks: the lookup stops, and fast-sync says nothing was changed (130)', async () => {
		// A stand-in install whose snapshot tool waits.
		const repo = join(dir, 'repo');
		mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
		writeFileSync(
			join(repo, 'node_modules', '.bin', 'tsx'),
			`#!/bin/sh\necho started > '${join(dir, 'tool')}'\nexec sleep 30\n`,
			{ mode: 0o755 }
		);
		const started = Date.now();
		const pending = peekSnapshot(repo, { fromFile: null });
		// The tool is a real child process: poll until it has started.
		await vi.waitFor(() => readFileSync(join(dir, 'tool')), { timeout: 10_000, interval: 50 });
		process.emit('SIGINT');
		const r = await pending;
		expect(r).toEqual({ ok: false, kind: 'stopped', signal: 'SIGINT' });
		expect(Date.now() - started).toBeLessThan(15_000);

		const code = await run({}, { peek: async () => r });
		expect(code).toBe(130);
		expect(out).toContain('Stopped — nothing was changed.');
		expect(out).not.toMatch(/No snapshot to restore/);
		expect(log()).toEqual([]);
	}, 30_000);
});

describe('stopping and starting again', () => {
	it('Ctrl+C while waiting for the indexer after a restore: said, the relay left stopped with its command, 130', async () => {
		const code = await run(
			{},
			{
				peek: goodPeek,
				indexerAnswers: async (stopEarly) => {
					process.emit('SIGINT');
					return !stopEarly();
				}
			}
		);
		expect(code).toBe(130);
		expect(out).toContain('Stopped — you pressed Ctrl+C while waiting for the indexer.');
		expect(out).toContain('sudo systemctl start morphit-relay');
		expect(log()).toEqual(['stop morphit-relay', 'stop morphit-indexer', 'start morphit-indexer']);
	});

	it('an indexer that does not stop: nothing restored, and what to look at next', async () => {
		writeFileSync(join(dir, 'stuck-morphit-indexer'), '');
		const code = await run({}, { peek: goodPeek, indexerAnswers: async () => true });
		expect(code).toBe(1);
		expect(out).toContain('Could not confirm the indexer stopped, so nothing was restored.');
		expect(out).toContain(
			'On this server: sudo systemctl status morphit-indexer, then run fast-sync again.'
		);
	}, 30_000);

	it('waits for the indexer where its own settings say it listens', async () => {
		const hits: string[] = [];
		const server = http.createServer((q, r) => {
			hits.push(q.url ?? '');
			r.setHeader('content-type', 'application/json');
			r.end('{"status":"ok"}');
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as AddressInfo).port;
		try {
			fakeRepo.dir = join(dir, 'install');
			mkdirSync(fakeRepo.dir);
			writeFileSync(
				join(fakeRepo.dir, 'morphit.env'),
				`MORPHIT_INDEXER_LISTEN_HOST=127.0.0.1\nMORPHIT_INDEXER_LISTEN_PORT=${port}\n`
			);
			expect(localIndexerHealthBase(fakeRepo.dir)).toBe(`http://127.0.0.1:${port}`);
			const code = await run({}, { peek: goodPeek });
			expect(code).toBe(0);
			expect(hits).toContain('/v1/health');
			// Answered there, so the relay was started after it.
			expect(log()).toEqual([
				'stop morphit-relay',
				'stop morphit-indexer',
				'start morphit-indexer',
				'start morphit-relay'
			]);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 30_000);
});

describe('the database reset after an unusable restore', () => {
	const text = (url: string): string => replacedUnusableWayOut(url).join('\n');
	it('the same server as the URL (its port, its socket folder), made as the installer makes it', () => {
		const t = text('postgresql://morphit_indexer:pw@localhost:5433/morphit_indexer');
		expect(t).toContain(
			`sudo -u postgres psql -p 5433 -c 'DROP DATABASE "morphit_indexer" WITH (FORCE);'`
		);
		expect(t).toContain(
			`sudo -u postgres psql -p 5433 -c "CREATE DATABASE \\"morphit_indexer\\" OWNER \\"morphit_indexer\\" ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;"`
		);
		expect(text('postgresql://u:pw@localhost/morphit?host=/run/postgresql&port=5434')).toContain(
			'sudo -u postgres psql -p 5434 -h /run/postgresql -c'
		);
	});
	it('a database on another machine (also named by ?host=): no made-up command', () => {
		for (const url of [
			'postgresql://u:pw@localhost/morphit?host=10.0.0.9',
			'postgresql://u:pw@localhost/db?host=db.example.org',
			'postgresql://u:pw@/morphit?host=10.0.0.9'
		]) {
			expect(text(url)).not.toContain('DROP DATABASE');
			expect(text(url)).toContain('OPERATIONS.md §46');
		}
	});
});
