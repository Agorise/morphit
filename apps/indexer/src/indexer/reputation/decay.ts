/**
 * Morphit indexer — reputation time-decay (cp123, H1 closes Part 113 D3).
 *
 * Background: pre-cp123, the visible `weighted_rating` was a flat
 * AVG(rating) over all non-suppressed feedback rows.  A 5-star from
 * 3 years ago counted equally to a 5-star from this week.  A trader
 * who turned bad after years of good reputation had their bad
 * behavior diluted by stale wins.
 *
 * From cp123 onward, each feedback row's contribution to the
 * weighted_rating is scaled by an exponential time-decay function
 * with a configurable half-life (default 365 days):
 *
 *   weight(age_days) = 2 ^ (-age_days / half_life_days)
 *
 *   • A review posted today:        weight = 1.0
 *   • A review 1 half-life old:     weight = 0.5
 *   • A review 2 half-lives old:    weight = 0.25
 *   • A review 3 half-lives old:    weight = 0.125
 *
 * The weighted rating is then:
 *
 *   weighted_rating = SUM(rating × weight) / SUM(weight)
 *
 * which approaches the recency-weighted opinion of the reviewer base.
 *
 * RATIONALE for 365-day half-life:
 *   • A year is the natural human "long enough ago that things might
 *     have changed."  Shorter (180d) penalizes seasonal traders too
 *     harshly; longer (730d) defers the decay benefit unhelpfully far.
 *   • At 365d half-life, a 5-year-old review is worth ~3% of a
 *     fresh review — effectively forgotten but not erased.  The raw
 *     COUNT remains visible separately, so historical context is
 *     preserved for readers who want it.
 *
 * RATIONALE for SUM(weight) denominator (rather than COUNT):
 *   • A trader with 10 fresh 5-stars should rank above one with 100
 *     ancient 5-stars at the same NUMERIC weighted_rating.  Both
 *     would land at 5.00 if we used COUNT in the denominator (every
 *     row has rating=5).  The SUM(weight) denominator means fresh
 *     contributors get full influence; ancient contributors get
 *     partial influence.  This produces a small additional natural
 *     ordering signal: when two traders have similar weighted_rating,
 *     the one with more RECENT feedback "wins" the tiebreak via
 *     existing feedback_count sort.
 *
 * HONEST LIMITATIONS:
 *   • Decay does NOT solve the "trader who got 5-stars then started
 *     scamming" problem on its own.  New 1-stars from the scam
 *     victims will pull the score down — but only AFTER the victims
 *     leave feedback.  Decay accelerates the recovery (recent bad
 *     reviews outweigh ancient good ones faster), but doesn't
 *     pre-empt it.
 *   • Decay does NOT defend against pump-and-dump on a fresh
 *     account.  That's what Signal A/B/C exist for.
 *
 * RAW COUNT preservation:
 *   • The `count` field in the API response is still RAW (no decay).
 *   • The `by_rating` histogram is still RAW per bucket.
 *   • Only `weighted_rating` carries the decay.
 *
 * The exponential-decay choice is deliberate over linear-decay:
 *   • Exponential has the desirable "memoryless" property — the
 *     ratio of any two reviews' weights depends only on their AGE
 *     DIFFERENCE, not their absolute ages.  This means the formula
 *     is stable under clock skew between indexers.
 *   • Linear decay has a "fall off a cliff" date after which
 *     reviews count zero — which would create perverse incentives
 *     (game the cutoff date).
 */

/**
 * Default half-life in days.  Configurable per-instance via the
 * `MORPHIT_REPUTATION_HALF_LIFE_DAYS` env var (future extension);
 * default 365 days = one year.
 */
export const REPUTATION_DECAY_HALF_LIFE_DAYS = 365;

