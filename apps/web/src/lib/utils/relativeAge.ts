/**
 * How long ago something happened, as ONE unit and a count: the ladder every
 * "5m" / "2h" / "3d" / "3mo" / "1y" in the app is built from (v1.21.17).
 *
 * It lived as three copies (RelativeTime, the chat inbox tooltip, the
 * orderbook expiry chip). All three ROUNDED DOWN to whole 30-day months, so an
 * order posted 89 days ago — a few hours short of its 90-day expiry — read
 * "Posted 2mo ago" on the day it expired. Minutes, hours and days still count
 * whole units (a day is not "1d" until it has passed); months and years are
 * rounded to the NEAREST one, by their average calendar length, because "2mo"
 * for 2.95 months reads as a different time, not as a less precise one.
 *
 *   < 1 minute          → lt1m
 *   < 1 hour            → minutes (whole)
 *   < 1 day             → hours (whole)
 *   < 30 days           → days (whole)
 *   < 365 days          → months, nearest, 1–11
 *   otherwise           → years, nearest, at least 1
 *
 * A time in the future (clock skew) counts as now. Pure: no stores, no DOM.
 */
export type AgeUnit = 'lt1m' | 'minutes' | 'hours' | 'days' | 'months' | 'years';

const DAYS_PER_MONTH = 365.25 / 12; // 30.4375
const DAYS_PER_YEAR = 365.25;

export function relativeAge(thenMs: number, nowMs: number): { unit: AgeUnit; n: number } {
	const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
	if (seconds < 60) return { unit: 'lt1m', n: 0 };
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return { unit: 'minutes', n: minutes };
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return { unit: 'hours', n: hours };
	const days = seconds / 86_400;
	if (days < 30) return { unit: 'days', n: Math.floor(days) };
	if (days < 365) {
		return { unit: 'months', n: Math.min(11, Math.max(1, Math.round(days / DAYS_PER_MONTH))) };
	}
	return { unit: 'years', n: Math.max(1, Math.round(days / DAYS_PER_YEAR)) };
}
