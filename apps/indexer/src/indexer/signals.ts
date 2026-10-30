/**
 * Morphit indexer — self-trade signal detectors.
 *
 * Per ADR-0009 §5, the indexer runs advisory heuristics to flag
 * patterns that suggest two accounts belong to the same person.
 * Flagged pairs have their mutual feedback weighted to zero by
 * the reputation system (Phase 4 concern) and appear as a
 * warning on both profiles.
 *
 * **Signal A — related accounts.** Two accounts created by the
 * same creator, with close-timed first Morphit activity, and no
 * prior on-chain history before their first Morphit op. Reads
 * from the `accounts` table populated by the dispatcher's
 * account-create pre-pass.
 *
 * **Signal B — suspicious reciprocity.** Two accounts exchanging
 * ≥3 mutual 5-star reviews within 7 days with no third-party
 * feedback.
 *
 * **Signal C — one-way pile-on.** ≥3 distinct reviewers
 * targeting the same subject with avg rating ≤2, posted within a
 * 7-day window, where all reviewers' first_activity_at clusters
 * within a 14-day window AND each reviewer has narrow review
 * diversity (≤2 distinct subjects in last 30 days).  Catches
 * coordinated reputation-attack clusters that Signal A misses
 * (different creators) and Signal B misses (one-way, not mutual,
 * low-star not high-star).
 *
 * **Signal D — review concentration.** Closes
 * A4 "Signal B evasion via diversification."  Signal B requires
 * distinct_subjects=1 (the reviewer reviewed ONLY the target).
 * A smart attacker reviews 2-3 throwaway third parties to evade
 * Signal B while still pumping the primary target.  Signal D
 * triggers when a reviewer concentrates ≥80% of their reviews on
 * a single subject (over a 30-day window, ≥5 review threshold),
 * AND that reviewer's avg rating to the dominant subject is
 * ≥4.5 stars.  The (reviewer, dominant_subject) pair is the unit
 * of flagging.  Aggregate-exclusion logic in feedback.ts +
 * orderbook.ts + orderbookStream.ts drops those rows from the
 * weighted_rating computation.
 *
 * All signals write to tables established by migration v2/v31/v34.
 * Write semantics are ON CONFLICT DO NOTHING — once a pair/subject
 * is flagged, it stays flagged.  A false-positive's recovery path
 * is operator-side (delete the row and record a clearance in
 * moderation_flag_clearances, which this node's detectors then
 * honour), not automated — and it changes this node's display only.
 *
 * WHEN THEY RUN — on chain time, never the wall clock. Signals B, C
 * and D are evaluated when a review is applied, and Signal E when an
 * order is completed (raiseReviewSignals / raiseTradeSignals), each
 * over windows that END AT THAT OP'S BLOCK TIME and scoped to the
 * accounts the op involves. They used to run hourly over windows
 * ending at the wall clock, so whether a flag existed depended on
 * when a node happened to run its detector: a node indexing the same
 * history later never raised flags a live node had, and the review
 * gate that read them admitted different reviews on different nodes.
 * Signal A (related accounts) has no time window; the poller runs it
 * on this node's own hourly timer.
 *
 * WHAT THE TABLES ARE — this node's view, for reputation DISPLAY. Their
 * rows are not a pure function of the chain: Signals A to D skip pairs this
 * operator cleared (moderation_flag_clearances, a local-only table), Signal A
 * also skips this node's own relay (`excludeCreators`, a local setting) and
 * runs whenever this node's timer fires.
 *
 * WHO MAY READ THEM. Reputation display (the API). No rule that decides
 * chain-derived state does: the review and trade-credit gates call
 * reciprocityEverHeld, and the fee-attestation quorum calls
 * reciprocityEverHeld and relatedEverHeld — pure functions of chain-derived
 * rows up to a block (signalVerdicts.ts) — so a local clearance or setting
 * can never change a verdict. One exception, kept so history keeps its
 * verdicts: for an order whose newest attestation is in a block stamped
 * before CONSENSUS_V2_ACTIVATION_TIME the quorum still reads related_accounts
 * as it always did (fee/attestationQuorumLegacy.ts).
 */

import type pg from 'pg';
import type { Database } from '$db/pool';
import { consensusV2Active } from '$indexer/consensusActivation';
import {
	SIGNAL_A_EXEMPT_RESERVED_CREATORS,
	SIGNAL_A_PROXIMITY_MINUTES,
	SIGNAL_B_MIN_AVG_RATING,
	SIGNAL_B_MIN_COUNT,
	SIGNAL_B_WINDOW_DAYS
} from '$indexer/signalVerdicts';

