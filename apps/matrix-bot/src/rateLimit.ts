/**
 * Rate limiter — sliding-window for WARN-tier alerts.
 *
 * Policy: at most one WARN alert per category per hour.
 * "Category" = `<module>:<kind>` (the AlertCategory type).
 *
 * Why per-category not global: if both `operator-balance:LOW_BALANCE`
 * and `witness-fee:CHANGED` fire in the same hour, the operator
 * should see BOTH — they're distinct problems.  Suppressing the
 * second because the first burnt the global budget would be a bug.
 *
 * Why persisted: an operator restarting the bot mid-hour
 * shouldn't reset all rate-limit windows — that would let
 * recently-suppressed events through and could flood the
 * operator immediately after restart.  Windows survive in SQLite.
 *
 * CRITICAL alerts bypass this entirely — they go straight to the
 * matrix client.  WARN alerts come here first.  INFO alerts go
 * to the digest accumulator instead.
 */

import type { AlertCategory } from './classifier.ts';
import type { State } from './state.ts';

/** Default window: 1 hour. */
const WARN_WINDOW_MS = 60 * 60 * 1000;

export interface RateLimiter {
	/** Returns true if this category is currently in cooldown.
	 *  Side-effect-free check.  Use this to decide whether to
	 *  deliver. */
	isLimited(category: AlertCategory, nowMs: number): boolean;

	/** Records a delivery.  Subsequent isLimited() calls within
	 *  the window will return true. */
	recordDelivery(category: AlertCategory, nowMs: number): void;

	/** Returns the count of WARN alerts SUPPRESSED in the
	 *  current window for this category.  Used by the digest
	 *  builder to surface "you got 47 LOW_BALANCE alerts in the
	 *  past 24h but we only DM'd you once". */
	getSuppressedCount(category: AlertCategory, sinceMs: number): number;

	/** Records that we suppressed a delivery (so we can surface
	 *  the count in the daily digest later). */
	recordSuppression(category: AlertCategory, nowMs: number): void;
}

export function createRateLimiter(state: State, windowMs = WARN_WINDOW_MS): RateLimiter {
	return {
		isLimited(category: AlertCategory, nowMs: number): boolean {
			const lastDelivery = state.getLastDelivery(category);
			if (lastDelivery === null) return false;
			return nowMs - lastDelivery < windowMs;
		},

		recordDelivery(category: AlertCategory, nowMs: number): void {
			state.setLastDelivery(category, nowMs);
		},

		getSuppressedCount(category: AlertCategory, sinceMs: number): number {
			return state.countSuppressions(category, sinceMs);
		},

		recordSuppression(category: AlertCategory, nowMs: number): void {
			state.insertSuppression(category, nowMs);
		}
	};
}
