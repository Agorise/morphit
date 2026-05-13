/**
 * Morphit relay — global daily signup ceiling.
 *
 * A hard cap on the total number of successful account creations
 * this relay will process per UTC day. Complements per-IP rate
 * limiting: even if attackers distribute load across many IPs,
 * they cannot drain more than `ceiling` signups × chain fee
 * from the relay in one day.
 *
 * Semantics:
 *   - The counter resets at UTC midnight. Not a rolling 24h
 *     window — simpler mental model for operators.
 *   - Only SUCCESSFUL signups count. A rejected request does
 *     not burn the ceiling, so a broken client retrying on
 *     errors doesn't accidentally exhaust it.
 *   - When the counter reaches `ceiling`, further signups
 *     return `daily_ceiling_reached` until the next UTC
 *     midnight rollover.
 *   - An optional alertSink is invoked EXACTLY ONCE per day
 *     when the ceiling is hit. The sink is the operator's hook
 *     for sending "signups paused for today — investigate?"
 *     notifications via Discord/email/webhook/etc.
 *
 * Persistence: opt-in (Audit 2026-05 Finding 5-4 hardening).
 * Pass a `persistPath` to the constructor and the bucket counter
 * survives relay restarts. Without persistPath, the counter is
 * pure in-memory and resets on every restart (the historical
 * behavior). The persistence file holds AGGREGATE counts only —
 * no IP addresses, no per-user data, no signup metadata. Format
 * is a tiny JSON object: `{date: "YYYY-MM-DD", count: N,
 * hourlyCounts: [24 ints]}`. Privacy-equivalent to "this relay
 * has processed N signups today, distributed across these hours."
 */

import { logger } from '$log';
import {
	existsSync,
	readFileSync,
	writeFileSync,
	chmodSync,
	mkdirSync,
	openSync,
	fsyncSync,
	closeSync,
	renameSync
} from 'node:fs';
import { dirname } from 'node:path';
import { defaultClock, type Clock } from './clock.ts';

const log = logger('signup-ceiling');

/** Structured alert emitted when the ceiling is hit. Shape is
 *  deliberately JSON-serializable so webhook sinks can forward
 *  it without transformation. */
export interface CeilingReachedAlert {
	kind: 'CEILING_REACHED';
	ceiling: number;
	at: Date;
	/** UTC midnight when counter next resets. Gives the operator
	 *  a concrete "signups resume at" timestamp. */
	resets_at: Date;
}

export type CeilingAlertSink = (alert: CeilingReachedAlert) => void;

function defaultSink(alert: CeilingReachedAlert): void {
	log.error('ceiling_reached', {
		ceiling: alert.ceiling,
		reached_at: alert.at.toISOString(),
		resets_at: alert.resets_at.toISOString()
	});
}

/** Next UTC-midnight boundary as a Date. */
function nextUtcMidnight(from: Date = new Date()): Date {
	const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1));
	return d;
}

/** Current UTC date as YYYY-MM-DD (used as the bucket key so a
 *  clock-adjustment doesn't spuriously reset or double-count). */
