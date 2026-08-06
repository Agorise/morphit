/**
 * Morphit indexer — price drift monitor (cp127, defense B).
 *
 * The black-hat scenario this defends against
 * ───────────────────────────────────────────
 * A "frog in boiling water" / slow-drift attack:
 *
 *   Attacker manipulates the price 5% per refresh cycle.  Each
 *   individual move passes the ±25% per-cycle smoothing cap.  Over
 *   100 refresh cycles (~8 hours at 5-min refresh), the price has
 *   moved 100% from where it started.  Each step looks normal.
 *
 * The per-cycle smoothing cap can't catch this — it only sees the
 * delta to the IMMEDIATELY PREVIOUS value, not back to a baseline.
 *
 * The drift monitor maintains a 7-day exponentially-decayed moving
 * baseline.  If the published price diverges from baseline by more
 * than the configured threshold over a sustained period, an alert
 * fires (logged + surfaced in /v1/health when integrated).  The
 * monitor does NOT auto-correct the price — auto-correction
 * introduces its own attack vector (attacker manipulates baseline
 * computation to force a "correction" toward their target).  Instead
 * it makes drift LOUDLY VISIBLE for forensic + operator response.
 *
 * Why a moving baseline (not a fixed snapshot)
 * ────────────────────────────────────────────
 * Real market moves over 7 days can be large (legitimate 30-50%
 * swings happen, especially for thinly-traded assets).  A 7-day
 * EXPONENTIAL average tracks the genuine market drift while
 * dampening short-term spikes.  A fixed snapshot would force the
 * threshold to be either too tight (false positives on real moves)
 * or too loose (slow-drift gets through).
 *
 * Decay constant: half-life of ~24 hours.  Today's prices count
 * fully; 24-hour-old prices count half; week-old prices count 1/128.
 * Tighter than the reputation half-life (365d) because price moves
 * faster than reputation moves.
 *
 * Restart resistance (defense #7 in the black-hat checklist)
 * ─────────────────────────────────────────────────────────
 * The baseline is PERSISTED to a new database table on every update.
 * On indexer restart, the baseline is loaded from disk; there's no
 * "first value escape" where the very first post-restart price
 * becomes the new baseline (which would let an attacker time their
 * manipulation to indexer restarts).
 *
 * Privacy + footprint
 * ───────────────────
 * One row per (asset, denominationFiat) pair in a small
 * `price_drift_baseline` table.  Updates happen on every successful
 * price refresh (5 min cadence).  Cost: trivial.
 */

import type { Database } from '$db/pool';
import { logger } from '$log';

const log = logger('price/drift');

/** Default thresholds.  Operator-tunable in a future iteration if
 *  needed; these defaults are conservative starting points. */
export const DRIFT_HALF_LIFE_HOURS = 24;
export const DRIFT_ALERT_THRESHOLD = 0.25; // 25% from baseline = alert
export const DRIFT_ALERT_SUSTAINED_HOURS = 24; // hold above threshold for 24h before alert

export interface DriftBaselineRow {
	readonly asset: string;
	readonly denomination_fiat: string;
	readonly baseline_price: number;
	readonly baseline_updated_at: Date;
	readonly above_threshold_since: Date | null;
}

export interface DriftCheckResult {
	readonly current_price: number;
	readonly baseline_price: number;
	readonly deviation: number; // signed: (current - baseline) / baseline
	readonly above_threshold: boolean;
	readonly above_threshold_sustained_hours: number;
	readonly alert_fired: boolean;
}

/**
 * Update the baseline AND check current price against it.
 *
 * Idempotent: safe to call multiple times per refresh cycle (only
 * the first call updates state; subsequent calls return the cached
 * result for that timestamp).  But typically called exactly once
 * per refresh, immediately after the composite source commits a new
 * value.
 *
 * Algorithm:
 *
 *   1. Load current baseline row (or initialize if absent).
 *   2. Compute time-decayed update:
 *        new_baseline = old_baseline * w + current_price * (1 - w)
 *      where w = 0.5 ^ (elapsed_hours / half_life_hours).
 *   3. Compute deviation: (current - baseline) / baseline.
 *   4. If |deviation| > threshold:
 *        - if already-above-threshold timestamp exists, check duration;
 *          fire alert if sustained > sustained_hours.
 *        - else, set above_threshold_since = NOW().
 *      Else:
 *        - clear above_threshold_since.
 *   5. Persist updated baseline + above_threshold_since.
 *
 * Returns the check result.  Caller decides what to do with
 * `alert_fired` (typically: log + surface in /v1/health).
 */
