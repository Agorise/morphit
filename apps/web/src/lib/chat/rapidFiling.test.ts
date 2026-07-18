// @vitest-environment jsdom
/**
 * v1.7.7 — [KEN]: "if i have 20 messages sitting in my inbox, and i want every
 * single one of them to move to Archived and i click on one archive link for
 * each message every half second, then nothing will malfunction or break,
 * right? ... experienced users will be clicking stuff pretty damn fast."
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const broadcasts: string[][] = [];
/** Per-call latency. A FIXED delay makes every op complete in the order it
 *  departed, which is exactly the case that cannot expose the bug: the danger is
 *  an OLDER op landing in a LATER block than a newer one, so the mock has to be
 *  able to finish out of order. First draft used a constant and passed against
 *  the broken code. */
let delaysMs: number[] = [];
let callNo = 0;
vi.mock('$blurt/ops/chatFolders', () => ({
	broadcastChatFolders: vi.fn(async (_id: unknown, state: { archived: string[]; starred: string[] }) => {
		const d = delaysMs[callNo++] ?? 0;
		await new Promise((r) => setTimeout(r, d));
		broadcasts.push([...state.archived]);
	})
}));
// chatFolders imports from '$stores/identity'; mock the path it actually uses.
vi.mock('$lib/stores/identity', async () => {
	const { writable: w } = await import('svelte/store');
	return {
		identity: w({
			state: 'unlocked',
			live: { posting: { privateKey: 'fake-priv', publicKey: 'fake-pub' } }
		})
	};
});

import {
	archiveThread,
	isArchived,
	toggleStar,
	isStarred,
	restoreThread,
	folderOf,
	clearChatFolders,
	__reloadChatFolders
} from '$lib/chat/chatFolders';

const BLOCK = '2026-07-17T12:00:00.000Z';
const threads = Array.from({ length: 20 }, (_, i) => `peer${i}` as const);

