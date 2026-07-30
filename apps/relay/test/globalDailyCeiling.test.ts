import { describe, expect, it, vi, afterEach } from 'vitest';

import { GlobalDailyCeiling, type CeilingReachedAlert } from '../src/policy/globalDailyCeiling.ts';
import { ManualClock } from '../src/policy/clock.ts';

describe('GlobalDailyCeiling', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('canAccept returns true while below ceiling, false once hit', () => {
		const c = new GlobalDailyCeiling(3);
		expect(c.canAccept()).toBe(true);
		c.recordSuccess();
		c.recordSuccess();
		expect(c.canAccept()).toBe(true);
		c.recordSuccess();
		expect(c.canAccept()).toBe(false);
	});

	it('only recordSuccess increments the counter — canAccept does not', () => {
		const c = new GlobalDailyCeiling(2);
		// Probing canAccept() 100 times without recording must
		// not burn the quota. This matters because every request
		// calls canAccept() as a pre-check.
		for (let i = 0; i < 100; i++) c.canAccept();
		expect(c.currentCount()).toBe(0);
		expect(c.remainingToday()).toBe(2);
	});

	it('fires CEILING_REACHED exactly once per day', () => {
		const alerts: CeilingReachedAlert[] = [];
		const c = new GlobalDailyCeiling(2, (a) => alerts.push(a));

		c.recordSuccess();
		expect(alerts).toHaveLength(0);

		// The scan that crosses the threshold fires the alert.
		c.recordSuccess();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.kind).toBe('CEILING_REACHED');
		expect(alerts[0]!.ceiling).toBe(2);

		// Further recordSuccess calls in the same day do NOT fire
		// a second alert — operators don't want 100 pages for the
		// same incident.
		c.recordSuccess();
		c.recordSuccess();
		expect(alerts).toHaveLength(1);
	});

	it('UTC midnight rollover resets count and re-arms the alert', () => {
		// Item 6 / Audit Part 27: ManualClock replaces
		// vi.useFakeTimers + vi.setSystemTime.  The ceiling's
		// view of time is faked explicitly via the injected
		// clock; the global system clock is left alone.
		const clock = new ManualClock('2026-04-24T23:00:00Z');

		const alerts: CeilingReachedAlert[] = [];
		const c = new GlobalDailyCeiling(1, (a) => alerts.push(a), null, clock);

		c.recordSuccess();
		expect(alerts).toHaveLength(1); // fired (crossed 1/1)
		expect(c.canAccept()).toBe(false);

		// Cross UTC midnight.
		clock.set('2026-04-25T00:30:00Z');

		// New day → counter reset, canAccept flips true, alert
		// re-armed for the new day.
		expect(c.canAccept()).toBe(true);
		expect(c.currentCount()).toBe(0);

		c.recordSuccess();
		expect(alerts).toHaveLength(2); // fresh alert for the new day
		expect(alerts[1]!.kind).toBe('CEILING_REACHED');
	});

	it('remainingToday is clamped at 0 past the ceiling', () => {
		const c = new GlobalDailyCeiling(2);
		c.recordSuccess();
		expect(c.remainingToday()).toBe(1);
		c.recordSuccess();
		expect(c.remainingToday()).toBe(0);
		c.recordSuccess();
		// Even if a bug lets us over-count, remainingToday never
		// goes negative.
		expect(c.remainingToday()).toBe(0);
	});

	it('resetsAt returns a Date at the next UTC midnight', () => {
		const clock = new ManualClock('2026-04-24T15:30:00Z');

		const c = new GlobalDailyCeiling(10, undefined, null, clock);
		const resets = c.resetsAt();
		expect(resets.toISOString()).toBe('2026-04-25T00:00:00.000Z');
	});

	it('hourly peak tracking: currentHourCount + peakHourCount', () => {
		const clock = new ManualClock('2026-04-24T10:00:00Z');

		const c = new GlobalDailyCeiling(1000, undefined, null, clock);

		// Hour 10: 3 signups
		c.recordSuccess();
		c.recordSuccess();
		c.recordSuccess();
		expect(c.currentHourCount()).toBe(3);
		expect(c.peakHourCount()).toBe(3);

		// Roll to hour 11.
		clock.set('2026-04-24T11:15:00Z');
		expect(c.currentHourCount()).toBe(0); // new hour, fresh tally
		expect(c.peakHourCount()).toBe(3); // day-wide peak retained

		// Hour 11: 1 signup
		c.recordSuccess();
		expect(c.currentHourCount()).toBe(1);
		expect(c.peakHourCount()).toBe(3);

		// Roll to hour 12, big spike.
		clock.set('2026-04-24T12:05:00Z');
		for (let i = 0; i < 10; i++) c.recordSuccess();
		expect(c.currentHourCount()).toBe(10);
		expect(c.peakHourCount()).toBe(10); // new peak
	});

	it('default sink logs but does not throw', () => {
		// With no custom sink, recordSuccess should still work —
		// the default sink uses the logger. We can't easily assert
		// on log output here, but we can assert no throw.
		const c = new GlobalDailyCeiling(1);
		expect(() => {
			c.recordSuccess();
			c.recordSuccess();
		}).not.toThrow();
	});

	// Audit fix (this turn): tryReserve()/releaseReservation()
	// close the TOCTOU race where concurrent /v1/account/create
	// requests could overshoot the daily ceiling.

	it('tryReserve: returns true while below ceiling, false once at cap', () => {
		const c = new GlobalDailyCeiling(3);
		expect(c.tryReserve()).toBe(true);
		expect(c.tryReserve()).toBe(true);
		expect(c.tryReserve()).toBe(true);
		// At cap: count(0) + reservedCount(3) === ceiling(3)
		expect(c.tryReserve()).toBe(false);
	});

	it('tryReserve+recordSuccess: reservation finalizes into count', () => {
		const c = new GlobalDailyCeiling(2);
		expect(c.tryReserve()).toBe(true);
		expect(c.currentCount()).toBe(0);
		// recordSuccess converts the reservation to a real count.
		c.recordSuccess();
		expect(c.currentCount()).toBe(1);
		// Reservation slot freed; can reserve again.
		expect(c.tryReserve()).toBe(true);
	});

	it('tryReserve+release: reservation does NOT survive failure', () => {
		const c = new GlobalDailyCeiling(2);
		expect(c.tryReserve()).toBe(true);
		expect(c.tryReserve()).toBe(true);
		// Both reserved; ceiling is now reservation-blocked.
		expect(c.tryReserve()).toBe(false);
		// Release one — slot is now free again.
		c.releaseReservation();
		expect(c.tryReserve()).toBe(true);
	});

	it('races bound: count + reservedCount cannot exceed ceiling', () => {
		// Concurrent-request simulation: 5 calls to tryReserve when
		// ceiling is 3.  Only 3 should succeed; the next 2 should
		// fail.
		const c = new GlobalDailyCeiling(3);
		const results: boolean[] = [];
		for (let i = 0; i < 5; i++) {
			results.push(c.tryReserve());
		}
		const succeeded = results.filter((r) => r).length;
		expect(succeeded).toBe(3);
		expect(results.filter((r) => !r).length).toBe(2);
		// Even after recording all three as successful, the count
		// matches exactly the ceiling — no overshoot.
		c.recordSuccess();
		c.recordSuccess();
		c.recordSuccess();
		expect(c.currentCount()).toBe(3);
	});

	it('release does not decrement below zero', () => {
		const c = new GlobalDailyCeiling(2);
		// Release without prior reserve — should be a no-op, not
		// a negative count or throw.
		expect(() => {
			c.releaseReservation();
			c.releaseReservation();
		}).not.toThrow();
		// State should be clean.
		expect(c.currentCount()).toBe(0);
		expect(c.canAccept()).toBe(true);
	});
});