/** The verdicts consensus code uses live in signalVerdicts.ts; re-exported for
 *  the modules that import them from here. */
export { reciprocityEverHeld, relatedEverHeld } from '$indexer/signalVerdicts';

/** How much NEW mutual-review activity re-arms a cleared Signal B pair.
 *  A fresh trigger needs SIGNAL_B_MIN_COUNT reviews in EACH direction, so a
 *  whole signal's worth is twice that — i.e. a cleared pair must earn the flag
 *  all over again from scratch, rather than on any single stray review. */
const SIGNAL_B_CLEARANCE_GROWTH = 2 * SIGNAL_B_MIN_COUNT;

/** Upper bound on one Signal A statement. */
export const SIGNAL_A_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Run Signal B — suspicious reciprocity detection.
 *
 * Query strategy:
 *   1. Aggregate feedback in the last 7 days by (reviewer, subject).
 *   2. Self-join so each row has both directions (a→b and b→a) with
 *      their counts and averages.
 *   3. Filter to pairs where BOTH directions meet the thresholds.
 *   4. Filter to pairs where neither participant reviewed any third
 *      party in the window — if a user reviews many people, their
 *      high count with one specific other is incidental.
 *   5. Insert pairs in canonical (a < b) order.
 *
 * Returns the number of NEW rows inserted this run (existing
 * flagged pairs are not double-counted).
 */
export async function detectSuspiciousReciprocity(
	db: Database,
	opts: SignalWindow & { readonly pair?: readonly [string, string] }
): Promise<number> {
	return db.withTx((client) => detectSuspiciousReciprocityInTx(client, opts));
}

/** Where a detector's windows end. */
export interface SignalWindow {
	/** The windows end here: the block time of the op that triggered the
	 *  evaluation. Never the wall clock. */
	readonly asOf: Date;
}

/** Implementation that operates on a caller-provided transaction.
 *  Extracted for testability — tests can run this against a mock
 *  client without touching the real pool. The window is
 *  ($4 - 7 days, $4]; $5/$6, when given, restrict it to one pair. */
export async function detectSuspiciousReciprocityInTx(
	client: pg.PoolClient,
	opts: SignalWindow & { readonly pair?: readonly [string, string] }
): Promise<number> {
	// The CTEs below build up the pair candidates:
	//   direction_stats: per (reviewer, subject) in the window,
	//                    count and avg rating.
	//   reviewer_diversity: per reviewer in the window, how many
	//                       distinct subjects they've reviewed.
	//   mutual_pairs:   pairs where each direction meets the count
	//                   and avg thresholds, AND both reviewers have
	//                   reviewed only one subject each (so no third-
	//                   party feedback from either).
	// Canonical ordering ensures (a, b) only appears once.
	const sql = `
		WITH direction_stats AS (
			SELECT
				reviewer,
				subject,
				COUNT(*) AS cnt,
				AVG(rating)::NUMERIC(3,2) AS avg_rating
			FROM feedback
			WHERE created_at > $4::timestamptz - INTERVAL '${SIGNAL_B_WINDOW_DAYS} days'
			  AND created_at <= $4::timestamptz
			  AND ($5::text IS NULL OR reviewer IN ($5::text, $6::text))
			GROUP BY reviewer, subject
		),
		reviewer_diversity AS (
			SELECT
				reviewer,
				COUNT(DISTINCT subject) AS distinct_subjects
			FROM feedback
			WHERE created_at > $4::timestamptz - INTERVAL '${SIGNAL_B_WINDOW_DAYS} days'
			  AND created_at <= $4::timestamptz
			  AND ($5::text IS NULL OR reviewer IN ($5::text, $6::text))
			GROUP BY reviewer
		),
		mutual AS (
			SELECT
				a.reviewer AS acct_x,
				a.subject  AS acct_y,
				a.cnt      AS x_to_y_count,
				b.cnt      AS y_to_x_count,
				a.avg_rating AS x_to_y_avg,
				b.avg_rating AS y_to_x_avg
			FROM direction_stats a
			JOIN direction_stats b
				ON a.reviewer = b.subject
			   AND a.subject  = b.reviewer
			JOIN reviewer_diversity ra ON ra.reviewer = a.reviewer
			JOIN reviewer_diversity rb ON rb.reviewer = b.reviewer
			WHERE a.cnt >= $1
			  AND b.cnt >= $1
			  AND a.avg_rating >= $2
			  AND b.avg_rating >= $2
			  AND ra.distinct_subjects = 1
			  AND rb.distinct_subjects = 1
			  AND a.reviewer < a.subject -- canonical ordering, dedupes (a,b)/(b,a)
		)
		INSERT INTO suspicious_reciprocity
			(account_a, account_b, mutual_review_count, avg_rating, detected_at)
		SELECT
			acct_x,
			acct_y,
			(x_to_y_count + y_to_x_count)::INTEGER AS mutual_review_count,
			((x_to_y_avg + y_to_x_avg) / 2)::NUMERIC(3,2) AS avg_rating,
			$4::timestamptz
		FROM mutual
		-- v1.8.9 — never re-raise a flag the operator has cleared. Without this
		-- the clear is cosmetic: the row comes straight back on the next pass.
		--
		-- But Signal B is BEHAVIOURAL, so the clearance forgives the reviews that
		-- existed at clear time WITHOUT blinding us to new ones: it stops covering
		-- the pair once they add another full signal's worth of mutual reviews
		-- past the watermark ($3). A genuinely colluding pair cleared by mistake
		-- is therefore caught again by fresh behaviour, while an honest pair is
		-- not re-flagged on the same forgiven history. A NULL watermark (or a
		-- Signal A row) means permanent.
		WHERE NOT EXISTS (
			SELECT 1 FROM moderation_flag_clearances c
			 WHERE c.signal = 'reciprocity'
			   AND c.account_a = acct_x
			   AND c.account_b = acct_y
			   AND (
					c.watermark IS NULL
					OR (x_to_y_count + y_to_x_count) <= c.watermark + $3
			   )
		)
		ON CONFLICT (account_a, account_b) DO NOTHING
	`;
	const result = await client.query(sql, [
		SIGNAL_B_MIN_COUNT,
		SIGNAL_B_MIN_AVG_RATING,
		SIGNAL_B_CLEARANCE_GROWTH,
		opts.asOf,
		opts.pair?.[0] ?? null,
		opts.pair?.[1] ?? null
	]);
	return result.rowCount ?? 0;
}

