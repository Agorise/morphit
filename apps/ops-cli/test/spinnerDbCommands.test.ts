/**
 * The database-backed commands (status, signups, drain-queue, moderation, …)
 * wait on Postgres — up to the pool's 5 s connect timeout on a slow or stopped
 * database, then the queries. At the terminal that wait shows the braille
 * spinner, and its line is cleared before the command prints its report.
 * Under --json, stdout carries nothing but the JSON document (the spinner goes
 * to stderr).
 *
 * The database is a stand-in whose queries wait until the test lets them go,
 * so the test can look at the terminal WHILE the command is waiting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLEAR, currentLine, fakeTerminal, frameRe, type FakeTerminal } from './helpers/screen.ts';
import type { CommandCtx } from '../src/lib/ctx.ts';
import { runStatus } from '../src/commands/status.ts';
import { runSignups } from '../src/commands/signups.ts';
import { runDrainQueue } from '../src/commands/drainQueue.ts';
import { runFailedBroadcasts } from '../src/commands/failedBroadcasts.ts';
import { runAbuse } from '../src/commands/abuse.ts';
import { runLoyalty } from '../src/commands/loyalty.ts';
import { runAttestations } from '../src/commands/attestations.ts';
import { runFlags } from '../src/commands/flags.ts';
import { runTreasury } from '../src/commands/treasury.ts';
import { runBlock } from '../src/commands/block.ts';
import { runFastForward } from '../src/commands/fastForward.ts';
import { runModeration } from '../src/commands/moderation.ts';

// status asks this node's indexer for its fee view (up to 4 s); no indexer here.
vi.mock('../src/lib/operatorFeeRecipient.ts', async (orig) => ({
	...(await orig<typeof import('../src/lib/operatorFeeRecipient.ts')>()),
	localFeeView: async () => null
}));

const BRAILLE = /[⠀-⣿]/;

let term: FakeTerminal | null = null;
afterEach(() => {
	term?.restore();
	term = null;
});

/** A database whose queries hang until `release()`. `seen` holds what the
 *  terminal showed (stdout, stderr) when the FIRST query was asked. */
function slowDb(t: FakeTerminal) {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const seen: { out: string; err: string }[] = [];
	const db = {
		query: async () => {
			seen.push({ out: t.out(), err: t.err() });
			await gate;
			return { rows: [], rowCount: 0 };
		},
		close: async () => {}
	};
	return { db, seen, release };
}

const config = {
	relayAccount: 'relay',
	operatorAccount: 'operator',
	signupDailyCeiling: 100
};

function ctxOf(
	db: unknown,
	flags: Record<string, string> = {},
	positional: string[] = []
): CommandCtx {
	return { db: db as never, config: config as never, flags, positional };
}

/** Run until the first query is asked, look, then let it finish. */
async function runWaiting(
	run: (ctx: CommandCtx) => Promise<number>,
	flags: Record<string, string> = {},
	positional: string[] = []
): Promise<{ atQuery: { out: string; err: string }; out: string; err: string }> {
	const t = fakeTerminal();
	term = t;
	const { db, seen, release } = slowDb(t);
	const done = run(ctxOf(db, flags, positional)).catch(() => -1);
	for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setImmediate(r));
	expect(seen.length).toBeGreaterThan(0);
	release();
	await done;
	t.restore();
	term = null;
	return { atQuery: seen[0]!, out: t.out(), err: t.err() };
}

describe('a database read at the terminal shows the spinner, then clears it', () => {
	it('signups: the spinner is on the line while the query waits; the report comes after the clear', async () => {
		const r = await runWaiting(runSignups);
		expect(currentLine(r.atQuery.out)).toMatch(frameRe('Reading from the database…'));
		const report = r.out.indexOf('Signups');
		const label = r.out.lastIndexOf('Reading from the database…');
		expect(label).toBeGreaterThan(-1);
		// Cleared after the last frame and before any report text.
		const clear = r.out.indexOf(CLEAR, label);
		expect(clear).toBeGreaterThan(label);
		if (report !== -1) expect(report).toBeGreaterThan(clear);
		expect(BRAILLE.test(r.out.slice(clear))).toBe(false);
	});

	it('status: the spinner is on the line while the dashboard is read', async () => {
		const r = await runWaiting(runStatus);
		expect(currentLine(r.atQuery.out)).toMatch(frameRe('Reading this node’s status…'));
		const label = r.out.lastIndexOf('Reading this node’s status…');
		const clear = r.out.indexOf(CLEAR, label);
		expect(clear).toBeGreaterThan(label);
		expect(BRAILLE.test(r.out.slice(clear))).toBe(false);
		expect(r.out.slice(clear).length).toBeGreaterThan(100); // the dashboard came after
	});

	it.each([
		['signups', runSignups, [] as string[]],
		['status', runStatus, [] as string[]]
	])(
		'%s --json: stdout is only the JSON document; the spinner was on stderr',
		async (_n, run, pos) => {
			const r = await runWaiting(run, { json: 'true' }, pos);
			expect(BRAILLE.test(r.out)).toBe(false);
			expect(() => JSON.parse(r.out)).not.toThrow();
			expect(r.out.trim().split('\n')).toHaveLength(1);
			expect(currentLine(r.atQuery.err)).toMatch(/\r {2}[⠀-⣿] Reading/);
			expect(r.err.endsWith('\u001b[?25h')).toBe(true); // cleared, cursor back
		}
	);

	it.each([
		['drain-queue', runDrainQueue, []],
		['failed-broadcasts', runFailedBroadcasts, []],
		['abuse', runAbuse, []],
		['loyalty', runLoyalty, []],
		['attestations', runAttestations, []],
		['flags', runFlags, []],
		['treasury btc', runTreasury, ['btc']],
		['block', runBlock, ['someone']],
		['fast-forward', runFastForward, []],
		['moderation', runModeration, []]
	] as [string, (c: CommandCtx) => Promise<number>, string[]][])(
		'%s: a braille frame with its label is on the line while the database answers',
		async (_n, run, pos) => {
			const r = await runWaiting(run, {}, pos);
			expect(currentLine(r.atQuery.out)).toMatch(/\r {2}[⠀-⣿] \S/);
			expect(r.out).toContain(CLEAR);
		}
	);
});