function utcDateKey(from: Date = new Date()): string {
	const y = from.getUTCFullYear();
	const m = String(from.getUTCMonth() + 1).padStart(2, '0');
	const d = String(from.getUTCDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

export class GlobalDailyCeiling {
	private bucketDate: string;
	private count = 0;
	/** In-flight reservation count.  Audit fix (this turn): without
	 *  this, two concurrent /v1/account/create requests both call
	 *  canAccept() (returns true), both proceed past validation,
	 *  both broadcast, both call recordSuccess() — count overshoots
	 *  ceiling by the number of concurrent requests.  Bounded per-IP
	 *  by dailyLimiter, but a botnet across N IPs makes the
	 *  overshoot proportional to N.  The fix: reservedCount tracks
	 *  in-flight signups; canAccept() and tryReserve() both check
	 *  count + reservedCount < ceiling.  Successful broadcast moves
	 *  the reservation into count via recordSuccess(); failed
	 *  broadcast frees it via releaseReservation(). */
	private reservedCount = 0;
	/** Per-hour counts within the current bucket — used by the
	 *  anomaly detector to answer "is this hour unusually busy?"
	 *  Keyed by UTC hour (0-23). Reset alongside the main
	 *  counter at midnight. */
	private hourlyCounts: number[] = new Array(24).fill(0);
	private alertFiredToday = false;
	/** Optional persistence path (Finding 5-4 hardening). When set,
	 *  the bucket counter is read at construction and rewritten on
	 *  every recordSuccess() so the count survives relay restarts.
	 *  When null, behaves as the pure-in-memory historical version. */
	private readonly persistPath: string | null;
	/** Time source.  Production uses defaultClock (real wall time);
	 *  tests pass a ManualClock for deterministic UTC-rollover
	 *  assertions, eliminating the midnight race that motivated
	 *  the drain-defense-live-fire 90-second guard in Part 25. */
	private readonly clock: Clock;

	constructor(
		private readonly ceiling: number,
		private readonly alertSink: CeilingAlertSink = defaultSink,
		persistPath: string | null = null,
		clock: Clock = defaultClock
	) {
		this.clock = clock;
		this.bucketDate = utcDateKey(this.clock.nowAsDate());
		this.persistPath = persistPath;
		this.loadFromDisk();
	}

	/** Read persisted state at boot. Silent on missing file (first
	 *  boot or persistence disabled). Logs and continues on
	 *  malformed file (defense-in-depth: a bad persistence file
	 *  shouldn't crash the relay). */
	private loadFromDisk(): void {
		if (this.persistPath === null) return;
		if (!existsSync(this.persistPath)) return;
		try {
			const raw = readFileSync(this.persistPath, 'utf-8');
			const parsed = JSON.parse(raw) as {
				date?: unknown;
				count?: unknown;
				hourlyCounts?: unknown;
			};
			if (
				typeof parsed.date !== 'string' ||
				typeof parsed.count !== 'number' ||
				!Array.isArray(parsed.hourlyCounts) ||
				parsed.hourlyCounts.length !== 24 ||
				!parsed.hourlyCounts.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
			) {
				log.warn('persisted_state_malformed', { path: this.persistPath });
				return;
			}
			// If the persisted bucket is from a previous UTC day, the
			// rollover guard will reset on next maybeRollover() call.
			// We trust the persisted count up to that point.
			if (parsed.date === utcDateKey(this.clock.nowAsDate())) {
				this.bucketDate = parsed.date;
				this.count = Math.max(0, Math.floor(parsed.count));
				this.hourlyCounts = parsed.hourlyCounts.map((n) => Math.max(0, Math.floor(n as number)));
				log.info('loaded_persisted_state', {
					date: parsed.date,
					count: this.count
				});
			} else {
				log.info('persisted_state_stale', {
					persisted_date: parsed.date,
					today: utcDateKey(this.clock.nowAsDate())
				});
			}
		} catch (err) {
			log.warn('persisted_state_read_failed', { path: this.persistPath }, err);
		}
	}

	/** Write current state atomically (tmp + fsync + rename).
	 *  Best-effort: persistence failure is logged but doesn't
	 *  block the signup flow. The counter is still correct in
	 *  memory; we just lose the cross-restart guarantee for any
	 *  signup we fail to persist. */
	private saveToDisk(): void {
		if (this.persistPath === null) return;
		const payload = {
			date: this.bucketDate,
			count: this.count,
			hourlyCounts: this.hourlyCounts
		};
		const tmpPath = `${this.persistPath}.tmp`;
		try {
			mkdirSync(dirname(this.persistPath), { recursive: true });
			writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
			chmodSync(tmpPath, 0o600);
			// fsync the tmp file before rename for crash-safety.
			try {
				const fd = openSync(tmpPath, 'r');
				try {
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
			} catch {
				// fsync failure is non-fatal on filesystems that don't
				// honor it (some FUSE/network FS). Proceed with rename.
			}
			renameSync(tmpPath, this.persistPath);
		} catch (err) {
			log.warn('persist_failed', { path: this.persistPath }, err);
		}
	}

	/** Roll over the bucket if we've crossed UTC midnight since
	 *  the last check. Called at the top of every public method
	 *  so readers and writers agree on which day they're in. */
	private maybeRollover(): void {
		const today = utcDateKey(this.clock.nowAsDate());
		if (today !== this.bucketDate) {
			this.bucketDate = today;
			this.count = 0;
			this.hourlyCounts = new Array(24).fill(0);
			this.alertFiredToday = false;
			// Deliberately do NOT reset reservedCount across the
			// rollover.  In-flight signups from yesterday will
			// complete against today's bucket via recordSuccess()
			// (which decrements reservedCount).  If we cleared it
			// here, those completions would skip the decrement,
			// permanently leaking a slot.  Worst case: an in-flight
			// signup straddling midnight uses a reservation that
			// nominally belonged to yesterday but consumes today's
			// budget — slightly imprecise accounting but safer than
			// the alternative.
			log.info('ceiling_rollover', { new_bucket: today });
			// Persist the rollover so a restart immediately after
			// midnight doesn't read a stale yesterday-bucket.
			this.saveToDisk();
		}
	}

	/**
	 * Can the relay accept another signup right now?
	 * Call this BEFORE processing (so a pre-check can reject
	 * without burning resources on validation/chain work).
	 *
	 * Returns true iff `count + reservedCount < ceiling` — i.e.,
	 * even accounting for in-flight signups that haven't completed
	 * yet, there's room for one more.
	 */
	canAccept(): boolean {
		this.maybeRollover();
		return this.count + this.reservedCount < this.ceiling;
	}

	/**
	 * Tentatively reserve a slot for a signup that's about to
	 * begin processing.  Returns true on success (and the caller
	 * MUST eventually call recordSuccess() or releaseReservation()
	 * to balance the reservation), false if at the cap.
	 *
	 * Audit fix (this turn): closes a TOCTOU race where concurrent
	 * /v1/account/create requests from N different IPs could each
	 * call canAccept() (returning true) when count was at
	 * ceiling-1, all proceed, and the ceiling overshoots by N-1.
	 * tryReserve() does the canAccept-then-increment atomically
	 * (synchronously, in JS's single-threaded model) so the
	 * (N-1)-th concurrent caller sees count + reservedCount ===
	 * ceiling and is rejected.
	 */
	tryReserve(): boolean {
		this.maybeRollover();
		if (this.count + this.reservedCount >= this.ceiling) {
			return false;
		}
		this.reservedCount++;
		return true;
	}

	/**
	 * Release a reservation that was made via tryReserve() but
	 * whose downstream work failed (validation rejected, chain
	 * broadcast failed, etc.).  Idempotent-ish: refuses to
	 * decrement below zero (defensive — the only safe failure
	 * is a duplicate release call, which we silently absorb
	 * rather than crash the request handler).
	 */
	releaseReservation(): void {
		if (this.reservedCount > 0) {
			this.reservedCount--;
		}
	}

	/**
	 * Record a successful signup. Call this AFTER the chain
	 * broadcast has succeeded. Fires the CEILING_REACHED alert
	 * on the scan that crosses the threshold (once per day).
	 *
	 * Atomically converts a tentative reservation (made via
	 * tryReserve()) into a finalized count.  Callers that already
	 * called tryReserve() must call recordSuccess() OR
	 * releaseReservation(), never both, so the reservation is
	 * balanced exactly once.
	 *
	 * For backwards compatibility with callers that don't use
	 * the reserve/release pattern (none currently in-tree, but
	 * preserving the historical contract): if reservedCount is
	 * 0 at call time, this is treated as a "direct" success
	 * recording without prior reservation.
	 */
	recordSuccess(): void {
		this.maybeRollover();
		this.count++;
		if (this.reservedCount > 0) {
			this.reservedCount--;
		}
		const hour = this.clock.nowAsDate().getUTCHours();
		this.hourlyCounts[hour] = (this.hourlyCounts[hour] ?? 0) + 1;

		if (this.count >= this.ceiling && !this.alertFiredToday) {
			this.alertFiredToday = true;
			this.alertSink({
				kind: 'CEILING_REACHED',
				ceiling: this.ceiling,
				at: this.clock.nowAsDate(),
				resets_at: nextUtcMidnight(this.clock.nowAsDate())
			});
		}
		// Persist after each success so a restart can't reset
		// today's count back to zero. Synchronous on the success
		// path; the file is small (~150 bytes) so write latency
		// is negligible compared to the chain broadcast we just
		// completed.
		this.saveToDisk();
	}

	/** Current successful-signup count in today's bucket. */
	currentCount(): number {
		this.maybeRollover();
		return this.count;
	}

	/** Remaining headroom today. Returns 0 if at or past ceiling. */
	remainingToday(): number {
		this.maybeRollover();
		return Math.max(0, this.ceiling - this.count);
	}

	/** Signup count in the current UTC hour. Used by the anomaly
	 *  detector to spot drain-in-progress patterns. */
	currentHourCount(): number {
		this.maybeRollover();
		const hour = this.clock.nowAsDate().getUTCHours();
		return this.hourlyCounts[hour] ?? 0;
	}

	/** Peak per-hour count in today's bucket so far. Used to
	 *  distinguish "unusually busy hour" from "relay having a
	 *  normal busy day." */
	peakHourCount(): number {
		this.maybeRollover();
		let peak = 0;
		for (const n of this.hourlyCounts) {
			if (n > peak) peak = n;
		}
		return peak;
	}

	/** Peak per-hour count EXCLUDING the current hour.  The
	 *  anomaly probe wants to compare "this hour's count" against
	 *  the previous busy hour, not against itself.  Without this
	 *  helper, a spike that BECOMES the peak (e.g. attacker
	 *  drains 30 signups in one hour, the day's prior peak was
	 *  4) leaves the probe's threshold-2 ("current ≥ 2× peak")
	 *  structurally unreachable: current is now the peak, so the
	 *  inequality fails.  See Finding N22. */
	peakHourCountExcludingCurrent(): number {
		this.maybeRollover();
		const currentHour = this.clock.nowAsDate().getUTCHours();
		let peak = 0;
		for (let h = 0; h < this.hourlyCounts.length; h++) {
			if (h === currentHour) continue;
			const n = this.hourlyCounts[h] ?? 0;
			if (n > peak) peak = n;
		}
		return peak;
	}

	/** Next UTC midnight — exposed so the handler can tell the
	 *  user exactly when signups resume. */
	resetsAt(): Date {
		return nextUtcMidnight(this.clock.nowAsDate());
	}

	getCeiling(): number {
		return this.ceiling;
	}
}
