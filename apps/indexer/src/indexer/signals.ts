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
 * **Signal C — one-way pile-on (Part 113).** ≥3 distinct reviewers
 * targeting the same subject with avg rating ≤2, posted within a
 * 7-day window, where all reviewers' first_activity_at clusters
 * within a 14-day window AND each reviewer has narrow review
 * diversity (≤2 distinct subjects in last 30 days).  Catches
 * coordinated reputation-attack clusters that Signal A misses
 * (different creators) and Signal B misses (one-way, not mutual,
 * low-star not high-star).
 *
 * **Signal D — review concentration (cp123 H2).** Closes Part 113
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
 * is operator-side (DELETE the row), not automated.
 *
 * The detectors are called from the poller between block-
 * processing cycles. They're not tied to any specific block; they
 * read materialised state and write to a separate table. Running
 * them once per hour is plenty — the patterns they detect don't
 * form on sub-second timescales.
 */

import type pg from 'pg';
import type { Database } from '$db/pool';

/** Minimum reviews in each direction to trigger Signal B. */
const SIGNAL_B_MIN_COUNT = 3;
/** Minimum average rating to consider a review cluster "high-star." */
const SIGNAL_B_MIN_AVG_RATING = 4.8;
/** Time window for the reciprocity check (ADR-0009 §5). */
const SIGNAL_B_WINDOW_DAYS = 7;

/** Temporal-proximity window for Signal A. Two accounts created
 *  by the same creator whose first Morphit activities fall within
 *  this window are candidates for flagging. */
const SIGNAL_A_PROXIMITY_MINUTES = 5;

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
export async function detectSuspiciousReciprocity(db: Database): Promise<number> {
	return db.withTx((client) => detectSuspiciousReciprocityInTx(client));
}

/** Implementation that operates on a caller-provided transaction.
 *  Extracted for testability — tests can run this against a mock
 *  client without touching the real pool. */
export async function detectSuspiciousReciprocityInTx(client: pg.PoolClient): Promise<number> {
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
			WHERE created_at >= NOW() - INTERVAL '${SIGNAL_B_WINDOW_DAYS} days'
			GROUP BY reviewer, subject
		),
		reviewer_diversity AS (
			SELECT
				reviewer,
				COUNT(DISTINCT subject) AS distinct_subjects
			FROM feedback
			WHERE created_at >= NOW() - INTERVAL '${SIGNAL_B_WINDOW_DAYS} days'
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
			(account_a, account_b, mutual_review_count, avg_rating)
		SELECT
			acct_x,
			acct_y,
			(x_to_y_count + y_to_x_count)::INTEGER AS mutual_review_count,
			((x_to_y_avg + y_to_x_avg) / 2)::NUMERIC(3,2) AS avg_rating
		FROM mutual
		ON CONFLICT (account_a, account_b) DO NOTHING
	`;
	const result = await client.query(sql, [SIGNAL_B_MIN_COUNT, SIGNAL_B_MIN_AVG_RATING]);
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
 * `excludeCreators` lists creator account names that should NOT
 * trigger the signal — pass the Morphit relay account so two
 * friends signing up back-to-back via the relay aren't flagged
 * as related (Finding N28).  The relay creates the vast majority
 * of Morphit-onboarded accounts, so "same creator" is meaningful
 * only when the shared creator is something OTHER than the relay
 * (e.g. a custom blurt-cli operator with their own onboarding
 * pipeline).
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
	const excludeCreators = options.excludeCreators ?? [];
	// The CTE joins the accounts table to itself on matching
	// creator. We filter to pairs where both halves have produced
	// their first Morphit op (first_activity_at IS NOT NULL) and
	// the time gap between those first activities is within the
	// proximity window. Canonical (a < b) ordering dedupes.
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
				ON a.creator = b.creator
			   AND a.name < b.name
			WHERE a.first_activity_at IS NOT NULL
			  AND b.first_activity_at IS NOT NULL
			  AND a.creator <> ALL($2::text[])
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
export async function detectOneWayPileOn(db: Database): Promise<number> {
	return db.withTx((client) => detectOneWayPileOnInTx(client));
}

/** Implementation that operates on a caller-provided transaction.
 *  Extracted for testability — tests can run this against a mock
 *  client without touching the real pool. */
export async function detectOneWayPileOnInTx(client: pg.PoolClient): Promise<number> {
	const sql = `
		WITH attacker_stats AS (
			SELECT
				reviewer,
				subject,
				COUNT(*)::int AS cnt,
				AVG(rating)::NUMERIC(3,2) AS avg_rating
			FROM feedback
			WHERE created_at >= NOW() - INTERVAL '${SIGNAL_C_REVIEW_WINDOW_DAYS} days'
			GROUP BY reviewer, subject
		),
		attacker_diversity AS (
			SELECT
				reviewer,
				COUNT(DISTINCT subject)::int AS distinct_subjects
			FROM feedback
			WHERE created_at >= NOW() - INTERVAL '${SIGNAL_C_RECENCY_DAYS} days'
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
			 review_window_days, activity_cluster_days)
		SELECT
			subject,
			attackers,
			pile_avg_rating,
			pile_review_count,
			$5::int,
			$4::int
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
		SIGNAL_C_REVIEW_WINDOW_DAYS
	]);
	return result.rowCount ?? 0;
}

