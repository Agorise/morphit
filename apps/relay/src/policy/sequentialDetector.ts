/**
 * Morphit relay — sequential signup pattern detection.
 *
 * Layer 8 of the signup-drain defense stack (see §18 of the
 * operator runbook).
 *
 * The high-value-name policy (Layer 7) catches a numeric-suffix
 * pattern in a single name.  This module catches the same
 * pattern across MULTIPLE recent successful signups: an attacker
 * registering `acct001`, `acct002`, `acct003` from the same
 * /24 / /64 IP bucket trips this even if the individual names
 * pass the per-name shape check.
 *
 * What "sequential" means here:
 *
 *   - same prefix (≥3 chars), differing suffix that's numeric
 *     OR another pattern (alphabetical, single-char-substituted)
 *   - within a short time window (default 1 hour)
 *   - from the same IP bucket (canonicalBucketKey: /24 IPv4 or
 *     /64 IPv6) OR globally if the volume is high enough
 *
 * Limits:
 *
 *   - This is a HEURISTIC.  It will have false positives on
 *     legitimate workflows (e.g., a user creating multiple test
 *     accounts during onboarding, a company creating staff
 *     accounts).  Operators who hit false positives can lower
 *     the trigger sensitivity or disable the layer.
 *   - It only catches sequential signups that have already
 *     succeeded within the rolling window.  The N-th signup is
 *     still allowed if it would be the first to trigger; what's
 *     blocked is the (N+1)-th.  An attacker who paces signups
 *     widely enough (one per hour) bypasses this layer; they're
 *     instead bounded by the global daily ceiling (Layer 2) and
 *     per-IP spacing (Layer 3).
 *   - The recent-signup record is in-memory.  It does not
 *     survive a relay restart.  Acceptable: a relay restart in
 *     the middle of an attack means the attacker's accumulated
 *     state is lost too — they're back to "first sequential
 *     signup," which is allowed.
 *
 * Configuration:
 *
 *   MORPHIT_RELAY_SEQUENTIAL_WINDOW_MS=3600000  (1 hour default)
 *   MORPHIT_RELAY_SEQUENTIAL_THRESHOLD=2        (2 sequential = block 3rd)
 *   MORPHIT_RELAY_SEQUENTIAL_MIN_PREFIX=3       (similarity match: same first N chars)
 *
 * The defaults are tight: 2 successful sequential signups in 1
 * hour from the same /64 bucket cause the 3rd to be rejected.
 * An operator who runs a service that legitimately creates
 * batched accounts (rare) can tune these higher or set the
 * threshold to a sentinel value to disable.
 */

/** Per-name+per-bucket recent-signup record.  Kept compact so
 *  the in-memory map doesn't grow unbounded. */
interface RecentSignup {
	readonly name: string;
	readonly bucketKey: string;
	readonly at: number; // epoch ms
}

/**
 * Why a sequential-pattern check rejected a name.  Only one
 * reason at a time; the most-specific match wins.
 */
export type SequentialReason =
	| 'sequential_numeric_suffix' // user001, user002, user003
	| 'sequential_alpha_suffix' // userA, userB, userC
	| 'sequential_close_similarity'; // userfoo01, userfoo02 — even if not strictly numeric-suffixed

export interface SequentialResult {
	readonly blocked: boolean;
	readonly reason: SequentialReason | null;
	readonly matchedPrior: readonly string[]; // names that triggered the match
}

/** Maximum number of recent-signup records kept in memory.  At
 *  the default window of 1 hour and a typical relay's daily
 *  ceiling of 25-100, the steady-state size is well under 100.
 *  An attacker firing a flood from many IPs could try to evict
 *  a real user's record, so we cap at a generous 5,000 — well
 *  above any legitimate daily ceiling, and bounded enough that
 *  memory pressure is negligible (~500KB at 100 bytes/entry). */
const MAX_RECENT_SIGNUPS = 5_000;

export interface SequentialDetectorOptions {
	readonly windowMs: number;
	readonly thresholdCount: number; // Nth identical-pattern signup is the one blocked
	readonly minPrefixLen: number; // similarity prefix length
	readonly now?: () => number;
}

/**
 * SequentialDetector is a small in-memory map of recent
 * successful signups, used by the create handler to refuse a
 * new signup that looks like the (N+1)th in a sequence.
 *
 * Usage:
 *
 *   1. After a successful signup, call `recordSignup(name, bucketKey)`.
 *   2. Before approving a new signup, call `check(name, bucketKey)`.
 *      If the result has `blocked: true`, refuse with the included
 *      reason.
 */
export class SequentialDetector {
	private records: RecentSignup[] = [];
	private readonly windowMs: number;
	private readonly thresholdCount: number;
	private readonly minPrefixLen: number;
	private readonly now: () => number;

	constructor(options: SequentialDetectorOptions) {
		this.windowMs = options.windowMs;
		this.thresholdCount = options.thresholdCount;
		this.minPrefixLen = options.minPrefixLen;
		this.now = options.now ?? Date.now;
	}

