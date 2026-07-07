/**
 * Morphit — chain-vs-local clock drift checker.
 *
 * Pure function.  Given the chain's reported head_block_time
 * and the local wall clock at "the same moment" (immediately
 * after the RPC returned), classify the drift severity.
 *
 * Why this matters:
 *
 *   Morphit doesn't need atomic-clock precision.  The Blurt
 *   chain provides its own time via head_block_time, and
 *   transactions are expired from THAT timeline (60s after head
 *   block) — local clock drift doesn't directly change tx
 *   validity.
 *
 *   But local time DOES matter for:
 *     - Postgres timestamp columns (indexer writes events with
 *       local clock)
 *     - Rate-limit UTC-day bucketing (relay's per-IP signups)
 *     - Operator monitoring ("no progress in N seconds")
 *     - Frontend cookie/session expiration (browser clock,
 *       different concern but same shape)
 *
 *   Drift over a few seconds is harmless.  Drift over a
 *   minute breaks bucketing and confuses ops dashboards.  Drift
 *   over an hour means the OS isn't syncing time and the
 *   operator should fix that — running Morphit in that state
 *   is asking for confusion.
 *
 * We don't attempt to fix the clock from within Morphit —
 * that's systemd-timesyncd's / chrony's / ntpd's job, and they
 * do it well.  We just check on startup and warn loudly when
 * local clock is wrong.
 *
 * The check runs at relay AND indexer boot.  We don't run it
 * in a recurring loop — the OS time service handles ongoing
 * sync, and a process that booted with synced time stays
 * roughly synced unless something is very wrong.
 */

/** Drift severity classification. */
export type DriftSeverity = 'ok' | 'warn' | 'fatal';

export interface DriftCheckResult {
	readonly severity: DriftSeverity;
	readonly localMs: number;
	readonly chainMs: number;
	/** Local minus chain.  Positive = local clock is ahead;
	 *  negative = local is behind. */
	readonly driftMs: number;
	readonly message: string;
}

/** Threshold above which we log a warning but keep running. */
export const DRIFT_WARN_MS = 5_000;

/** Threshold above which we refuse to run.  At this scale,
 *  Postgres timestamps will be non-monotonic vs reality and
 *  the operator's clock is meaningfully broken — better to
 *  fail loud at boot than have weird symptoms in production.
 *  Two minutes — generous enough to tolerate a one-shot leap
 *  second / DST botch, strict enough to catch real misconfig. */
export const DRIFT_FATAL_MS = 120_000;

/** Classify drift between local and chain time.
 *
 * @param localMs   Date.now() captured immediately after the
 *                  RPC for chain head returned.  Caller should
 *                  capture this within ~10ms of receiving the
 *                  chain time to keep the comparison meaningful;
 *                  we treat sub-second deltas as "ok" anyway.
 * @param chainMs   Chain's head_block_time as ms epoch (parsed
 *                  from the Blurt API's ISO string + Z).
 */
export function checkClockDrift(localMs: number, chainMs: number): DriftCheckResult {
	const driftMs = localMs - chainMs;
	const absDrift = Math.abs(driftMs);

	let severity: DriftSeverity;
	let message: string;

	if (absDrift < DRIFT_WARN_MS) {
		severity = 'ok';
		message = `clock drift ${formatDrift(driftMs)} — well within tolerance`;
	} else if (absDrift < DRIFT_FATAL_MS) {
		severity = 'warn';
		const direction = driftMs > 0 ? 'AHEAD of chain' : 'BEHIND chain';
		message =
			`clock drift ${formatDrift(driftMs)} — local clock is ${direction}.\n` +
			'\n' +
			'This is tolerable for now but likely indicates the OS time service\n' +
			'(systemd-timesyncd / chrony / ntpd) is not running or not configured.\n' +
			'See docs/OPERATIONS.md → "Time synchronization" for the fix.\n' +
			'Drift greater than 2 minutes will refuse to start.';
	} else {
		severity = 'fatal';
		const direction = driftMs > 0 ? 'AHEAD of chain' : 'BEHIND chain';
		message =
			`clock drift ${formatDrift(driftMs)} — local clock is ${direction}.\n` +
			'\n' +
			'This exceeds the safety threshold of 2 minutes.  Running with this\n' +
			'much drift will cause:\n' +
			'  - Postgres timestamps that disagree with reality\n' +
			'  - Rate-limit buckets misaligned with UTC day boundaries\n' +
			'  - Operator monitoring alerts firing or silencing incorrectly\n' +
			'\n' +
			'Fix the OS time service first.  See docs/OPERATIONS.md →\n' +
			'"Time synchronization".  Refusing to start.';
	}

	return { severity, localMs, chainMs, driftMs, message };
}

function formatDrift(ms: number): string {
	const abs = Math.abs(ms);
	if (abs < 1_000) return `${ms} ms`;
	if (abs < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
	if (abs < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
	return `${(ms / 3_600_000).toFixed(2)} h`;
}
