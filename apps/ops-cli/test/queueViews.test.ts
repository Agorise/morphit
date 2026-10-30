/**
 * The relay's queue views (menu: Recent signups, Failed broadcasts, Pending
 * transfers), review 2026-10-29:
 *  - failed-broadcasts counted its totals from the ≤50 rows it fetched, showed
 *    a delegation as "0.00 B", ran "delegation" into the next column, and
 *    called a payment waiting for its confirmation "still stuck" (red ✗);
 *  - signups / drain-queue said "use --json for full export" (JSON is capped
 *    too), and `--since=all` read "last 36500d";
 *  - drain-queue showed raw reason codes and no next step for errored rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFailedBroadcasts } from '../src/commands/failedBroadcasts.ts';
import { runSignups } from '../src/commands/signups.ts';
import { runDrainQueue } from '../src/commands/drainQueue.ts';

let out = '';
beforeEach(() => {
	out = '';
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

/** A database: list queries get `rows`, COUNT queries get `counts`. */
const ctxWith = (
	rows: unknown[],
	counts: Record<string, string>,
	flags: Record<string, string> = {}
) =>
	({
		db: {
			query: async (text: string) =>
				/^\s*SELECT\s+COUNT\(\*\)/.test(text) ? { rows: [counts] } : { rows }
		},
		config: { relayAccount: 'alice-relay' },
		flags,
		positional: []
	}) as never;

const at = new Date(Date.now() - 3_600_000);
const fb = (over: Record<string, unknown>) => ({
	id: '1',
	recipient: 'bob',
	kind: 'liquid',
	amount_blurt: '10',
	amount_bp: null,
	reason: 'welcome_bonus_liquid',
	created_at: at,
	last_error: 'boom',
	last_error_at: at,
	error_count: 1,
	broadcast_at: null,
	...over
});

describe('failed-broadcasts', () => {
	it('counts the whole window, not the rows listed, and says the list is cut off', async () => {
		await runFailedBroadcasts(ctxWith([fb({})], { total: '120', sent: '30', waiting: '10' }));
		expect(out).toMatch(/120 payments had errors/);
		expect(out).toMatch(/30 sent after all, 10 being sent or confirmed by the relay, 80 not sent/);
		expect(out).toMatch(
			/Showing 1–1 of 120 payments, newest first\. The next ones, on this server: sudo morphit-ops failed-broadcasts --since=24h --offset=1/
		);
	});

	it("a delegation's amount is its Blurt Power, and its kind does not run into the next column", async () => {
		await runFailedBroadcasts(
			ctxWith([fb({ kind: 'delegation', amount_blurt: '0', amount_bp: '11' })], {
				total: '1',
				sent: '0',
				waiting: '0'
			})
		);
		expect(out).toMatch(/@bob\s+delegation\s+11 BP/);
		expect(out).not.toMatch(/0\.00 B/);
	});

	it('a send waiting for its confirmation is not shown as stuck', async () => {
		await runFailedBroadcasts(
			ctxWith([fb({ error_count: 0, last_error: 'outcome_unknown trx_id=abc exp=1 checks=2' })], {
				total: '1',
				sent: '0',
				waiting: '1'
			})
		);
		expect(out).toMatch(/\[?…\]? .*being sent or confirmed/);
		expect(out).not.toMatch(/✗/);
		expect(out).toMatch(/0 not sent/);
	});
});

describe('signups', () => {
	it('--since=all reads "all time", and a cut-off list says how many there are', async () => {
		const rows = Array.from({ length: 100 }, (_, i) => ({
			name: `user${i}`,
			created_block_num: '1',
			created_block_time: at,
			created_trx_id: 'x',
			first_activity_at: null
		}));
		await runSignups(ctxWith(rows, { count: '250' }, { since: 'all' }));
		expect(out).toMatch(/\(all time\)/);
		expect(out).not.toMatch(/36500d/);
		expect(out).toMatch(/250 signups in this window/);
		expect(out).toMatch(
			/Showing 1–100 of 250 signups, newest first\. The next ones, on this server: sudo morphit-ops signups --since=all --offset=100/
		);
		expect(out).not.toMatch(/use --json for full export/);
	});
});