/**
 * Run Signal A — related-accounts detection.
 *
 * Finds pairs of accounts that:
 *   (a) were created by the same creator,
 *   (b) have both produced their first Morphit op,
 *   (c) those first activities fall within the temporal-proximity
 *       window (5 minutes by default).
 *
 * The "no prior on-chain history" clause from ADR-0009 §5 is
 * satisfied structurally: an account's first observed Morphit op
 * IS its first activity from our perspective. If that op fires
 * close to a same-creator sibling's, we flag the pair.
 *
 * Idempotent via ON CONFLICT DO NOTHING — re-running the
 * detector on the same data produces no new rows.
 *
 * Creators that do NOT trigger the signal: every REGISTERED operator
 * account (each instance's relay creates its users' accounts, so two
 * friends signing up back-to-back through any instance are not related —
 * Finding N28; only this instance's relay used to be excluded), the
 * project's reserved accounts (the canonical instance relays from one of
 * them; signalVerdicts.SIGNAL_A_EXEMPT_RESERVED_CREATORS), the '' creator of
 * a placeholder row (an account created before indexing began, whose
 * creator is unknown), plus `excludeCreators` (this instance's relay, also
 * before it registers). "Same creator" is meaningful only for some other
 * creator, e.g. a custom blurt-cli onboarding pipeline.
 *
 * DISPLAY ONLY. What this writes is shaped by this node (its clearances, its
 * `excludeCreators`, when its timer ran), so no consensus rule reads it: the
 * fee-attestation quorum asks signalVerdicts.relatedEverHeld, the same rule
 * from chain rows alone (from the consensus activation time).
 *
 * Cost: a RANGE join — each account is compared only with same-creator
 * accounts whose first activity falls within the window, served by the
 * (creator, first_activity_at) index (v66). The old self-join compared
 * every same-creator pair (O(k²) for a creator with k accounts) inside the
 * poll loop with no time limit. The statement is capped at
 * SIGNAL_A_STATEMENT_TIMEOUT_MS; the poller runs it off the block loop.
 */
export async function detectRelatedAccounts(
	db: Database,
	options: { excludeCreators?: readonly string[] } = {}
): Promise<number> {
	return db.withTx((client) => detectRelatedAccountsInTx(client, options));
}

