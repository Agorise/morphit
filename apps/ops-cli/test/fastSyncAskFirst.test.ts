/**
 * fast-sync asks every question BEFORE it stops anything, says what the
 * operator gets (the snapshot's block and age) and loses (this node's own
 * data), and starts again whatever it stopped — also after Ctrl+C.
 *
 * Review, 2026-10-29:
 *  - it stopped the live indexer first and asked afterwards; Ctrl+C at the
 *    typed confirmation left the indexer stopped;
 *  - a bare catch around the first database read swallowed Ctrl+C at the
 *    discard question (the run went on) and took a database that did not
 *    answer for a fresh node;
 *  - the discard question did not say what is lost, nor which block the
 *    snapshot is at; the relay kept running on a database being replaced;
 *  - nothing said how old the snapshot was;
 *  - after a quarantined restore it said "wait for the next snapshot (one is
 *    published daily)" — anchoring is manual.
 *
 * `systemctl` is a stand-in on PATH that logs stop/start per unit; the restore
 * (the bash child) is mocked; the snapshot lookup is a stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const answers = {
	yesNo: [] as Array<boolean | 'ctrl-c'>,
	typed: 'fast-sync' as string | 'ctrl-c',
	asked: [] as string[]
};
const ctrlC = (): Error =>
	Object.assign(new Error('Aborted with Ctrl+C'), { name: 'AbortError', code: 'ABORT_ERR' });
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...(await orig<typeof import('../src/init/prompt.ts')>()),
	askYesNo: async (q: string, def: boolean) => {
		answers.asked.push(`yesno(${def ? 'Y' : 'N'}): ${q}`);
		const a = answers.yesNo.shift();
		if (a === 'ctrl-c') throw ctrlC();
		return a ?? def;
	},
	ask: async (q: string) => {
		answers.asked.push(`ask: ${q}`);
		if (answers.typed === 'ctrl-c') throw ctrlC();
		return answers.typed;
	}
}));
let restoreRc: number | null = 0;
let restores = 0;
const restoreCmds: string[] = [];
vi.mock('node:child_process', async (orig) => {
	const real = await orig<typeof import('node:child_process')>();
	return {
		...real,
		spawnSync: ((cmd: string, ...rest: unknown[]) => {
			if (cmd !== 'bash') return (real.spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest);
			restores++;
			restoreCmds.push(String((rest[0] as string[])[1]));
			return { status: restoreRc, stdout: '', stderr: '', pid: 0, output: [], signal: null };
		}) as typeof real.spawnSync
	};
});
/** Ctrl+C while the indexer is being stopped. */
let ctrlCDuringStop = false;
vi.mock('../src/lib/spinRun.ts', async (orig) => {
	const real = await orig<typeof import('../src/lib/spinRun.ts')>();
	return {
		...real,
		systemctlSpinning: async (label: string, args: readonly string[], o?: object) => {
			if (ctrlCDuringStop && args[0] === 'stop' && args[1] === 'morphit-indexer')
				process.emit('SIGINT');
			return real.systemctlSpinning(label, args, o);
		}
	};
});

const { runFastSync, replacedUnusableWayOut } = await import('../src/commands/fastSync.ts');