/** A database that pages like Postgres: the list query's last two
 *  parameters are its LIMIT and OFFSET. */
const pagingCtx = (rows: unknown[], flags: Record<string, string> = {}) =>
	({
		db: {
			query: async (text: string, params: unknown[] = []) => {
				if (/^\s*SELECT\s+COUNT\(\*\)/.test(text))
					return { rows: [{ count: String(rows.length), total: String(rows.length) }] };
				const [limit, offset] = params.slice(-2) as [number, number];
				return { rows: rows.slice(offset, offset + limit) };
			}
		},
		config: { relayAccount: 'alice-relay' },
		flags,
		positional: []
	}) as never;

describe('a long list is read page by page (the old "for the rest" hints could not show the rest)', () => {
	const signupRows = Array.from({ length: 130 }, (_, i) => ({
		name: `user${i}`,
		created_block_num: String(1000 - i),
		created_block_time: at,
		created_trx_id: 'x',
		first_activity_at: null
	}));

	it('signups: the printed next-page command lists the ones not shown yet', async () => {
		await runSignups(pagingCtx(signupRows));
		const next = /on this server: sudo morphit-ops signups --since=24h --offset=(\d+)/.exec(out);
		expect(next?.[1]).toBe('100');
		expect(out).not.toMatch(/user100\b/);
		out = '';
		await runSignups(pagingCtx(signupRows, { offset: next?.[1] ?? '' }));
		expect(out).toMatch(/user100\b/);
		expect(out).toMatch(/user129\b/);
		expect(out).not.toMatch(/user99\b/);
		expect(out).toMatch(
			/Showing 101–130 of 130 signups, newest first\. These are the last of them\./
		);
	});

	it('drain-queue: the same, oldest first, keeping the --age filter', async () => {
		const rows = Array.from({ length: 70 }, (_, i) => ({
			id: String(i),
			recipient: `payee${i}`,
			kind: 'liquid',
			amount_blurt: '10',
			amount_bp: null,
			reason: 'welcome_bonus_liquid',
			created_at: at,
			last_error: null,
			last_error_at: null,
			error_count: 0
		}));
		await runDrainQueue(pagingCtx(rows, { age: '5m' }));
		const next = /on this server: (sudo morphit-ops drain-queue --age=5m --offset=(\d+))/.exec(out);
		expect(next?.[2]).toBe('50');
		out = '';
		await runDrainQueue(pagingCtx(rows, { age: '5m', offset: next?.[2] ?? '' }));
		expect(out).toMatch(/@?payee50\b/);
		expect(out).toMatch(/@?payee69\b/);
		expect(out).not.toMatch(/payee49\b/);
	});

	it('an --offset that is not a whole number is refused', async () => {
		expect(await runSignups(pagingCtx(signupRows, { offset: '-5' }))).toBe(1);
		expect(await runDrainQueue(pagingCtx([], { offset: 'x' }))).toBe(1);
		expect(await runFailedBroadcasts(pagingCtx([], { offset: '1.5' }))).toBe(1);
	});
});

describe('drain-queue', () => {
	it('says what each payment is for, and what to do about errored ones', async () => {
		await runDrainQueue(
			ctxWith(
				[
					{
						id: '1',
						recipient: 'bob',
						kind: 'vesting',
						amount_blurt: '10',
						amount_bp: null,
						reason: 'welcome_bonus_vesting',
						created_at: at,
						last_error: 'boom',
						last_error_at: at,
						error_count: 3
					}
				],
				{ count: '1' }
			)
		);
		expect(out).toMatch(/welcome bonus \(Blurt Power\)/);
		expect(out).not.toMatch(/welcome_bonus_vesting/);
		expect(out).toMatch(/on this server: sudo journalctl -u morphit-relay/);
		expect(out).not.toMatch(/use --json for full export/);
	});
});
