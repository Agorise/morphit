/**
 * @morphit/node-health — IPFS/IPNS seeding classification (PURE).
 *
 * The single source of truth for "is this node successfully seeding
 * the signed release on IPFS and rebroadcasting its ipns:// record?"
 *
 * WHY THIS EXISTS (cp707).  The seeding *decision* previously lived in
 * two places that had to be kept in lockstep by hand:
 *
 *   - `checkIpfsSeeding` in apps/ops-cli/src/commands/health.ts
 *     (the `morphit-ops` health view), and
 *   - `decideSeeding` in apps/indexer/src/api/operationalHealth.ts
 *     (the public /v1/health `ipfs_seeding` block).
 *
 * The indexer can't import ops-cli, so the branch logic was copy-pasted.
 * They agreed, but nothing *guaranteed* they'd keep agreeing — a future
 * edit to one could silently diverge (a node reporting "ok" to peers
 * while its own CLI says "degraded", or vice-versa).
 *
 * The fix: the branch logic — the part that must never drift — lives
 * here, as a pure function returning a STRUCTURED classification (the
 * state + which branch fired + the ordered list of problems).  Each
 * caller renders its own human-readable `detail` string from that
 * structure, because the two surfaces intentionally word things
 * differently (the CLI adds remediation commands + last-run ages; the
 * public endpoint stays terse).  Facts GATHERING stays per-process
 * (ops-cli reads systemd via `checkService`; the indexer via its own
 * `execFile('systemctl', …)`).  So: one decision, two renderings, zero
 * drift risk.  A cross-package parity smoke locks the two renderings to
 * this classifier.
 */

/** systemd unit active-state, normalised.  Identical string-literal
 *  union in both callers (ops-cli `ServiceState`, indexer
 *  `ServiceState`); structurally assignable to/from this. */
export type ServiceState =
	| 'active'
	| 'inactive'
	| 'failed'
	| 'activating'
	| 'not-installed'
	| 'unknown';

/** The five seeding states surfaced to operators + peers. */
export type SeedingState = 'ok' | 'degraded' | 'down' | 'not-configured' | 'unknown';

/** Read-only systemd facts that drive the seeding decision.  The
 *  ops-cli facts struct (`IpfsSeedingFacts`) is a SUPERSET of this
 *  (it also carries last-run ages for the CLI's detail line), so it
 *  is structurally assignable here. */
export interface SeedingFacts {
	readonly daemon: ServiceState;
	readonly pinTimer: ServiceState;
	readonly rebroadcastTimer: ServiceState;
	readonly pinFailed: boolean;
	readonly rebroadcastFailed: boolean;
}

/** The individual problems that make a running-but-imperfect node
 *  'degraded'.  Order is stable (pin-timer, rebroadcast-timer,
 *  pin-failed, rebroadcast-failed) so both callers render the same
 *  sequence.  Each caller maps a kind to its own wording using its
 *  own facts (the timer STATE for the two `*-timer` kinds). */
export type SeedingProblem =
	| 'pin-timer'
	| 'rebroadcast-timer'
	| 'pin-failed'
	| 'rebroadcast-failed';

/** Which top-level branch decided the state — lets each caller pick
 *  the right copy without re-deriving the branch. */
export type SeedingReason = 'not-configured' | 'unreadable' | 'daemon-down' | 'degraded' | 'ok';

export interface SeedingClassification {
	readonly state: SeedingState;
	readonly reason: SeedingReason;
	/** Populated (order-stable) only when reason === 'degraded'; empty otherwise. */
	readonly problems: readonly SeedingProblem[];
}

/**
 * Classify IPFS/IPNS seeding from read-only systemd facts.  PURE.
 *
 * Branch order (first match wins) — this is the invariant both the CLI
 * and the public endpoint must obey:
 *   1. nothing installed at all      → not-configured (optional feature)
 *   2. everything unreadable         → unknown (no systemctl?)
 *   3. daemon not active             → down (nothing is being seeded)
 *   4. any timer down / last run failed → degraded (with problem list)
 *   5. otherwise                     → ok
 */
export function classifySeeding(f: SeedingFacts): SeedingClassification {
	const notInstalled = (s: ServiceState): boolean => s === 'not-installed';

	// 1. Nothing set up at all → optional feature, not a fault.
	if (notInstalled(f.daemon) && notInstalled(f.pinTimer) && notInstalled(f.rebroadcastTimer)) {
		return { state: 'not-configured', reason: 'not-configured', problems: [] };
	}
	// 2. systemctl unreadable everywhere → don't alarm.
	if (f.daemon === 'unknown' && f.pinTimer === 'unknown' && f.rebroadcastTimer === 'unknown') {
		return { state: 'unknown', reason: 'unreadable', problems: [] };
	}
	// 3. Daemon down while configured → nothing is being seeded.
	if (f.daemon !== 'active') {
		return { state: 'down', reason: 'daemon-down', problems: [] };
	}
	// 4. Running but a timer is down or a last run failed → degraded.
	const problems: SeedingProblem[] = [];
	if (f.pinTimer !== 'active') problems.push('pin-timer');
	if (f.rebroadcastTimer !== 'active') problems.push('rebroadcast-timer');
	if (f.pinFailed) problems.push('pin-failed');
	if (f.rebroadcastFailed) problems.push('rebroadcast-failed');
	if (problems.length > 0) {
		return { state: 'degraded', reason: 'degraded', problems };
	}
	// 5. All green.
	return { state: 'ok', reason: 'ok', problems: [] };
}