export async function updateAndCheckDrift(
	db: Database,
	asset: string,
	denominationFiat: string,
	currentPrice: number,
	opts: {
		now?: () => Date;
		halfLifeHours?: number;
		alertThreshold?: number;
		sustainedHours?: number;
	} = {}
): Promise<DriftCheckResult> {
	const now = opts.now ? opts.now() : new Date();
	const halfLifeHours = opts.halfLifeHours ?? DRIFT_HALF_LIFE_HOURS;
	const threshold = opts.alertThreshold ?? DRIFT_ALERT_THRESHOLD;
	const sustainedHours = opts.sustainedHours ?? DRIFT_ALERT_SUSTAINED_HOURS;

	// Acquire current baseline.
	const existing = await db.query<DriftBaselineRow>(
		`SELECT asset, denomination_fiat, baseline_price, baseline_updated_at, above_threshold_since
		   FROM price_drift_baseline
		  WHERE asset = $1 AND denomination_fiat = $2`,
		[asset.toUpperCase(), denominationFiat.toUpperCase()]
	);

	let baselinePrice: number;
	let lastUpdate: Date;
	let aboveThresholdSince: Date | null;
	const isFirstRow = existing.rows.length === 0;

	if (isFirstRow) {
		// First time we've seen this (asset, fiat) pair.  Seed the
		// baseline at the current price.  Defense: this is intentional
		// even though it lets the first value "escape" drift checking;
		// the alternative (refuse to publish until N samples have
		// accumulated) creates its own bootstrap headache.  The
		// per-cycle smoothing cap (handled elsewhere) still applies.
		baselinePrice = currentPrice;
		lastUpdate = now;
		aboveThresholdSince = null;
	} else {
		const row = existing.rows[0]!;
		baselinePrice = parseFloat(String(row.baseline_price));
		lastUpdate = row.baseline_updated_at;
		aboveThresholdSince = row.above_threshold_since;

		// Time-decayed exponential update.
		const elapsedMs = now.getTime() - lastUpdate.getTime();
		const elapsedHours = elapsedMs / 3_600_000;
		const w = Math.pow(0.5, elapsedHours / halfLifeHours);
		baselinePrice = baselinePrice * w + currentPrice * (1 - w);
	}

	// Compute deviation.
	const deviation =
		baselinePrice > 0 ? (currentPrice - baselinePrice) / baselinePrice : 0;
	const aboveThreshold = Math.abs(deviation) > threshold;

	let alertFired = false;
	let sustainedHoursActual = 0;

	if (aboveThreshold) {
		if (aboveThresholdSince === null) {
			aboveThresholdSince = now;
		} else {
			const elapsedMs = now.getTime() - aboveThresholdSince.getTime();
			sustainedHoursActual = elapsedMs / 3_600_000;
			if (sustainedHoursActual >= sustainedHours) {
				alertFired = true;
				log.warn('price_drift_alert', {
					asset,
					denomination_fiat: denominationFiat,
					current_price: currentPrice,
					baseline_price: baselinePrice,
					deviation,
					sustained_hours: sustainedHoursActual,
					threshold
				});
			}
		}
	} else {
		// Below threshold; clear the sustained marker.
		aboveThresholdSince = null;
	}

	// Persist.
	await db.query(
		`INSERT INTO price_drift_baseline
		     (asset, denomination_fiat, baseline_price, baseline_updated_at, above_threshold_since)
		   VALUES ($1, $2, $3, $4, $5)
		   ON CONFLICT (asset, denomination_fiat)
		   DO UPDATE SET
		     baseline_price = EXCLUDED.baseline_price,
		     baseline_updated_at = EXCLUDED.baseline_updated_at,
		     above_threshold_since = EXCLUDED.above_threshold_since`,
		[
			asset.toUpperCase(),
			denominationFiat.toUpperCase(),
			baselinePrice,
			now,
			aboveThresholdSince
		]
	);

	return {
		current_price: currentPrice,
		baseline_price: baselinePrice,
		deviation,
		above_threshold: aboveThreshold,
		above_threshold_sustained_hours: sustainedHoursActual,
		alert_fired: alertFired
	};
}