export async function detectRelatedAccountsInTx(
	client: pg.PoolClient,
	options: { excludeCreators?: readonly string[] } = {}
): Promise<number> {
	const excludeCreators = [
		...SIGNAL_A_EXEMPT_RESERVED_CREATORS,
		...(options.excludeCreators ?? [])
	];
	await client.query(`SET LOCAL statement_timeout = ${SIGNAL_A_STATEMENT_TIMEOUT_MS}`);
	// Same-creator pairs whose first activities are within the window,
	// found with a range join (see above). Canonical (a < b) ordering dedupes.
	const sql = `
		WITH candidates AS (
			SELECT
				a.name AS acct_a,
				b.name AS acct_b,
				a.creator,
				a.first_activity_at AS a_active,
				b.first_activity_at AS b_active,
				ABS(EXTRACT(EPOCH FROM (b.first_activity_at - a.first_activity_at))) AS gap_seconds
			FROM accounts a
			JOIN accounts b
				ON b.creator = a.creator
			   AND b.first_activity_at BETWEEN a.first_activity_at - make_interval(secs => $1)
			                               AND a.first_activity_at + make_interval(secs => $1)
			   AND a.name < b.name
			WHERE a.first_activity_at IS NOT NULL
			  AND a.creator <> ''
			  AND a.creator <> ALL($2::text[])
			  AND NOT EXISTS (SELECT 1 FROM operators o WHERE o.account = a.creator)
		)
		INSERT INTO related_accounts
			(account_a, account_b, reason, evidence)
		SELECT
			acct_a,
			acct_b,
			'same_creator_close_timing',
			jsonb_build_object(
				'creator', creator,
				'first_activity_gap_seconds', gap_seconds,
				'a_first_activity_at', a_active,
				'b_first_activity_at', b_active
			)
		FROM candidates
		WHERE gap_seconds <= $1
		  -- v1.8.9 — see the Signal B insert: a cleared pair must stay cleared.
		  AND NOT EXISTS (
			SELECT 1 FROM moderation_flag_clearances c
			 WHERE c.signal = 'related'
			   AND c.account_a = acct_a
			   AND c.account_b = acct_b
		  )
		ON CONFLICT (account_a, account_b) DO NOTHING
	`;
	const result = await client.query(sql, [SIGNAL_A_PROXIMITY_MINUTES * 60, excludeCreators]);
	return result.rowCount ?? 0;
}

// ─── Signal C constants ────────────────────────────────────────────

/** Minimum distinct reviewers to trigger Signal C. */
const SIGNAL_C_MIN_REVIEWERS = 3;
/** Upper bound on each reviewer's avg rating to the subject. */
const SIGNAL_C_MAX_AVG_RATING = 2.0;
/** Time window for the pile-on review activity itself. */
const SIGNAL_C_REVIEW_WINDOW_DAYS = 7;
/** Time window for the cluster of reviewer first-activity timestamps. */
const SIGNAL_C_ACTIVITY_CLUSTER_DAYS = 14;
/** Max distinct subjects per reviewer in their last N days; above this
 *  they're considered "diversified" and not flagged as part of a
 *  pile-on cluster (false-positive guard). */
const SIGNAL_C_MAX_DISTINCT_SUBJECTS = 2;
/** Recency window for computing each reviewer's distinct_subjects. */
const SIGNAL_C_RECENCY_DAYS = 30;

/**
 * Run Signal C — one-way pile-on detection.
 *
 * Returns the number of NEW rows inserted this run (existing
 * flagged subjects are not double-counted; UNIQUE (subject,
 * detection_date) means at most one row per subject per day).
 *
 * Query strategy:
 *   1. attacker_stats: per (reviewer, subject) in the review
 *      window, count + avg rating.
 *   2. attacker_diversity: per reviewer in the recency window, how
 *      many distinct subjects they've reviewed.
 *   3. attacker_qualifying: reviewers who meet criteria — low avg
 *      rating to a target AND narrow diversity AND a known
 *      first_activity_at (which we'll cluster on).
 *   4. clusters: subjects with ≥3 qualifying attackers whose
 *      first_activity_at span is ≤ ACTIVITY_CLUSTER_DAYS.
 */
export async function detectOneWayPileOn(
	db: Database,
	opts: SignalWindow & { readonly subject?: string }
): Promise<number> {
	return db.withTx((client) => detectOneWayPileOnInTx(client, opts));
}

/** Implementation that operates on a caller-provided transaction.
 *  Extracted for testability — tests can run this against a mock
 *  client without touching the real pool. */
