/**
 * Tabs without Web Locks (plain-http pages) share localStorage, but a write in
 * one tab reaches the others only after a delay. These tests model exactly
 * that — every tab has its own view of the storage, and each write reaches
 * the other views `lag` ms later — and count how often the check runs. Time
 * is simulated (fake timers), so the outcome never depends on machine load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onceAcrossTabs, type ClaimStorage } from './onceAcrossTabs';

const CLAIM = 'test.claim';
const RESULT = 'test.result';
/** How long the check itself takes (simulated time). */
const RUN_MS = 60;

/** One browser: a storage view per tab, writes propagated after `lag` ms. */
function browser(lag: number) {
	const views: Map<string, string>[] = [];
	let runs = 0;
	function propagate(from: Map<string, string>, apply: (m: Map<string, string>) => void): void {
		apply(from);
		for (const v of views) if (v !== from) setTimeout(() => apply(v), lag);
	}
	function tab(opts: { settleMs?: number } = {}) {
		const view = new Map<string, string>();
		// A tab opened later starts with what has already arrived.
		if (views.length > 0) for (const [k, v] of views[0]!) view.set(k, v);
		views.push(view);
		const storage: ClaimStorage = {
			getItem: (k) => view.get(k) ?? null,
			setItem: (k, v) => propagate(view, (m) => void m.set(k, v)),
			removeItem: (k) => propagate(view, (m) => void m.delete(k)),
			keys: () => [...view.keys()]
		};
		return () =>
			onceAcrossTabs<string>({
				name: 'test',
				claimKey: CLAIM,
				locks: null,
				storage,
				peek: () => view.get(RESULT) ?? null,
				run: async () => {
					runs += 1;
					await new Promise((r) => setTimeout(r, RUN_MS));
					storage.setItem(RESULT, 'checked');
					return 'checked';
				},
				pollMs: 20,
				settleMs: opts.settleMs ?? 150,
				claimTtlMs: 5_000
			});
	}
	return {
		tab,
		runs: () => runs,
		seed: (k: string, v: string) => views.forEach((m) => m.set(k, v))
	};
}

const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('one check per browser without Web Locks', () => {
	it('two tabs that start before either sees the other run the check once', async () => {
		const b = browser(40);
		const [tabA, tabC] = [b.tab(), b.tab()]; // both open; neither has run yet
		const a = tabA();
		await elapse(5);
		const c = tabC();
		await elapse(6_000);
		expect(await Promise.all([a, c])).toEqual(['checked', 'checked']);
		expect(b.runs()).toBe(1);
	});

	it('three tabs started in the same instant run the check once', async () => {
		const b = browser(30);
		const tabs = [b.tab(), b.tab(), b.tab()].map((t) => t());
		await elapse(6_000);
		expect(await Promise.all(tabs)).toEqual(['checked', 'checked', 'checked']);
		expect(b.runs()).toBe(1);
	});

	it("a tab opened after another's claim arrived waits for its result", async () => {
		const b = browser(10);
		const first = b.tab()();
		await elapse(30);
		const second = b.tab()();
		await elapse(6_000);
		expect(await Promise.all([first, second])).toEqual(['checked', 'checked']);
		expect(b.runs()).toBe(1);
	});

	it('a claim left by a closed tab expires; the check then runs once', async () => {
		const b = browser(10);
		b.seed(`${CLAIM}.closedtab`, String(Date.now() - 4_950));
		const tabs = [b.tab(), b.tab()].map((t) => t());
		await elapse(6_000);
		expect(await Promise.all(tabs)).toEqual(['checked', 'checked']);
		expect(b.runs()).toBe(1);
	});
});
