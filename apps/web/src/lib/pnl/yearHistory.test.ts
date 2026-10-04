/**
 * The yearly P&L export reads the account's history page by page from the
 * indexer. When a page is too large for one reply the indexer answers 413
 * reply_too_large; the export must ask for the SAME page again with fewer
 * entries (1,000, then 100) and never take the refusal — or any other failed
 * read — as the start of history, which would silently cut the export.
 */
import { describe, expect, it } from 'vitest';

import { fetchYearOfHistory } from './yearHistory';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const DAY = 86_400_000;

/** A fake indexer over `count` history entries, the newest `spacingMs` apart
 *  ending at NOW. Pages follow Blurt: `from` (−1 = newest) back `limit`
 *  entries. Answers 413 reply_too_large when `limit > maxLimit`. */
function indexer(
	count: number,
	opts: {
		maxLimit?: number;
		spacingMs?: number;
		failAt?: number;
		busyCalls?: ReadonlySet<number>;
	} = {}
) {
	const spacing = opts.spacingMs ?? 60_000;
	const calls: Array<{ from: number; limit: number }> = [];
	const fetchImpl = (async (url: string) => {
		const u = new URL(url);
		const from = Number(u.searchParams.get('from'));
		const limit = Number(u.searchParams.get('limit'));
		calls.push({ from, limit });
		if (opts.busyCalls?.has(calls.length)) {
			return new Response(
				JSON.stringify({ status: 'error', code: 'history_busy', message: 'retry shortly' }),
				{ status: 503, headers: { 'retry-after': '5' } }
			);
		}
		if (opts.failAt !== undefined && calls.length === opts.failAt) {
			return new Response(JSON.stringify({ status: 'error', code: 'internal', message: 'x' }), {
				status: 502
			});
		}
		if (limit > (opts.maxLimit ?? Infinity)) {
			return new Response(
				JSON.stringify({ status: 'error', code: 'reply_too_large', message: 'ask for fewer' }),
				{ status: 413 }
			);
		}
		const top = from === -1 ? count - 1 : Math.min(from, count - 1);
		const bottom = Math.max(0, top - limit + 1);
		const entries = [];
		for (let seq = bottom; seq <= top; seq++) {
			const ts = new Date(NOW - (count - 1 - seq) * spacing)
				.toISOString()
				.replace('Z', '')
				.slice(0, 19);
			entries.push([
				seq,
				{ block: seq + 1, trx_id: `t${seq}`, timestamp: ts, op: ['transfer', {}] }
			]);
		}
		return new Response(JSON.stringify({ account: 'alice', entries }), { status: 200 });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe('yearly P&L history read', () => {
	it('a page too large at 10,000 is read again at 1,000 — the whole year is exported', async () => {
		const { fetchImpl, calls } = indexer(2_500, { maxLimit: 1_000 });
		const r = await fetchYearOfHistory('https://i.example', 'alice', NOW, fetchImpl);
		expect(r.kind).toBe('ok');
		expect(r.kind === 'ok' && r.ops.length).toBe(2_500);
		expect(calls[0]).toEqual({ from: -1, limit: 10_000 });
		expect(calls[1]).toEqual({ from: -1, limit: 1_000 });
		// The next pages start at the size that worked.
		expect(calls.slice(2).map((c) => c.limit)).toEqual([1_000, 1_000]);
		expect(calls[2]!.from).toBe(1_499);
	});

	it('then at 100', async () => {
		const { fetchImpl, calls } = indexer(250, { maxLimit: 100 });
		const r = await fetchYearOfHistory('https://i.example', 'alice', NOW, fetchImpl);
		expect(r.kind === 'ok' && r.ops.length).toBe(250);
		expect(calls.slice(0, 3).map((c) => c.limit)).toEqual([10_000, 1_000, 100]);
	});

	it('still too large at 100: the export fails instead of coming out short', async () => {
		const { fetchImpl } = indexer(50, { maxLimit: 10 });
		expect(await fetchYearOfHistory('https://i.example', 'alice', NOW, fetchImpl)).toEqual({
			kind: 'error',
			reason: 'fetch_failed'
		});
	});

	it('a failed read part-way fails the export (not a short one)', async () => {
		// 10,000 entries, one per minute (well within a year); the 2nd page fails.
		const { fetchImpl } = indexer(15_000, { failAt: 2 });
		expect(await fetchYearOfHistory('https://i.example', 'alice', NOW, fetchImpl)).toEqual({
			kind: 'error',
			reason: 'fetch_failed'
		});
	});

	it('stops at a year-old entry and at the start of history', async () => {
		// One entry per day for 500 days: the read stops once it passes a year.
		const yearish = indexer(500, { spacingMs: DAY, maxLimit: 100 });
		const r = await fetchYearOfHistory('https://i.example', 'alice', NOW, yearish.fetchImpl);
		expect(r.kind).toBe('ok');
		expect(yearish.calls.map((c) => c.limit)).toEqual([10_000, 1_000, 100, 100, 100, 100]);
		// A short page at the reduced size is the real start of history.
		const short = indexer(150, { maxLimit: 100 });
		const s = await fetchYearOfHistory('https://i.example', 'alice', NOW, short.fetchImpl);
		expect(s.kind === 'ok' && s.ops.length).toBe(150);
	});

	it('more activity in a year than the export reads is an error, not a cut-off', async () => {
		// 60,000 entries in the last ~42 days (above the 50,000-entry budget).
		const { fetchImpl } = indexer(60_000, { spacingMs: 60_000 });
		expect(await fetchYearOfHistory('https://i.example', 'alice', NOW, fetchImpl)).toEqual({
			kind: 'error',
			reason: 'too_much_history'
		});
	});

	it('a busy indexer (503 history_busy) is waited out and the same page read again (A1 VT5-2)', async () => {
		// The 1st and 3rd requests are refused as busy; 2,500 entries at 1,000 a page.
		const { fetchImpl, calls } = indexer(2_500, { maxLimit: 1_000, busyCalls: new Set([1, 3]) });
		const waits: number[] = [];
		const r = await fetchYearOfHistory('https://i.example', 'alice', NOW, fetchImpl, async (ms) => {
			waits.push(ms);
		});
		expect(r.kind === 'ok' && r.ops.length).toBe(2_500);
		expect(waits).toEqual([5_000, 5_000]);
		// The busy page is asked again unchanged.
		expect(calls[1]).toEqual(calls[0]);
	});

	it('still busy after a few tries: the export fails with "busy", never comes out short', async () => {
		const always = new Set(Array.from({ length: 50 }, (_, i) => i + 1));
		const { fetchImpl, calls } = indexer(100, { busyCalls: always });
		const waits: number[] = [];
		const r = await fetchYearOfHistory('https://i.example', 'alice', NOW, fetchImpl, async (ms) => {
			waits.push(ms);
		});
		expect(r).toEqual({ kind: 'error', reason: 'busy' });
		expect(calls.length).toBeLessThanOrEqual(5);
		expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
	});
});