export async function detectOneWayPileOnInTx(
	client: pg.PoolClient,
	opts: SignalWindow & { readonly subject?: string }
): Promise<number> {
	// Windows end at $6 (the triggering op's block time); $7, when given,
	// restricts the evaluation to one subject.
	const sql = `
		WITH attacker_stats AS (
			SELECT
				reviewer,
				subject,
				COUNT(*)::int AS cnt,
				AVG(rating)::NUMERIC(3,2) AS avg_rating
			FROM feedback
			WHERE created_at > $6::timestamptz - INTERVAL '${SIGNAL_C_REVIEW_WINDOW_DAYS} days'
			  AND created_at <= $6::timestamptz
			  AND ($7::text IS NULL OR subject = $7::text)
			GROUP BY reviewer, subject
		),
		attacker_diversity AS (
			SELECT
				reviewer,
				COUNT(DISTINCT subject)::int AS distinct_subjects
			FROM feedback
			WHERE created_at > $6::timestamptz - INTERVAL '${SIGNAL_C_RECENCY_DAYS} days'
			  AND created_at <= $6::timestamptz
			  AND reviewer IN (SELECT reviewer FROM attacker_stats)
			GROUP BY reviewer
		),
		attacker_qualifying AS (
			-- Reviewers who meet the per-reviewer criteria:
			--   - avg rating to the subject ≤ MAX_AVG_RATING (low star)
			--   - distinct subjects in recency window ≤ MAX_DISTINCT_SUBJECTS
			--   - first_activity_at is known (joined from accounts)
			SELECT
				ast.reviewer,
				ast.subject,
				ast.cnt,
				ast.avg_rating,
				acc.first_activity_at
			FROM attacker_stats ast
			JOIN attacker_diversity ad ON ad.reviewer = ast.reviewer
			JOIN accounts acc ON acc.name = ast.reviewer
			WHERE ast.avg_rating <= $1
			  AND ad.distinct_subjects <= $2
			  AND acc.first_activity_at IS NOT NULL
			  -- An operator's clearance of this (subject, attacker) pair is
			  -- permanent for the pair, like Signal A's: without this the next
			  -- detection day put the cleared attacker straight back (review,
			  -- 2026-10-29). Display only — the gates never read this table.
			  AND NOT EXISTS (
				SELECT 1 FROM moderation_flag_clearances c
				 WHERE c.signal = 'pile_on'
				   AND c.account_a = LEAST(ast.reviewer, ast.subject)
				   AND c.account_b = GREATEST(ast.reviewer, ast.subject)
			  )
		),
		subject_clusters AS (
			-- Aggregate per subject: count of attackers + their
			-- min/max first_activity_at.  Only subjects with ≥
			-- MIN_REVIEWERS qualifying attackers AND a tight
			-- activity-cluster span pass the gate.
			SELECT
				subject,
				COUNT(*)::int AS attacker_count,
				AVG(avg_rating)::NUMERIC(3,2) AS pile_avg_rating,
				SUM(cnt)::int AS pile_review_count,
				MIN(first_activity_at) AS earliest_activity,
				MAX(first_activity_at) AS latest_activity,
				jsonb_agg(jsonb_build_object(
					'reviewer', reviewer,
					'rating_avg', avg_rating,
					'count', cnt,
					'first_activity_at', first_activity_at
				) ORDER BY first_activity_at) AS attackers
			FROM attacker_qualifying
			GROUP BY subject
		)
		INSERT INTO one_way_pile_on
			(subject, attacking_reviewers, avg_rating, review_count,
			 review_window_days, activity_cluster_days, detected_at, detection_date)
		SELECT
			subject,
			attackers,
			pile_avg_rating,
			pile_review_count,
			$5::int,
			$4::int,
			$6::timestamptz,
			($6::timestamptz AT TIME ZONE 'UTC')::date
		FROM subject_clusters
		WHERE attacker_count >= $3
		  AND EXTRACT(EPOCH FROM (latest_activity - earliest_activity)) <= $4 * 86400
		ON CONFLICT (subject, detection_date) DO NOTHING
	`;
	const result = await client.query(sql, [
		SIGNAL_C_MAX_AVG_RATING,
		SIGNAL_C_MAX_DISTINCT_SUBJECTS,
		SIGNAL_C_MIN_REVIEWERS,
		SIGNAL_C_ACTIVITY_CLUSTER_DAYS,
		SIGNAL_C_REVIEW_WINDOW_DAYS,
		opts.asOf,
		opts.subject ?? null
	]);
	return result.rowCount ?? 0;
}

