/**
 * Morphit indexer — cross-source disagreement monitor (cp127, defense C).
 *
 * The black-hat scenario this defends against
 * ───────────────────────────────────────────
 * Klingex (and possibly the Coingecko aggregation pipeline that
 * draws from it) gets compromised and starts returning prices with
 * a slow bias.  morphit_native continues to show real on-platform
 * prices.  The composite source's priority order is:
 *
 *   Klingex > Coingecko > morphit_native > static floor
 *
 * Because external is preferred when available, we'd publish the
 * MANIPULATED Klingex price even when our own data disagrees.
 *
 * The disagreement monitor detects when morphit_native and any
 * external source diverge materially for a sustained period.  It
 * does NOT auto-switch priority (that creates its own attack vector:
 * manipulate native to FORCE a priority flip).  Instead it makes
 * disagreement loudly visible:
 *
 *   - Logged with WARN severity on every detected divergence
 *   - Surfaced in /v1/health for operator dashboards
 *   - Exposed via /v1/price/morphit-native/receipt for forensic review
 *
 * Operators who trust their on-platform data more than external
 * feeds (likely once Morphit has substantial volume) can OPT IN to
 * priority-flip behavior via the env var
 * MORPHIT_INDEXER_PRICE_PREFER_NATIVE_WHEN_DISAGREEING.  Default:
 * false — external sources remain primary.
 *
 * Detection logic
 * ───────────────
 * Compare current morphit_native price against the price the
 * composite source actually committed (which is from the highest-
 * priority working upstream).  If they differ by more than the
 * threshold (default 25%), the disagreement is active.  Sustained
 * for 4+ hours = alert.  The 4-hour delay filters transient flickers
 * from genuine sustained divergence.
 *
 * No new database table needed; state is in-process.  On restart,
 * disagreement timer resets to zero (the disagreement, if real, will
 * be re-detected within hours).  This is an acceptable tradeoff:
 * persisting state for one purely advisory signal adds complexity
 * disproportionate to the marginal benefit.
 */

import { logger } from '$log';

const log = logger('price/disagree');

export const DISAGREEMENT_THRESHOLD = 0.25; // 25% divergence = disagreement
export const DISAGREEMENT_ALERT_SUSTAINED_HOURS = 4;

export interface DisagreementMonitorState {
	disagreementSince: Date | null;
	lastAlertFired: Date | null;
}

export interface DisagreementCheckInput {
	readonly externalPrice: number | null; // null if no external source available
	readonly externalSourceName: string | null;
	readonly nativePrice: number | null; // null if morphit_native couldn't derive
	readonly now: Date;
}

export interface DisagreementCheckResult {
	readonly active: boolean;
	readonly external_price: number | null;
	readonly external_source: string | null;
	readonly native_price: number | null;
	readonly deviation: number | null;
	readonly sustained_hours: number;
	readonly alert_fired: boolean;
}

/**
 * Stateful monitor.  Hold one instance per (asset, fiat) pair in
 * memory (typically just one for BLURT/USD in cp127).
 *
 * Pure-method-with-state pattern: the monitor's only state is the
 * "disagreement-since" timestamp.  All other inputs come from each
 * call's parameters.
 */
export class DisagreementMonitor {
	private state: DisagreementMonitorState = {
		disagreementSince: null,
		lastAlertFired: null
	};

	constructor(
		private readonly asset: string,
		private readonly denominationFiat: string,
		private readonly threshold: number = DISAGREEMENT_THRESHOLD,
		private readonly sustainedHours: number = DISAGREEMENT_ALERT_SUSTAINED_HOURS
	) {}

	/**
	 * Returns current state without mutating.  Useful for receipts
	 * + health endpoints.
	 */
	currentState(): DisagreementMonitorState {
		return {
			disagreementSince: this.state.disagreementSince,
			lastAlertFired: this.state.lastAlertFired
		};
	}

	/**
	 * Run one check; mutate state.  Returns the result for caller
	 * inspection.
	 *
	 * When external or native is null, no comparison is possible —
	 * the monitor returns inactive without alarming.  Disagreement
	 * requires BOTH sources to have produced values.
	 */
	check(input: DisagreementCheckInput): DisagreementCheckResult {
		const { externalPrice, nativePrice, now, externalSourceName } = input;

		if (
			externalPrice === null ||
			nativePrice === null ||
			externalPrice <= 0 ||
			nativePrice <= 0
		) {
			// Can't compare; not a disagreement either way.
			this.state.disagreementSince = null;
			return {
				active: false,
				external_price: externalPrice,
				external_source: externalSourceName,
				native_price: nativePrice,
				deviation: null,
				sustained_hours: 0,
				alert_fired: false
			};
		}

		const deviation = (nativePrice - externalPrice) / externalPrice;
		const active = Math.abs(deviation) > this.threshold;

		let alertFired = false;
		let sustainedHoursActual = 0;

		if (active) {
			if (this.state.disagreementSince === null) {
				this.state.disagreementSince = now;
			} else {
				const elapsedMs = now.getTime() - this.state.disagreementSince.getTime();
				sustainedHoursActual = elapsedMs / 3_600_000;
				if (sustainedHoursActual >= this.sustainedHours) {
					// Rate-limit alerts: only fire once per 24h per
					// (asset, fiat) pair, even if disagreement persists.
					// Spam-prevention.
					const lastAlert = this.state.lastAlertFired;
					const hoursSinceLastAlert =
						lastAlert === null
							? Infinity
							: (now.getTime() - lastAlert.getTime()) / 3_600_000;
					if (hoursSinceLastAlert >= 24) {
						alertFired = true;
						this.state.lastAlertFired = now;
						log.warn('price_source_disagreement', {
							asset: this.asset,
							denomination_fiat: this.denominationFiat,
							external_source: externalSourceName,
							external_price: externalPrice,
							native_price: nativePrice,
							deviation,
							sustained_hours: sustainedHoursActual,
							threshold: this.threshold
						});
					}
				}
			}
		} else {
			this.state.disagreementSince = null;
		}

		return {
			active,
			external_price: externalPrice,
			external_source: externalSourceName,
			native_price: nativePrice,
			deviation,
			sustained_hours: sustainedHoursActual,
			alert_fired: alertFired
		};
	}
}
