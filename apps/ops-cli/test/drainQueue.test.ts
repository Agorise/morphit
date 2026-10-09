/**
 * `morphit-ops drain-queue` (menu: Pending transfers).
 *
 * 2026-10-08, morphit.io: two delegation rows had been re-sent for five days.
 * The view showed their amount as "0.00 BLURT" (a delegation's amount is its
 * Blurt Power target) and, since their error_count was still 0, nothing about
 * their state — they looked like any healthy new row.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { runDrainQueue } from '../src/commands/drainQueue.ts';

const rowsAs = (rows: unknown[]) =>
	({
		db: { query: async () => ({ rows }) },
		config: {},
		flags: {},
		positional: []
	}) as never;

const delegation = {
	id: '2',
	recipient: 'khrom',
	kind: 'delegation',
	amount_blurt: '0',
	amount_bp: '11',
	reason: 'loyalty_milestone_100',
	created_at: new Date(Date.now() - 5 * 86_400_000),
	last_error: 'outcome_unknown trx_id=' + 'a'.repeat(40) + ' exp=1 checks=0',
	last_error_at: new Date(),
	error_count: 0
};

afterEach(() => vi.restoreAllMocks());

function printed(fn: () => Promise<number>): Promise<string> {
	let out = '';
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
	vi.spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void (out += a.join(' ') + '\n')
	);
	return fn().then(() => out);
}

describe('drain-queue', () => {
	it("shows a delegation's Blurt Power, not 0 BLURT", async () => {
		const out = await printed(() => runDrainQueue(rowsAs([delegation])));
		expect(out).toMatch(/delegation\s+khrom\s+11 BP/);
		expect(out).not.toMatch(/0\.00 BLURT/);
	});

	it('shows the state of a row whose send is unconfirmed, though no error was counted yet', async () => {
		const out = await printed(() => runDrainQueue(rowsAs([delegation])));
		expect(out).toMatch(/waiting: outcome_unknown trx_id=/);
	});

	it("shows what the nodes answered, however long the row's state text is", async () => {
		// Review 2026-10-08: the state was cut at 120 characters, before the
		// nodes' answer, on exactly the rows that stopped retrying.
		const answer = 'Account must delegate a minimum of 1000.000 VESTS';
		const out = await printed(() =>
			runDrainQueue(
				rowsAs([
					{
						...delegation,
						error_count: 3,
						last_error: `not_landed trx_id=${'b'.repeat(40)} (absent past its expiration per 2+ operators) — the nodes answered: ${answer}`
					},
					{
						...delegation,
						id: '3',
						last_error: `outcome_unknown trx_id=${'c'.repeat(40)} exp=1791488214124 checks=12 cause=${answer}`
					}
				])
			)
		);
		expect(out.split(answer)).toHaveLength(3);
	});

	it('piped or logged (no terminal), the report is not preceded by the spinner label', async () => {
		// Review 2026-10-08: without a terminal the label was printed as a line of
		// its own into the report (and into cron mail).
		const out = await printed(() => runDrainQueue(rowsAs([delegation])));
		expect(out).not.toMatch(/Reading from the database/);
	});

	it('--json carries the Blurt Power target', async () => {
		const out = await printed(() =>
			runDrainQueue({ ...(rowsAs([delegation]) as object), flags: { json: 'true' } } as never)
		);
		expect(JSON.parse(out).entries[0].amount_bp).toBe('11');
	});
});
