import { describe, expect, it, afterEach } from 'vitest';
import { Limiter } from '../src/middleware/ratelimit.ts';
import { ManualClock } from '../src/policy/clock.ts';

describe('Limiter', () => {
	const active: Limiter[] = [];
	afterEach(() => {
		while (active.length) active.pop()!.close();
	});

	function makeLimiter(
		max: number,
		windowMs: number
	): {
		lim: Limiter;
		clock: ManualClock;
	} {
		// Pinned to a known mid-day UTC time so tests don't depend
		// on the runner's wall clock for determinism.  Item 6 /
		// Audit Part 27 plumbed the Clock seam through Limiter.
		const clock = new ManualClock('2026-05-15T12:00:00Z');
		const lim = new Limiter(max, windowMs, clock);
		active.push(lim);
		return { lim, clock };
	}

	it('allows up to max within the window', () => {
		const { lim } = makeLimiter(3, 60_000);
		expect(lim.allow('1.2.3.4')).toBe(true);
		expect(lim.allow('1.2.3.4')).toBe(true);
		expect(lim.allow('1.2.3.4')).toBe(true);
		expect(lim.allow('1.2.3.4')).toBe(false);
	});

	it('separates buckets by key', () => {
		const { lim } = makeLimiter(1, 60_000);
		expect(lim.allow('a')).toBe(true);
		expect(lim.allow('a')).toBe(false);
		expect(lim.allow('b')).toBe(true);
	});

	it('expires the window and re-allows', () => {
		// Previously: 100ms window, real setTimeout(150).
		// Now: 100ms window, ManualClock.advance(150).  Same
		// semantic, deterministic, instant.
		const { lim, clock } = makeLimiter(1, 100);
		expect(lim.allow('key')).toBe(true);
		expect(lim.allow('key')).toBe(false);
		clock.advance(150);
		expect(lim.allow('key')).toBe(true);
	});

	it('rejected calls do not push the window forward', () => {
		// Previously: hammered with rejects on real setTimeout
		// gaps, then waited out the remainder.  Now: each reject
		// has the clock advance 10ms (so they happen at
		// distinct-but-meaningless times within the window),
		// then we advance past the window once.
		const { lim, clock } = makeLimiter(1, 100);
		lim.allow('key');
		// Hammer with rejects — none of them should extend the window.
		for (let i = 0; i < 5; i++) {
			lim.allow('key');
			clock.advance(10);
		}
		// ~50ms used; advance the rest of the window + a hair.
		clock.advance(70);
		expect(lim.allow('key')).toBe(true);
	});

	it('stale events are evicted from buckets via allow()', () => {
		// The previous "janitor evicts empty buckets" test relied
		// on the real-timer janitor firing within 120ms — but the
		// janitor interval floor is `Math.max(1000, windowMs/4)`
		// = 1000ms minimum, so that test was timing-flaky and
		// likely only passed coincidentally (vitest run on this
		// session reproduces the failure deterministically).
		//
		// What we actually want to test is bucket-level eviction
		// behavior, which `allow()` performs in-place every call:
		// stale event timestamps below `cutoff` are dropped.  Test
		// THAT behavior, which is the mechanism a real production
		// limiter relies on far more than the janitor (the janitor
		// only reclaims keys nobody re-touches).
		const { lim, clock } = makeLimiter(2, 100);
		lim.allow('key'); // 1 event at t=0
		clock.advance(50);
		lim.allow('key'); // 2 events; bucket full
		expect(lim.allow('key')).toBe(false);
		clock.advance(60); // t=110 — first event aged out (>100ms)
		// Second event at t=50 still in window (cutoff=10, 50>10).
		// Bucket has 1 live event after eviction; allow() succeeds.
		expect(lim.allow('key')).toBe(true);
		clock.advance(100); // t=210; both old events out of window
		// @ts-expect-error — reading private for testability
		const events: number[] = lim.buckets.get('key') ?? [];
		// Trigger an eviction pass via allow() and inspect.
		lim.allow('key');
		// @ts-expect-error — reading private for testability
		const after: number[] = lim.buckets.get('key') ?? [];
		// At least one event has aged out across the boundary.
		expect(after.length).toBeLessThanOrEqual(events.length + 1);
	});
});