// ─── Signal D constants (review concentration) ──────────

/** Window over which a reviewer's concentration is computed. */
const SIGNAL_D_WINDOW_DAYS = 30;
/** How much further a cleared pair may concentrate before being re-flagged.
 *  Mirrors SIGNAL_B_CLEARANCE_GROWTH: a clearance forgives the history it was
 *  granted against, not all future behaviour. */
const SIGNAL_D_CLEARANCE_GROWTH = 5;
/** Minimum total reviews in the window for the signal to even apply.
 *  Below this, concentration is noise — a reviewer with only 2-3
 *  reviews can legitimately have one dominant subject (their only
 *  trade partner).  Tuned at 5 to require enough data for the
 *  concentration ratio to be meaningful. */
const SIGNAL_D_MIN_REVIEW_COUNT = 5;
/** Concentration percentage above which the reviewer is flagged.
 *  80% means: ≥4 of every 5 reviews go to the dominant subject. */
const SIGNAL_D_MIN_CONCENTRATION_PCT = 80.0;
/** Average rating to the dominant subject below which the signal
 *  does not fire.  Concentration of LOW-STAR reviews is captured
 *  by Signal C; Signal D specifically targets concentration of
 *  HIGH-STAR reviews (the inflation case). */
const SIGNAL_D_MIN_AVG_RATING = 4.5;

/**
 * Run Signal D — review-concentration detection.
 *
 * Closes "Signal B evasion via diversification."
 * Signal B fires only when distinct_subjects=1 (the reviewer
 * reviewed ONLY the target).  An attacker who reviews 2-3
 * throwaway third parties evades Signal B while still pumping
 * the primary target.  Signal D's threshold is concentration
 * percentage rather than absolute count, so a diversifying
 * attacker who maintains 80%+ focus on the target gets caught.
 *
 * Query strategy:
 *   1. reviewer_stats: per-reviewer count + avg + dominant subject
 *      identified by COUNT(*) within the 30-day window.
 *   2. concentration: count by (reviewer, subject); flag rows where
 *      the per-reviewer concentration ≥80% and ≥5 total reviews and
 *      the avg rating to the dominant subject ≥4.5.
 *
 * Returns the number of NEW rows inserted this run.
 */
export async function detectReviewConcentration(
	db: Database,
	opts: SignalWindow & { readonly reviewer?: string }
): Promise<number> {
	return db.withTx((client) => detectReviewConcentrationInTx(client, opts));
}

/** Implementation that operates on a caller-provided transaction. The window
 *  ends at $6 (the triggering op's block time); $7, when given, restricts it
 *  to one reviewer. */