describe('rapid filing — 20 threads, one click every 500ms', () => {
	beforeEach(() => {
		localStorage.clear();
		clearChatFolders();
		__reloadChatFolders();
		broadcasts.length = 0;
		delaysMs = [];
		callNo = 0;
	});

	it('EVERY archive lands locally, instantly, with no drops', () => {
		for (const p of threads) archiveThread(p, 'order-1', BLOCK);
		for (const p of threads) expect(isArchived(p, 'order-1')).toBe(true);
	});

	it('interleaved star / unstar / archive / restore all land, in order', () => {
		archiveThread('kentest2', 'o', BLOCK);
		expect(folderOf('kentest2', 'o')).toBe('archived');
		restoreThread('kentest2', 'o');
		expect(folderOf('kentest2', 'o')).toBe('inbox');
		toggleStar('kentest2', 'o', BLOCK);
		expect(folderOf('kentest2', 'o')).toBe('starred');
		toggleStar('kentest2', 'o', BLOCK); // unstar
		expect(folderOf('kentest2', 'o')).toBe('inbox');
		archiveThread('kentest2', 'o', BLOCK);
		expect(folderOf('kentest2', 'o')).toBe('archived');
		expect(isStarred('kentest2', 'o')).toBe(false);
	});

	it('a fast click-spree collapses into ONE broadcast carrying ALL 20', async () => {
		vi.useFakeTimers();
		for (const p of threads) {
			archiveThread(p, 'order-1', BLOCK);
			await vi.advanceTimersByTimeAsync(500); // Ken's cadence
		}
		await vi.advanceTimersByTimeAsync(2_000); // let the debounce settle
		await vi.runOnlyPendingTimersAsync();
		vi.useRealTimers();
		// The debounce resets on each click, so twenty clicks are ONE op — asserting
		// only "all 20 eventually arrived" would pass even with no debounce at all
		// (20 separate ops, the last carrying everything). Pin the batching itself.
		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]!.length).toBe(20);
	});

	it("KEN: click every second, then REFRESH a couple seconds later — nothing is lost", async () => {
		vi.useFakeTimers();
		delaysMs = [60_000]; // the broadcast is still in flight when the tab dies
		for (const p of threads.slice(0, 5)) {
			archiveThread(p, 'order-1', BLOCK);
			await vi.advanceTimersByTimeAsync(1_000); // Ken's cadence
		}
		await vi.advanceTimersByTimeAsync(2_000); // debounce fires, op departs
		vi.useRealTimers();

		// THE REFRESH. Module state dies; only what reached storage survives.
		__reloadChatFolders();

		// The mirror is written SYNCHRONOUSLY on every click, so every archive is
		// still here — this is what makes the debounce safe to have at all.
		for (const p of threads.slice(0, 5)) expect(isArchived(p, 'order-1')).toBe(true);
	});

	it("KEN: after that refresh, the watermark still has a block time to clamp against", () => {
		// The hole this closes: `lastAdoptedAt` used to be module state, so right
		// after a refresh the watermark had nothing to clamp to and degraded to a
		// bare Date.now() — the exact bug it exists to prevent. Archiving before the
		// first sync completes is the ordinary case, not an edge case.
		localStorage.setItem('morphit.chat.folders.lastAdoptedAt', '2026-07-17T12:00:00.000Z');
		__reloadChatFolders();
		archiveThread('kentest2', 'o', BLOCK);
		const stamped = Number(localStorage.getItem('morphit.chat.folders.localChangedAt'));
		expect(stamped).toBeGreaterThanOrEqual(Date.parse('2026-07-17T12:00:00.000Z'));
	});

	it('a HUNG broadcast does not deadlock every later change', async () => {
		// The in-flight guard's failure mode if it has no way out: one request that
		// never settles, and every folder change for the rest of the session queues
		// behind it forever — silently, with the UI still showing the move. Worse
		// than the race the guard prevents, and introduced BY the guard.
		vi.useFakeTimers();
		delaysMs = [10 * 60_000, 100]; // op A hangs for ten minutes; op B is fine
		archiveThread('kentest2', 'o', BLOCK);
		await vi.advanceTimersByTimeAsync(1_600); // A departs and hangs
		archiveThread('kentest3', 'o', BLOCK);
		await vi.advanceTimersByTimeAsync(1_600); // B is queued behind A
		// The timeout must fire, release the flag, and let B out. Note what is NOT
		// claimed: a timeout releases OUR flag, it does not cancel the request —
		// the hung op may still complete server-side. Blurt's own 60s expiration
		// is the backstop there. What matters is that B ESCAPES rather than
		// queueing behind A forever, so don't advance A to completion (that models
		// a different scenario) and don't assert on ordering the client can't
		// control.
		await vi.advanceTimersByTimeAsync(40_000);
		vi.useRealTimers();
		const sawB = broadcasts.some((b) => b.includes('kentest3\u0000o'));
		expect(sawB).toBe(true);
	});

	it('overlapping broadcasts SERIALIZE — a slow op never lets an older state win', async () => {
		vi.useFakeTimers();
		// Op A is SLOW, op B would be fast — so if both are ever in flight, B lands
		// first and A's older state overwrites it. That is the on-chain
		// latest-by-block race, reproduced.
		delaysMs = [9_000, 100];
		archiveThread('kentest2', 'o', BLOCK);
		await vi.advanceTimersByTimeAsync(1_600); // op A departs with {kentest2}
		archiveThread('kentest3', 'o', BLOCK); // arrives while A is still in flight
		await vi.advanceTimersByTimeAsync(1_600);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.runOnlyPendingTimersAsync();
		vi.useRealTimers();
		// The LAST state the chain sees must be the newest one. Without the
		// in-flight guard the final write is A's stale {kentest2} and kentest3
		// silently crawls back out of Archived.
		expect(broadcasts.at(-1)).toContain('kentest2\u0000o');
		expect(broadcasts.at(-1)).toContain('kentest3\u0000o');
	});
});