let dir = '';
let out = '';
const PATH = process.env.PATH;
const DB_URL = process.env.MORPHIT_INDEXER_DATABASE_URL;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fastsync-ask-'));
	writeFileSync(join(dir, 'log'), '');
	writeFileSync(
		join(dir, 'systemctl'),
		[
			'#!/bin/sh',
			`D=${dir}`,
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
	process.env.PATH = `${dir}:${PATH}`;
	vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(0);
	out = '';
	vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
		out += String(s);
		return true;
	});
	answers.yesNo = [];
	answers.typed = 'fast-sync';
	answers.asked = [];
	restoreRc = 0;
	restores = 0;
	ctrlCDuringStop = false;
	process.env.MORPHIT_INDEXER_DATABASE_URL =
		'postgresql://morphit_indexer:secret@localhost:5432/morphit_indexer';
});
afterEach(() => {
	process.env.PATH = PATH;
	if (DB_URL === undefined) delete process.env.MORPHIT_INDEXER_DATABASE_URL;
	else process.env.MORPHIT_INDEXER_DATABASE_URL = DB_URL;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

/** What was asked and printed, in order: each question is marked in `out`. */
let peeked = 0;
async function run(
	o: {
		state?: 'data' | 'fresh' | 'no-table' | 'refused';
		peekOk?: boolean;
		indexerAnswers?: boolean;
	} = {}
): Promise<number> {
	const state = o.state ?? 'data';
	const db = {
		query: async () => {
			if (state === 'refused')
				throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
					code: 'ECONNREFUSED'
				});
			if (state === 'no-table')
				throw Object.assign(new Error('relation "indexer_state" does not exist'), {
					code: '42P01'
				});
			return {
				rows: state === 'fresh' ? [] : [{ last_applied_block: '59646157', last_applied_at: null }]
			};
		},
		close: async () => {}
	};
	peeked = 0;
	return runFastSync(
		{ db: db as never, config: {} as never, flags: {}, positional: [] },
		{
			peek: async () => {
				peeked++;
				out += '[peek]\n';
				return o.peekOk === false
					? {
							ok: false,
							kind: 'none',
							why: 'no indexer_snapshot_v1 op from @morphit in the last 1000 history entries'
						}
					: {
							ok: true,
							block: 59_400_000,
							indexerVersion: '1.21.17',
							lines: [
								'This snapshot is from block 59,400,000, about 9 days old.',
								'Your indexer then catches up 259,200 blocks (about 9 days of chain history) by itself.'
							]
						};
			},
			indexerAnswers: async () => o.indexerAnswers ?? true
		}
	);
}
const log = (): string[] =>
	readFileSync(join(dir, 'log'), 'utf8')
		.trim()
		.split('\n')
		.filter((l) => /^(stop|start)\b/.test(l));