/**
 * SQL fragment that computes a feedback row's time-decay weight.
 *
 * Inputs (must be available in scope of the SQL):
 *   • `created_at` column of the feedback row (TIMESTAMPTZ).
 *
 * Output: NUMERIC weight in (0, 1].
 *
 * Usage:
 *
 *   SELECT
 *     SUM(rating * ${REPUTATION_DECAY_WEIGHT_SQL('created_at')}) /
 *     SUM(${REPUTATION_DECAY_WEIGHT_SQL('created_at')})
 *     AS weighted_rating
 *   FROM feedback
 *
 * Computed with POWER(0.5, age_days / half_life).
 *
 * NOTE: uses NOW() — meaning the formula is non-deterministic across
 * clock skew.  Different indexers running the same query at the same
 * wall-clock will produce the same answer; different indexers running
 * at different wall-clocks will produce slightly-different answers
 * for the same chain state.  This is ACCEPTABLE because:
 *   1. The cross-indexer divergence is bounded — only the most recent
 *      review's age changes meaningfully between two clocks differing
 *      by minutes/hours.
 *   2. For older reviews (>30 days), the decay weight is barely
 *      sensitive to clock skew.
 *   3. The verifiable-receipt endpoint (cp124, H4) will accept a
 *      `as_of` parameter so callers can pin the wall-clock for
 *      deterministic comparison.
 */
/**
 * SQL fragment generator for the time-decay weight, parameterized by the
 * created-at column name (must be a trusted literal column name, never user
 * input — callers pass 'created_at' / 'f.created_at').
 *
 * cp175 F-011 NOTE: the live API queries (api/feedback.ts, api/orderbook.ts,
 * api/orderbookStream.ts) currently INLINE this formula by hand rather than
 * calling this helper (10 occurrences total), because they embed it inside
 * multi-line aggregate CASE expressions where a string-concat call site reads
 * worse. To keep the inlined literals from drifting away from
 * REPUTATION_DECAY_HALF_LIFE_DAYS, `reputation-decay-sql-constant-parity-smoke`
 * asserts every inlined `(N * 86400` literal equals the constant. This helper
 * is retained as the canonical reference (and for any future caller that wants
 * the fragment directly) — it is intentionally kept, not dead code.
 */
export function reputationDecayWeightSql(createdAtCol: string): string {
	return `POWER(0.5, EXTRACT(EPOCH FROM (NOW() - ${createdAtCol})) / (${REPUTATION_DECAY_HALF_LIFE_DAYS} * 86400.0))`;
}

/**
 * JavaScript implementation of the same formula — used by tests and
 * by the verifiable-receipt endpoint (cp124, H4) to compute scores
 * independently of the SQL aggregator.
 *
 * @param ageMs — age of the review in milliseconds (≥ 0).
 * @param halfLifeDays — half-life in days (default 365).
 * @returns weight ∈ (0, 1].
 */
export function reputationDecayWeight(
	ageMs: number,
	halfLifeDays: number = REPUTATION_DECAY_HALF_LIFE_DAYS
): number {
	if (!Number.isFinite(ageMs) || ageMs < 0) return 1;
	if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
	const ageDays = ageMs / (1000 * 60 * 60 * 24);
	return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Compute the weighted rating for a list of ratings + timestamps.
 *
 * Pure function; deterministic for fixed `now`.  Used by the
 * verifiable-receipt endpoint and by smoke tests.
 *
 * @param rows — feedback rows with rating (1-5) and createdAt (Date or ms).
 * @param now — wall-clock to compute against; defaults to Date.now().
 * @returns weighted average ∈ [1, 5] (or null if rows is empty).
 */
export function computeWeightedRating(
	rows: ReadonlyArray<{ rating: number; createdAt: Date | number }>,
	now: Date | number = Date.now()
): number | null {
	if (rows.length === 0) return null;
	const nowMs = now instanceof Date ? now.getTime() : now;
	let weightedSum = 0;
	let weightSum = 0;
	for (const r of rows) {
		const createdMs = r.createdAt instanceof Date ? r.createdAt.getTime() : r.createdAt;
		const ageMs = nowMs - createdMs;
		const w = reputationDecayWeight(ageMs);
		weightedSum += r.rating * w;
		weightSum += w;
	}
	if (weightSum === 0) return null;
	return weightedSum / weightSum;
}
