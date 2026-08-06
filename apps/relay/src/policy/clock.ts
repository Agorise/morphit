/**
 * Morphit relay — clock interface for time injection
 * (Item 6, Audit Part 26).
 *
 * Modules that consult the wall clock (drain-defense ceiling,
 * rate limiter, invite token TTL, altcha challenge expiry)
 * accept an optional `Clock` in their constructor.  Production
 * defaults to `defaultClock` which reads `Date.now()` directly.
 * Tests pass a manual clock that returns deterministic
 * timestamps, eliminating the wall-clock-dependency that
 * caused the drain-defense-live-fire UTC midnight flake
 * (Part 25).
 *
 * Why an interface and not just a function: the policy modules
 * also occasionally need a `Date` object (for hour-of-day
 * arithmetic in `GlobalDailyCeiling.recordSuccess`).  An
 * interface lets us provide both `now()` (millis since epoch)
 * and `nowAsDate()` (Date object) without forcing every caller
 * to pass two callbacks.
 *
 * Usage:
 *
 *   // Production:
 *   new GlobalDailyCeiling(50)  // implicit defaultClock
 *
 *   // Test:
 *   const clock = new ManualClock('2026-05-03T12:00:00Z');
 *   const c = new GlobalDailyCeiling(50, undefined, undefined, clock);
 *   c.recordSuccess();
 *   clock.advance(60_000);  // advance 1 minute
 *   // ... assertions
 */

/** A clock abstraction.  Production uses `defaultClock`; tests
 *  pass a manual implementation that returns deterministic
 *  values. */
export interface Clock {
	/** Current time as milliseconds since epoch.  Equivalent to
	 *  `Date.now()` in the default implementation. */
	now(): number;
	/** Current time as a Date object.  Equivalent to `new Date()`
	 *  in the default implementation. */
	nowAsDate(): Date;
}

/** The production clock.  Reads from the underlying system. */
export const defaultClock: Clock = {
	now: () => Date.now(),
	nowAsDate: () => new Date()
};

/** A manually-controllable clock for tests.  Construct with a
 *  starting timestamp (number of millis or a Date or an ISO
 *  string) and use `advance()` / `set()` to step forward. */
export class ManualClock implements Clock {
	private currentMs: number;

	constructor(start: number | Date | string) {
		if (typeof start === 'number') {
			this.currentMs = start;
		} else if (start instanceof Date) {
			this.currentMs = start.getTime();
		} else {
			this.currentMs = new Date(start).getTime();
		}
	}

	now(): number {
		return this.currentMs;
	}

	nowAsDate(): Date {
		return new Date(this.currentMs);
	}

	/** Advance the clock by `deltaMs` milliseconds. */
	advance(deltaMs: number): void {
		this.currentMs += deltaMs;
	}

	/** Hard-set the clock to a specific time. */
	set(t: number | Date | string): void {
		if (typeof t === 'number') {
			this.currentMs = t;
		} else if (t instanceof Date) {
			this.currentMs = t.getTime();
		} else {
			this.currentMs = new Date(t).getTime();
		}
	}
}
