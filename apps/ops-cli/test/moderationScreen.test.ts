/**
 * The Moderation screen's questions (menu 23), against a stand-in database.
 *
 *  - The Block / Unblock / Clear / Undo / Done loop is offered even when the
 *    window holds no flag (it returned straight away), and Enter means Done
 *    (it meant "Clear a flag") — M2, H4.
 *  - "Undo a clearance" is a real choice that removes the clearance (the old
 *    text said "pick the same signal to undo one", which only re-recorded it)
 *    — M1.
 *  - `--since=all` is headed "all time", not "last 36500d"; a windowed view
 *    that hides older flags points at the exact command with sudo — LOW, H4.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandCtx } from '../src/lib/ctx.ts';

const choices: Array<{ q: string; options: string[]; def: number | undefined }> = [];
let pick: (q: string, options: string[], def: number | undefined) => number = (_q, _o, d) => d ?? 0;
let yes = true;
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	askChoice: async (q: string, options: readonly string[], def?: number) => {
		choices.push({ q, options: [...options], def });
		return pick(q, [...options], def);
	},
	askYesNo: async () => yes,
	ask: async () => ''
}));

const queries: string[] = [];
let clearanceRows: unknown[] = [];
let hiddenRow: Record<string, string> = {
	reciprocity: '0',
	related: '0',
	pile_on: '0',
	concentration: '0'
};
const db = {
	query: async (sql: string) => {
		queries.push(sql);
		if (/FROM moderation_flag_clearances\s+ORDER BY/i.test(sql)) return { rows: clearanceRows };
		if (/DELETE FROM moderation_flag_clearances/i.test(sql)) return { rows: [], rowCount: 1 };
		if (/detected_at < \$1/.test(sql)) return { rows: [hiddenRow] };
		return { rows: [], rowCount: 0 };
	},
	close: async () => {}
};
const ctx = (flags: Record<string, string> = {}): CommandCtx =>
	({ db, config: { operatorAccount: 'alice-operator' }, flags, positional: [] }) as never;

let out = '';
const tty = process.stdin.isTTY;
beforeEach(() => {
	choices.length = 0;
	queries.length = 0;
	clearanceRows = [];
	hiddenRow = { reciprocity: '0', related: '0', pile_on: '0', concentration: '0' };
	// Enter (the default) the first time the loop asks; Done after that, so a
	// wrong default cannot loop for ever.
	pick = (q, o, d) =>
		choices.filter((c) => c.q === q).length > 1 && o.includes('Done')
			? o.indexOf('Done')
			: (d ?? 0);
	yes = true;
	out = '';
	(process.stdin as { isTTY?: boolean }).isTTY = true;
	vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
		out += String(c);
		return true;
	});
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out += a.join(' ') + '\n';
	});
});
afterEach(() => {
	(process.stdin as { isTTY?: boolean }).isTTY = tty;
	vi.restoreAllMocks();
});

const { runModeration } = await import('../src/commands/moderation.ts');

describe('the Moderation screen', () => {
	it('with no flag at all still offers the loop, and Enter is Done', async () => {
		expect(await runModeration(ctx())).toBe(0);
		expect(out).toMatch(/0 flags/);
		const loop = choices[0];
		expect(loop).toBeDefined();
		expect(loop!.options).toEqual(
			expect.arrayContaining(['Block an account', 'Unblock an account', 'Undo a clearance', 'Done'])
		);
		expect(loop!.options[loop!.def!]).toBe('Done');
	});

	it('"Undo a clearance" lists the clearances and removes the one picked', async () => {
		clearanceRows = [
			{
				signal: 'pile_on',
				account_a: 'erin',
				account_b: 'gina',
				watermark: null,
				note: '',
				cleared_at: new Date('2026-10-01T00:00:00Z')
			}
		];
		let step = 0;
		pick = (q, o, d) => {
			step++;
			if (step === 1) return o.indexOf('Undo a clearance');
			if (/Which clearance/.test(q)) return 0;
			return o.includes('Done') ? o.indexOf('Done') : (d ?? o.length - 1);
		};
		expect(await runModeration(ctx())).toBe(0);
		const list = choices.find((c) => /Which clearance/.test(c.q));
		expect(list?.options[0]).toMatch(/pile_on\s+@erin ↔ @gina\s+\(permanent\)/);
		expect(list?.options[list.def!]).toBe('Cancel');
		expect(queries.some((q) => /DELETE FROM moderation_flag_clearances/.test(q))).toBe(true);
		expect(out).toMatch(/Clearance removed/);
	});

	it('--since=all is "all time"; a window hiding older flags names the exact command', async () => {
		await runModeration(ctx({ since: 'all' }));
		expect(out).toMatch(/\(all time\)/);
		expect(out).not.toMatch(/36500d/);
		out = '';
		hiddenRow = { reciprocity: '2', related: '0', pile_on: '1', concentration: '0' };
		await runModeration(ctx({ since: '7d' }));
		expect(out).toMatch(/\(last 7d\)/);
		expect(out).toMatch(/3 older flags outside this window/);
		expect(out).toContain('on this server: sudo morphit-ops moderation');
		expect(out).not.toMatch(/--since=all/);
	});
});