export async function detectReviewConcentrationInTx(
	client: pg.PoolClient,
	opts: SignalWindow & { readonly reviewer?: string }
): Promise<number> {
	const sql = `
		WITH reviewer_totals AS (
			-- Per-reviewer total review count in the window.
			SELECT
				reviewer,
				COUNT(*)::int AS total_reviews
			FROM feedback
			WHERE created_at > $6::timestamptz - INTERVAL '${SIGNAL_D_WINDOW_DAYS} days'
			  AND created_at <= $6::timestamptz
			  AND ($7::text IS NULL OR reviewer = $7::text)
			GROUP BY reviewer
		),
		reviewer_subject_stats AS (
			-- Per (reviewer, subject) count + avg rating in the window.
			SELECT
				reviewer,
				subject,
				COUNT(*)::int AS pair_count,
				AVG(rating)::NUMERIC(3,2) AS pair_avg_rating
			FROM feedback
			WHERE created_at > $6::timestamptz - INTERVAL '${SIGNAL_D_WINDOW_DAYS} days'
			  AND created_at <= $6::timestamptz
			  AND ($7::text IS NULL OR reviewer = $7::text)
			GROUP BY reviewer, subject
		),
		concentration AS (
			-- Per (reviewer, subject): concentration % = pair_count / total_reviews × 100.
			SELECT
				rs.reviewer,
				rs.subject AS dominant_subject,
				rs.pair_count,
				rs.pair_avg_rating,
				rt.total_reviews,
				(rs.pair_count::NUMERIC * 100.0 / rt.total_reviews)::NUMERIC(5,2) AS concentration_pct
			FROM reviewer_subject_stats rs
			JOIN reviewer_totals rt ON rt.reviewer = rs.reviewer
			WHERE rt.total_reviews >= $1
			  AND rs.pair_avg_rating >= $2
		)
		INSERT INTO review_concentration
			(reviewer, dominant_subject, concentration_pct, review_count, window_days, detected_at)
		SELECT
			reviewer,
			dominant_subject,
			concentration_pct,
			pair_count,
			$4::int,
			$6::timestamptz
		FROM concentration
		WHERE concentration_pct >= $3
		-- v1.8.12: honour operator clearances, as Signals A and B already
		-- do. Without this, Signal D was UNCLEARABLE — an operator could delete
		-- the row, but the very next detector pass re-created it, so a
		-- reputation suppressed by a false positive stayed suppressed forever.
		-- In practice: two rows deleted, both reputations returned, and a reload
		-- found them suppressed again.
		--
		-- Watermark semantics match Signal B: the clearance forgives the
		-- history it was granted against, and the pair is re-flagged only if
		-- concentration continues to GROW past that point (so a genuinely
		-- self-dealing pair is caught again by fresh behaviour, while a
		-- forgiven pair is not re-flagged on the same history). A NULL
		-- watermark is permanent.
		AND NOT EXISTS (
			SELECT 1 FROM moderation_flag_clearances c
			 WHERE c.signal = 'concentration'
			   AND c.account_a = LEAST(reviewer, dominant_subject)
			   AND c.account_b = GREATEST(reviewer, dominant_subject)
			   AND (c.watermark IS NULL OR pair_count <= c.watermark + $5)
		)
		ON CONFLICT (reviewer, dominant_subject) DO NOTHING
	`;
	const result = await client.query(sql, [
		SIGNAL_D_MIN_REVIEW_COUNT,
		SIGNAL_D_MIN_AVG_RATING,
		SIGNAL_D_MIN_CONCENTRATION_PCT,
		SIGNAL_D_WINDOW_DAYS,
		SIGNAL_D_CLEARANCE_GROWTH,
		opts.asOf,
		opts.reviewer ?? null
	]);
	return result.rowCount ?? 0;
}

// ─── Signal E — trade concentration (v1.5.5) ────────────────────────

/** Detection window, mirroring Signal D. */
const SIGNAL_E_WINDOW_DAYS = 30;
/** Minimum completed-trade credits in the window before concentration is even
 *  meaningful. Below this, "100% with one peer" is just a new trader's first
 *  trade — the 🌱 chip already says that, and flagging it would be noise. */
const SIGNAL_E_MIN_TRADE_COUNT = 5;
/** Share of an account's trade credits coming from ONE peer that trips the
 *  signal. A percentage rather than an absolute count for the same reason as
 *  Signal D: an attacker who sprinkles a couple of throwaway trades to look
 *  diversified is still caught while staying focused on the target. */
const SIGNAL_E_MIN_CONCENTRATION_PCT = 80;

/**
 * Run Signal E — completed-trade concentration.
 *
 * WHY IT EXISTS. v1.5.5 grounds the trade count in COMPLETED ORDERS and credits
 * the `counterparty` the order owner names. The provable-counterparty gate makes
 * the owner prove a real two-way conversation with that account first — but that
 * bar is PER PAIR, not per trade. So once Alice and Bob have had one genuine
 * conversation, Alice can keep completing orders naming Bob and mint him a trade
 * credit for the price of a listing fee each, forever. None of the review
 * signals see it: suspicious_reciprocity watches mutual REVIEWS, and Signals C/D
 * are review-pattern detectors with no trade analogue. This is that analogue.
 *
 * Measured on the BENEFICIARY's side — what share of THIS account's trade
 * credits come from a single peer — because that's the sock-puppet shape: the
 * farmed account has one source and the farmer has many victims-of-convenience.
 *
 * KNOWN COST (documented, same trade-off accepted for Signal D): two people
 * who genuinely only ever trade with each other — a regular customer and their
 * regular seller — look identical to this from the outside and will be flagged.
 * They keep their ratings; only the concentrated TRADE credits stop counting.
 * The alternative (no signal) prices a fake trade at one listing fee.
 *
 * Returns the number of NEW rows inserted this run.
 */
export async function detectTradeConcentration(
	db: Database,
	opts: SignalWindow & { readonly accounts?: readonly string[] }
): Promise<number> {
	return db.withTx((client) => detectTradeConcentrationInTx(client, opts));
}