// ─── Signal D constants (cp123 H2 — review concentration) ──────────

/** Window over which a reviewer's concentration is computed. */
const SIGNAL_D_WINDOW_DAYS = 30;
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
 * Closes Part 113 A4 "Signal B evasion via diversification."
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
export async function detectReviewConcentration(db: Database): Promise<number> {
	return db.withTx((client) => detectReviewConcentrationInTx(client));
}

/** Implementation that operates on a caller-provided transaction. */
export async function detectReviewConcentrationInTx(client: pg.PoolClient): Promise<number> {
	const sql = `
		WITH reviewer_totals AS (
			-- Per-reviewer total review count in the window.
			SELECT
				reviewer,
				COUNT(*)::int AS total_reviews
			FROM feedback
			WHERE created_at >= NOW() - INTERVAL '${SIGNAL_D_WINDOW_DAYS} days'
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
			WHERE created_at >= NOW() - INTERVAL '${SIGNAL_D_WINDOW_DAYS} days'
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
			(reviewer, dominant_subject, concentration_pct, review_count, window_days)
		SELECT
			reviewer,
			dominant_subject,
			concentration_pct,
			pair_count,
			$4::int
		FROM concentration
		WHERE concentration_pct >= $3
		ON CONFLICT (reviewer, dominant_subject) DO NOTHING
	`;
	const result = await client.query(sql, [
		SIGNAL_D_MIN_REVIEW_COUNT,
		SIGNAL_D_MIN_AVG_RATING,
		SIGNAL_D_MIN_CONCENTRATION_PCT,
		SIGNAL_D_WINDOW_DAYS
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
 * KNOWN COST (documented, same trade-off Ken accepted for Signal D): two people
 * who genuinely only ever trade with each other — a regular customer and their
 * regular seller — look identical to this from the outside and will be flagged.
 * They keep their ratings; only the concentrated TRADE credits stop counting.
 * The alternative (no signal) prices a fake trade at one listing fee.
 *
 * Returns the number of NEW rows inserted this run.
 */
export async function detectTradeConcentration(db: Database): Promise<number> {
	return db.withTx((client) => detectTradeConcentrationInTx(client));
}

/** Implementation that operates on a caller-provided transaction. */
export async function detectTradeConcentrationInTx(client: pg.PoolClient): Promise<number> {
	const sql = `
		WITH credits AS (
			-- One row per trade CREDIT: both sides of every completed order in
			-- the window. Mirrors TRADE_COUNT_SQL's UNION ALL so the signal
			-- measures exactly what the count credits.
			SELECT o.account AS account, o.completed_counterparty AS peer
			  FROM orders o
			 WHERE o.status = 'completed'
			   AND o.completed_counterparty IS NOT NULL
			   AND o.updated_at >= NOW() - INTERVAL '${SIGNAL_E_WINDOW_DAYS} days'
			UNION ALL
			SELECT o.completed_counterparty AS account, o.account AS peer
			  FROM orders o
			 WHERE o.status = 'completed'
			   AND o.completed_counterparty IS NOT NULL
			   AND o.updated_at >= NOW() - INTERVAL '${SIGNAL_E_WINDOW_DAYS} days'
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
			(account, dominant_peer, concentration_pct, trade_count, window_days)
		SELECT
			account,
			dominant_peer,
			concentration_pct,
			pair_count,
			$3::int
		FROM concentration
		WHERE concentration_pct >= $2
		ON CONFLICT (account, dominant_peer) DO NOTHING
	`;
	const result = await client.query(sql, [
		SIGNAL_E_MIN_TRADE_COUNT,
		SIGNAL_E_MIN_CONCENTRATION_PCT,
		SIGNAL_E_WINDOW_DAYS
	]);
	return result.rowCount ?? 0;
}
