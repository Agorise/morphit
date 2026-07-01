/**
 * Robust multi-source rate aggregation.
 *
 * Shared by the FX (USD→fiat) and crypto (→USD) price subsystems.
 * Both fetch from several independent providers concurrently; this
 * collapses those readings into ONE committed value in a way that
 * resists a single misbehaving source.
 *
 * WHY NOT A PLAIN MEAN
 * ────────────────────
 * A naive arithmetic mean is dragged by outliers: with 3 sources
 * where one is 30% off, the mean shifts ~10% — precisely the price
 * swing we're trying to damp.  Instead we anchor on the MEDIAN
 * (which a single outlier can't move with ≥3 sources), drop any
 * reading more than `outlierTolerance` away from the median, and
 * average only the survivors ("inliers").  Result:
 *   - 1 source            → that value (nothing to cross-check)
 *   - 2 sources, agree     → their mean
 *   - 2 sources, disagree  → their midpoint (median), both flagged
 *                            as rejected so the operator sees it
 *   - 3+ sources, 1 wild   → the outlier is discarded, the rest
 *                            averaged (smooth + outlier-immune)
 *
 * The function never throws and returns null only when there are
 * zero usable (finite, positive) readings — the caller then falls
 * back to its static table / floor.
 */

export interface RobustAggregate {
	/** The committed value: mean of the inliers (or the median when
	 *  every reading was an outlier of every other). */
	readonly value: number;
	/** The median of all usable readings — the robust anchor. */
	readonly median: number;
	/** How many readings survived as inliers and fed the mean. */
	readonly contributors: number;
	/** How many usable (finite, positive) readings were considered. */
	readonly considered: number;
	/** considered − inliers: how many readings were rejected as
	 *  outliers (a sustained nonzero value is a disagreement signal
	 *  worth surfacing on the health view). */
	readonly rejected: number;
}

/**
 * @param values            raw readings from each source (NaN/≤0 ignored)
 * @param outlierTolerance  relative band around the median to keep,
 *                          e.g. 0.02 = keep readings within ±2% of
 *                          the median.  FX ~0.02; crypto ~0.05.
 */
export function aggregateRobust(
	values: readonly number[],
	outlierTolerance: number
): RobustAggregate | null {
	const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
	if (usable.length === 0) return null;
	if (usable.length === 1) {
		const v = usable[0]!;
		return { value: v, median: v, contributors: 1, considered: 1, rejected: 0 };
	}

	const sorted = [...usable].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

	const band = Math.abs(median) * Math.max(0, outlierTolerance);
	const inliers = usable.filter((v) => Math.abs(v - median) <= band);

	// If tolerance is tight and the two middle readings straddle the
	// median far apart (e.g. exactly two wildly-disagreeing sources),
	// inliers can be empty — commit the median (their midpoint) and
	// report everything as rejected so the disagreement is visible.
	const used = inliers.length > 0 ? inliers : [median];
	const value = used.reduce((s, v) => s + v, 0) / used.length;

	return {
		value,
		median,
		contributors: inliers.length > 0 ? inliers.length : 1,
		considered: usable.length,
		rejected: usable.length - inliers.length
	};
}
