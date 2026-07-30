/**
 * Morphit indexer — composite reputation score (cp404).
 *
 * The orderbook shows TWO distinct trust signals per trader, side by side:
 *   • the TRADE COUNT (raw `feedback_count`, e.g. "852" / "1.4K") — how
 *     much history exists; and
 *   • the REPUTATION SCORE (0–5, e.g. "4.06") — how GOOD that history is.
 *
 * The raw time-decayed average (`weighted_rating`) answers "what's the mean
 * star rating," but a reputation score should reward *sustained good
 * behaviour* and resist a newcomer looking like a veteran off one glowing
 * (possibly fake) review. So the score is a compilation of several factors,
 * all derived from the SAME sock-puppet-filtered feedback the rest of the
 * reputation system uses (suspicious_reciprocity / related_accounts /
 * one_way_pile_on / review_concentration exclusions already applied upstream):
 *
 *   1. RATING QUALITY — the time-decayed mean rating, Bayesian-shrunk toward
 *      a neutral prior so few reviews stay cautious and can't spike the score.
 *      This is where volume earns trust: as good trades accumulate, the shrunk
 *      rating rises toward the true (high) mean.
 *   2. EXPERIENCE — a log-scaled function of the trade count, saturating at
 *      EXPERIENCE_FULL. A long track record is worth more, with diminishing
 *      returns.
 *   3. RECENCY — recent activity keeps a reputation "fresh"; long dormancy
 *      gently discounts the bonus (a great trader who vanished for years is
 *      still good, just less demonstrably current).
 *
 * Factors 2 and 3 enter ONLY as a bounded bonus that is gated on the rating
 * already being ABOVE neutral and scales with how far above — so good
 * behaviour is rewarded, while experience/recency can never inflate a poor
 * or mediocre rating (a high-volume scammer stays low). This is the key
 * fairness property Ken asked for: "good behaviour is rewarded."
 *
 * TRANSPARENT + VERIFIABLE: the /v1/accounts/:account/reputation-receipt
 * endpoint returns the factor breakdown so any reader can re-derive the
 * score from the raw feedback rows and confirm it — the same "show your
 * work" posture as the underlying weighted_rating.
 *
 * A trader with ZERO included feedback has NO score (returns null) — the
 * card shows nothing for reputation and the 🌱 sprout chip signals newness
 * instead.
 */

/** Neutral prior mean on the 1–5 scale (a brand-new trader sits here). */
export const REPUTATION_PRIOR_MEAN = 3.0;
/** Prior strength: how many "neutral reviews" of inertia a trader must
 *  outweigh with real feedback before the score reflects their true mean.
 *  Higher = more caution for low-volume traders. */
export const REPUTATION_PRIOR_WEIGHT = 4;
/** Trade count at which the experience factor saturates (full credit). */
export const REPUTATION_EXPERIENCE_FULL = 40;
/** Half-life (days) of the recency bonus decay. */
export const REPUTATION_RECENCY_HALF_LIFE_DAYS = 180;
/** Maximum track-record bonus (points) added to a perfect-rated,
 *  high-volume, currently-active trader. */
export const REPUTATION_BONUS_MAX = 0.5;

export interface ReputationScoreInputs {
	/** Raw count of INCLUDED feedback rows (sock-puppet-filtered). */
	readonly count: number;
	/** Time-decayed mean rating (1–5), or null when count is 0. */
	readonly weightedAvg: number | null;
	/** ms since epoch of the most recent included feedback, or null. */
	readonly lastFeedbackAtMs: number | null;
	/** Wall-clock reference (ms since epoch). Defaults to Date.now(). */
	readonly asOfMs?: number;
}

export interface ReputationScoreBreakdown {
	/** Final composite score (0–5, 2-decimal), or null when no feedback. */
	readonly score: number | null;
	/** Shrunk time-decayed rating before the bonus (the "base"). */
	readonly base: number | null;
	/** Track-record bonus actually applied (points). */
	readonly bonus: number;
	/** 0–1 experience fraction (log-scaled trade count). */
	readonly experienceFrac: number;
	/** 0–1 recency fraction (decays with dormancy). */
	readonly recencyFrac: number;
}

function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n;
}

/** Round to 2 decimals (matches the NUMERIC(3,2) rating precision). */
function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * Compute the composite reputation score with its factor breakdown.
 * Pure — no I/O, no clock reads except the asOfMs default.
 */
export function computeReputationScoreDetailed(
	inputs: ReputationScoreInputs
): ReputationScoreBreakdown {
	const { count, weightedAvg } = inputs;
	if (count <= 0 || weightedAvg === null || !Number.isFinite(weightedAvg)) {
		return { score: null, base: null, bonus: 0, experienceFrac: 0, recencyFrac: 0 };
	}

	// 1. Rating quality — Bayesian shrinkage of the time-decayed mean toward
	//    the neutral prior. Few reviews → close to neutral; many → true mean.
	const base =
		(count * weightedAvg + REPUTATION_PRIOR_WEIGHT * REPUTATION_PRIOR_MEAN) /
		(count + REPUTATION_PRIOR_WEIGHT);

	// 2. Experience — log-scaled, saturating at EXPERIENCE_FULL.
	const experienceFrac = clamp(
		Math.log1p(count) / Math.log1p(REPUTATION_EXPERIENCE_FULL),
		0,
		1
	);

	// 3. Recency — decays with days since last feedback.
	const asOfMs = inputs.asOfMs ?? Date.now();
	let recencyFrac = 1;
	if (inputs.lastFeedbackAtMs !== null && Number.isFinite(inputs.lastFeedbackAtMs)) {
		const ageDays = Math.max(0, (asOfMs - inputs.lastFeedbackAtMs) / 86_400_000);
		recencyFrac = Math.pow(0.5, ageDays / REPUTATION_RECENCY_HALF_LIFE_DAYS);
	}

	// Bonus gate: only ABOVE-neutral ratings earn a bonus, scaled by how far
	// above neutral they are (0 at the prior mean, 1 at a perfect 5). This is
	// what stops experience/recency from rescuing a poor or mediocre trader.
	const aboveNeutral = clamp(
		(base - REPUTATION_PRIOR_MEAN) / (5 - REPUTATION_PRIOR_MEAN),
		0,
		1
	);
	const bonus = REPUTATION_BONUS_MAX * experienceFrac * recencyFrac * aboveNeutral;

	return {
		score: round2(clamp(base + bonus, 0, 5)),
		base: round2(base),
		bonus: round2(bonus),
		experienceFrac: round2(experienceFrac),
		recencyFrac: round2(recencyFrac)
	};
}

/** Convenience: the composite score only (0–5, 2-decimal), or null. */
export function computeReputationScore(inputs: ReputationScoreInputs): number | null {
	return computeReputationScoreDetailed(inputs).score;
}