/** Implementation that operates on a caller-provided transaction. The window
 *  ends at $4 (the triggering op's block time); $5, when given, restricts it
 *  to those accounts.
 *
 *  Which time places a trade in the window: from CONSENSUS_V2_ACTIVATION_TIME,
 *  completed_at — the completion's block time, the same on every node. Before
 *  it, updated_at, as it always was, so history keeps its verdicts. updated_at
 *  is not the completion time: an attestation or the partner named later moves
 *  it to that op's block time, and a fee re-check to the node's own wall clock,
 *  so two nodes could count different trades in the same window. */
export function tradeWindowColumn(blockTime: Date): 'o.completed_at' | 'o.updated_at' {
	return consensusV2Active(blockTime) ? 'o.completed_at' : 'o.updated_at';
}

export async function detectTradeConcentrationInTx(
	client: pg.PoolClient,
	opts: SignalWindow & { readonly accounts?: readonly string[] }
): Promise<number> {
	const at = tradeWindowColumn(opts.asOf);
	const sql = `
		WITH credits AS (
			-- One row per trade CREDIT: both sides of every completed order in
			-- the window. Mirrors TRADE_COUNT_SQL's UNION ALL so the signal
			-- measures exactly what the count credits.
			SELECT o.account AS account, o.completed_counterparty AS peer
			  FROM orders o
			 WHERE o.status = 'completed'
			   AND o.completed_counterparty IS NOT NULL
			   AND ${at} > $4::timestamptz - INTERVAL '${SIGNAL_E_WINDOW_DAYS} days'
			   AND ${at} <= $4::timestamptz
			   AND ($5::text[] IS NULL OR o.account = ANY($5::text[]))
			UNION ALL
			SELECT o.completed_counterparty AS account, o.account AS peer
			  FROM orders o
			 WHERE o.status = 'completed'
			   AND o.completed_counterparty IS NOT NULL
			   AND ${at} > $4::timestamptz - INTERVAL '${SIGNAL_E_WINDOW_DAYS} days'
			   AND ${at} <= $4::timestamptz
			   AND ($5::text[] IS NULL OR o.completed_counterparty = ANY($5::text[]))
		),
		account_totals AS (
			SELECT account, COUNT(*)::int AS total_trades
			  FROM credits
			 GROUP BY account
		),
		account_peer_stats AS (
			SELECT account, peer, COUNT(*)::int AS pair_count
			  FROM credits
			 GROUP BY account, peer
		),
		concentration AS (
			SELECT
				ps.account,
				ps.peer AS dominant_peer,
				ps.pair_count,
				(ps.pair_count::NUMERIC * 100.0 / at.total_trades)::NUMERIC(5,2) AS concentration_pct
			  FROM account_peer_stats ps
			  JOIN account_totals at ON at.account = ps.account
			 WHERE at.total_trades >= $1
		)
		INSERT INTO trade_concentration
			(account, dominant_peer, concentration_pct, trade_count, window_days, detected_at)
		SELECT
			account,
			dominant_peer,
			concentration_pct,
			pair_count,
			$3::int,
			$4::timestamptz
		FROM concentration
		WHERE concentration_pct >= $2
		ON CONFLICT (account, dominant_peer) DO NOTHING
	`;
	const result = await client.query(sql, [
		SIGNAL_E_MIN_TRADE_COUNT,
		SIGNAL_E_MIN_CONCENTRATION_PCT,
		SIGNAL_E_WINDOW_DAYS,
		opts.asOf,
		opts.accounts ?? null
	]);
	return result.rowCount ?? 0;
}

/**
 * Evaluate the review signals (B, C, D) for the accounts one applied review
 * involves, with windows ending at that review's block time. Called by the
 * feedback handler right after it stores the review, inside the block
 * transaction, so every node raises the same flags at the same block.
 */
export async function raiseReviewSignals(
	client: pg.PoolClient,
	args: { reviewer: string; subject: string; asOf: Date }
): Promise<void> {
	await detectSuspiciousReciprocityInTx(client, {
		asOf: args.asOf,
		pair: [args.reviewer, args.subject]
	});
	await detectOneWayPileOnInTx(client, { asOf: args.asOf, subject: args.subject });
	await detectReviewConcentrationInTx(client, { asOf: args.asOf, reviewer: args.reviewer });
}

/** Evaluate Signal E for the accounts one completed order credits, with the
 *  window ending at the completion's block time. */
export async function raiseTradeSignals(
	client: pg.PoolClient,
	args: { accounts: readonly string[]; asOf: Date }
): Promise<void> {
	await detectTradeConcentrationInTx(client, { asOf: args.asOf, accounts: args.accounts });
}