	/** Discard records older than the window.  Called lazily
	 *  before each operation; cheap because the array is small. */
	private prune(): void {
		const cutoff = this.now() - this.windowMs;
		this.records = this.records.filter((r) => r.at >= cutoff);
		// Hard cap on size — drop oldest if exceeded.
		if (this.records.length > MAX_RECENT_SIGNUPS) {
			this.records.splice(0, this.records.length - MAX_RECENT_SIGNUPS);
		}
	}

	recordSignup(name: string, bucketKey: string): void {
		this.prune();
		this.records.push({ name, bucketKey, at: this.now() });
	}

	/**
	 * Check whether the proposed `name` from `bucketKey` matches
	 * a sequential pattern with names already in the recent
	 * window.
	 *
	 * Returns `{ blocked: true, reason, matchedPrior }` if a
	 * pattern is detected, with `matchedPrior` listing the
	 * existing names that triggered the match.
	 *
	 * Returns `{ blocked: false, reason: null, matchedPrior: [] }`
	 * otherwise.
	 */
	check(name: string, bucketKey: string): SequentialResult {
		this.prune();

		// Only consider records from the SAME bucket.  We don't
		// punish a user whose neighbor on a different /64
		// happens to have a similar name.
		const sameBucket = this.records.filter((r) => r.bucketKey === bucketKey);
		if (sameBucket.length < this.thresholdCount) {
			return { blocked: false, reason: null, matchedPrior: [] };
		}

		// Pattern 1: numeric suffix.  Strip trailing digits/dashes
		// from the candidate; check how many existing same-bucket
		// records share the same stripped prefix.
		const numericStripped = stripNumericSuffix(name);
		if (numericStripped !== null) {
			const matches = sameBucket.filter((r) => stripNumericSuffix(r.name) === numericStripped);
			if (matches.length >= this.thresholdCount) {
				return {
					blocked: true,
					reason: 'sequential_numeric_suffix',
					matchedPrior: matches.map((m) => m.name)
				};
			}
		}

		// Pattern 2: alphabetical suffix (`abcA`, `abcB`).  Less
		// common but cheap to check.
		const alphaStripped = stripAlphaSuffix(name);
		if (alphaStripped !== null && alphaStripped.length >= this.minPrefixLen) {
			const matches = sameBucket.filter((r) => stripAlphaSuffix(r.name) === alphaStripped);
			if (matches.length >= this.thresholdCount) {
				return {
					blocked: true,
					reason: 'sequential_alpha_suffix',
					matchedPrior: matches.map((m) => m.name)
				};
			}
		}

		// Pattern 3: high-similarity (long-prefix match) without a
		// strict numeric/alpha tail.  Catches `userfooXY`,
		// `userfooZQ` — different tails but same long prefix.
		// A user-prefix shared with N+1 prior names from the same
		// bucket within the window is suspicious enough to block.
		const longPrefixMatches = sameBucket.filter(
			(r) =>
				r.name !== name &&
				sharesLongPrefix(r.name, name, Math.max(this.minPrefixLen, name.length - 3))
		);
		if (longPrefixMatches.length >= this.thresholdCount) {
			return {
				blocked: true,
				reason: 'sequential_close_similarity',
				matchedPrior: longPrefixMatches.map((m) => m.name)
			};
		}

		return { blocked: false, reason: null, matchedPrior: [] };
	}

	/** For tests + the verbose health endpoint — current size. */
	size(): number {
		this.prune();
		return this.records.length;
	}

	/** For tests — clear all state.  Production has no need. */
	clearAll(): void {
		this.records = [];
	}
}

/** Strip trailing digits and dashes from a name.  Returns the
 *  stripped prefix, or null if the name has no numeric suffix
 *  (the function is only meaningful for numeric-suffix
 *  comparison). */
function stripNumericSuffix(name: string): string | null {
	const m = name.match(/^([a-z][a-z0-9-]*?)-?[0-9]+$/);
	if (m === null) return null;
	const prefix = m[1]!;
	if (prefix.length < 2) return null;
	return prefix;
}

/** Strip a single trailing letter (the alphabetical-suffix case).
 *  Only meaningful when the prior char is a letter that ends a
 *  longer "real" prefix; we require length ≥ 4 so we don't
 *  mistake every short name for a sequential one. */
function stripAlphaSuffix(name: string): string | null {
	if (name.length < 4) return null;
	const last = name.charCodeAt(name.length - 1);
	if (last >= 0x61 && last <= 0x7a) {
		return name.slice(0, -1);
	}
	return null;
}

/** Two names share a long prefix if their first `n` characters
 *  match.  Used as a coarse similarity signal. */
function sharesLongPrefix(a: string, b: string, n: number): boolean {
	if (a.length < n || b.length < n) return false;
	for (let i = 0; i < n; i++) {
		if (a.charCodeAt(i) !== b.charCodeAt(i)) return false;
	}
	return true;
}
