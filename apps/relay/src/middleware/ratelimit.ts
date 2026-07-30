/**
 * Morphit relay — per-key sliding-window rate limiter.
 *
 * Entirely in-memory. A process restart resets every bucket. This
 * matches Plan v1.3's privacy commitment that no IP address is ever
 * persisted to disk. The cost is that an attacker who can trigger a
 * relay restart (crash, deploy, etc.) gets a fresh bucket — we accept
 * this over the alternative of file-backed or Redis-backed state,
 * which would be a worse privacy posture.
 *
 * Time source: `Date.now()` via the injectable `Clock` parameter.
 * Production passes the default clock (real wall-time); tests pass
 * a `ManualClock` for deterministic time-window assertions.
 */

import { defaultClock, type Clock } from '../policy/clock.ts';

export class Limiter {
	private readonly max: number;
	private readonly windowMs: number;
	private readonly clock: Clock;
	private readonly buckets = new Map<string, number[]>();
	private janitor: NodeJS.Timeout | null = null;

	constructor(max: number, windowMs: number, clock: Clock = defaultClock) {
		this.max = max;
		this.windowMs = windowMs;
		this.clock = clock;
		// Evict empty buckets periodically so memory stays O(active IPs
		// in window) rather than O(every IP we've ever seen).
		const interval = Math.max(1000, Math.floor(windowMs / 4));
		this.janitor = setInterval(() => this.sweep(), interval);
		// Don't keep the event loop alive solely for the janitor.
		this.janitor.unref?.();
	}

	/**
	 * Try to record an event under `key`. Returns true if allowed,
	 * false if the key has already used its quota in the current
	 * window. Rejected calls do NOT push the window forward — a
	 * caller hammering the endpoint can't extend their own lockout.
	 */
	allow(key: string): boolean {
		const now = this.clock.now();
		const cutoff = now - this.windowMs;

		let events = this.buckets.get(key);
		if (!events) {
			events = [];
			this.buckets.set(key, events);
		}
		// Evict stale events in-place.
		let n = 0;
		for (const t of events) {
			if (t > cutoff) events[n++] = t;
		}
		events.length = n;

		if (events.length >= this.max) return false;
		events.push(now);
		return true;
	}

	/**
	 * Like `allow()`, but ALSO requires that the most-recent event
	 * under `key` was at least `minGapMs` ago. Lets us express
	 * "2/day but not both within the same hour" as a single
	 * call with a sensible error breakdown.
	 *
	 * Returns a discriminated result:
	 *   - `{ allowed: true }`              — event recorded
	 *   - `{ allowed: false, reason: 'quota_exhausted' }`
	 *                                      — hit the per-window max
	 *   - `{ allowed: false, reason: 'spacing', retryAfterMs: N }`
	 *                                      — under max but too soon
	 *                                        after the previous event
	 *
	 * Never records a rejected event (the window never pushes forward
	 * for a caller who's over-quota or still in cooldown).
	 */
	allowWithSpacing(
		key: string,
		minGapMs: number
	):
		| { allowed: true }
		| { allowed: false; reason: 'quota_exhausted' }
		| { allowed: false; reason: 'spacing'; retryAfterMs: number } {
		const decision = this.peekWithSpacing(key, minGapMs);
		if (decision.allowed) {
			this.commit(key);
		}
		return decision;
	}

	/**
	 * Check what `allowWithSpacing` would return WITHOUT consuming
	 * a slot.  Pair with `commit(key)` only after the downstream
	 * work (e.g. chain broadcast) has actually succeeded — so a
	 * legitimate user whose chosen username is taken doesn't burn
	 * their daily quota on a no-op.  See `commit` doc.
	 *
	 * Same return shape as `allowWithSpacing`.  Equivalent to:
	 *
	 *   const d = peekWithSpacing(...);
	 *   if (d.allowed) commit(key);
	 *
	 * but split so the caller can interleave non-trivial work (a
	 * chain availability lookup, a broadcast) between the two.
	 */
	peekWithSpacing(
		key: string,
		minGapMs: number
	):
		| { allowed: true }
		| { allowed: false; reason: 'quota_exhausted' }
		| { allowed: false; reason: 'spacing'; retryAfterMs: number } {
		const now = this.clock.now();
		const cutoff = now - this.windowMs;

		const events = this.buckets.get(key) ?? [];
		// Evict stale events for the count check (don't mutate the
		// stored array — caller might never commit, and even if they
		// do, commit() does its own eviction).
		let livecount = 0;
		let lastLive = -1;
		for (const t of events) {
			if (t > cutoff) {
				livecount++;
				if (t > lastLive) lastLive = t;
			}
		}

		if (livecount >= this.max) {
			return { allowed: false, reason: 'quota_exhausted' };
		}

		if (lastLive >= 0) {
			const elapsed = now - lastLive;
			if (elapsed < minGapMs) {
				return {
					allowed: false,
					reason: 'spacing',
					retryAfterMs: minGapMs - elapsed
				};
			}
		}

		return { allowed: true };
	}

	/**
	 * Same as `peekWithSpacing` but without the spacing check —
	 * pure quota-only peek.  Pair with `commit(key)` after
	 * downstream work succeeds.
	 */
	peek(key: string): boolean {
		const now = this.clock.now();
		const cutoff = now - this.windowMs;
		const events = this.buckets.get(key) ?? [];
		let livecount = 0;
		for (const t of events) {
			if (t > cutoff) livecount++;
		}
		return livecount < this.max;
	}

	/**
	 * Record an event under `key` at the current time.  Use this
	 * after a `peek()` / `peekWithSpacing()` returned `allowed: true`
	 * AND the downstream work (typically a chain broadcast) actually
	 * happened — so legitimate users whose work fails for a reason
	 * that doesn't consume a "real" slot (e.g. their chosen username
	 * is already taken on Blurt) don't burn quota on the failed
	 * attempt.
	 *
	 * Always pushes a fresh event; performs eviction of stale events
	 * as a side effect to keep the bucket bounded.
	 */
	commit(key: string): void {
		const now = this.clock.now();
		const cutoff = now - this.windowMs;
		let events = this.buckets.get(key);
		if (!events) {
			events = [];
			this.buckets.set(key, events);
		}
		// Evict stale events in-place.
		let n = 0;
		for (const t of events) {
			if (t > cutoff) events[n++] = t;
		}
		events.length = n;
		events.push(now);
	}

	/** Stop the janitor. Call on graceful shutdown. */
	close(): void {
		if (this.janitor) {
			clearInterval(this.janitor);
			this.janitor = null;
		}
	}

	private sweep(): void {
		const cutoff = this.clock.now() - this.windowMs;
		for (const [key, events] of this.buckets) {
			// Keep the bucket if at least one event is still in-window.
			let alive = false;
			for (const t of events) {
				if (t > cutoff) {
					alive = true;
					break;
				}
			}
			if (!alive) this.buckets.delete(key);
		}
	}
}