describe('fast-sync asks first, then stops, and always starts again', () => {
	it('Ctrl+C at the discard question: nothing was stopped, and the run stops', async () => {
		answers.yesNo = ['ctrl-c'];
		await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
		expect(log()).toEqual([]);
		expect(answers.asked.some((q) => q.startsWith('ask:'))).toBe(false);
		expect(restores).toBe(0);
	});

	it('Ctrl+C at the typed confirmation: nothing was stopped', async () => {
		answers.yesNo = [true];
		answers.typed = 'ctrl-c';
		await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
		expect(log()).toEqual([]);
		expect(restores).toBe(0);
	});

	it('Ctrl+C while the indexer is being stopped: nothing is restored, both start again', async () => {
		answers.yesNo = [true];
		ctrlCDuringStop = true;
		const code = await run();
		expect(code).toBe(130);
		expect(restores).toBe(0);
		expect(log()).toEqual([
			'stop morphit-relay',
			'stop morphit-indexer',
			'start morphit-indexer',
			'start morphit-relay'
		]);
		expect(out).toContain('Nothing was restored.');
	});

	it('a database that does not answer is said as such — nothing asked, looked up or stopped', async () => {
		const code = await run({ state: 'refused' });
		expect(code).toBe(1);
		expect(out).toMatch(/not answering/);
		expect(out).toContain('sudo systemctl status postgresql');
		expect(out).toContain('Nothing was changed');
		expect(answers.asked).toEqual([]);
		expect(peeked).toBe(0);
		expect(log()).toEqual([]);
	});

	it('no indexer_state table yet is a fresh node: no discard question, straight to the confirmation', async () => {
		await run({ state: 'no-table' });
		expect(answers.asked.filter((q) => q.startsWith('yesno'))).toEqual([]);
		expect(answers.asked.some((q) => q.startsWith('ask:'))).toBe(true);
		expect(restores).toBe(1);
	});

	it('the snapshot and its age are shown before anything is asked; the discard question says what is lost', async () => {
		answers.yesNo = [false];
		const code = await run();
		expect(code).toBe(1);
		const peekAt = out.indexOf('[peek]');
		const ageAt = out.indexOf('about 9 days old');
		expect(peekAt).toBeGreaterThan(-1);
		expect(ageAt).toBeGreaterThan(peekAt);
		expect(out).toMatch(/your node:\s+block 59,646,157/);
		expect(out).toMatch(/the snapshot:\s+block 59,400,000/);
		expect(out).toContain('The snapshot is OLDER than what your node already has.');
		for (const lost of [
			'relay payouts',
			'push-notification subscriptions',
			'addresses users gave for offline notices',
			'moderation clearances',
			'operator statistics'
		])
			expect(out).toContain(lost);
		// The safe answer is the default, and "no" changes nothing.
		expect(answers.asked[0]).toMatch(/^yesno\(N\): Replace this node/);
		expect(log()).toEqual([]);
		expect(out).toContain('Nothing was changed.');
	});

	it('no snapshot found: said plainly before anything is asked or stopped', async () => {
		const code = await run({ peekOk: false });
		expect(code).toBe(1);
		expect(out).toContain('No snapshot to restore: no indexer_snapshot_v1 op');
		expect(answers.asked).toEqual([]);
		expect(log()).toEqual([]);
	});

	it('a restore: the relay is stopped too, and started only after the indexer answers', async () => {
		answers.yesNo = [true];
		restoreCmds.length = 0;
		expect(await run()).toBe(0);
		// Only the snapshot that was shown (block 59,400,000) may be restored.
		expect(restoreCmds.at(-1)).toContain(`'--expect-block' '59400000'`);
		expect(log()).toEqual([
			'stop morphit-relay',
			'stop morphit-indexer',
			'start morphit-indexer',
			'start morphit-relay'
		]);
	});

	it('the indexer does not answer after a restore: the relay is left stopped, with the command', async () => {
		answers.yesNo = [true];
		expect(await run({ indexerAnswers: false })).toBe(0);
		expect(log()).toEqual(['stop morphit-relay', 'stop morphit-indexer', 'start morphit-indexer']);
		expect(out).toContain('sudo systemctl start morphit-relay');
	});

	it('exit 4: both stay stopped, and the way out is real — never "wait for the next snapshot"', async () => {
		answers.yesNo = [true];
		restoreRc = 4;
		expect(await run()).toBe(4);
		expect(log()).toEqual(['stop morphit-relay', 'stop morphit-indexer']);
		expect(out).toContain('sudo morphit-ops fast-sync');
		expect(out).toContain(
			`sudo -u postgres psql -c 'DROP DATABASE "morphit_indexer" WITH (FORCE);'`
		);
		expect(out).toContain(
			`sudo -u postgres psql -c "CREATE DATABASE \\"morphit_indexer\\" OWNER \\"morphit_indexer\\" ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;"`
		);
		expect(out).not.toMatch(/next snapshot|published daily/);
	});

	it('the zero-trust choice names a real step for this node', async () => {
		answers.yesNo = [false];
		await run();
		expect(out).toContain('your indexer keeps its');
		expect(out).not.toMatch(/START_BLOCK|genesis/);
		out = '';
		answers.typed = 'no';
		await run({ state: 'fresh' });
		expect(out).toContain('on\nan empty database it replays the whole chain itself');
		expect(out).toContain('    sudo systemctl start morphit-indexer');
		expect(out).not.toMatch(/START_BLOCK|genesis/);
	});
});

describe('the way out after a replaced, unusable database', () => {
	it('a database elsewhere: no made-up command, the reset named instead', () => {
		const lines = replacedUnusableWayOut('postgresql://u:p@db.example.org:5432/morphit').join('\n');
		expect(lines).not.toContain('DROP DATABASE');
		expect(lines).toContain('OPERATIONS.md §46');
		expect(lines).toContain('sudo morphit-ops fast-sync');
	});
});
