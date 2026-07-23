/**
 * Morphit ops CLI — time + duration formatting.
 *
 * Pure logic: takes Dates and numbers, returns strings.  No
 * dep on pg or render so individual commands can pull just
 * what they need.
 */

/** Render a Date as relative time from now ("3m ago", "2h ago",
 *  "5d ago", "just now").  Uses the SAME bucket boundaries as
 *  the web frontend's relative time helper for consistency. */
export function relativeTime(when: Date, now: Date = new Date()): string {
	const ms = now.getTime() - when.getTime();
	if (ms < 0) {
		// In the future — rare but possible if clocks disagree.
		return 'in the future';
	}
	const sec = Math.floor(ms / 1000);
	if (sec < 5) return 'just now';
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mon = Math.floor(day / 30);
	if (mon < 12) return `${mon}mo ago`;
	const yr = Math.floor(day / 365);
	return `${yr}y ago`;
}

/** Render a duration in seconds as a human-readable string
 *  ("5m 30s", "1h 14m", "2d 3h").  Always includes the second-
 *  largest unit for precision (e.g. "1h 14m" not just "1h"). */
export function formatDuration(seconds: number): string {
	if (seconds < 0) return '0s';
	const s = Math.floor(seconds);
	if (s < 60) return `${s}s`;
	const min = Math.floor(s / 60);
	const remSec = s % 60;
	if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
	const day = Math.floor(hr / 24);
	const remHr = hr % 24;
	return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

/** Compute seconds between two Dates (now - then). */
export function ageSeconds(when: Date, now: Date = new Date()): number {
	return Math.floor((now.getTime() - when.getTime()) / 1000);
}

/** UTC midnight at the start of today, as a Date. */
export function utcMidnightToday(now: Date = new Date()): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Parse "24h", "1d", "10m" etc. into seconds.  Returns null on
 *  invalid format.  Used by the --since flags. */
export function parseDurationSpec(spec: string): number | null {
	// v1.8.12 — "all" means no window. Added because `morphit-ops moderation`
	// now tells an operator that older flags are still suppressing reputation
	// and points them at `--since=all`; advice that errors out would be worse
	// than the silence it replaced. 100 years is effectively unbounded here
	// while staying a real number the existing cutoff arithmetic can use.
	if (spec.trim().toLowerCase() === 'all') return 100 * 365 * 86400;
	const m = spec.match(/^(\d+)\s*(s|m|h|d)$/i);
	if (!m) return null;
	const n = parseInt(m[1]!, 10);
	if (isNaN(n) || n < 0) return null;
	const unit = m[2]!.toLowerCase();
	switch (unit) {
		case 's':
			return n;
		case 'm':
			return n * 60;
		case 'h':
			return n * 3600;
		case 'd':
			return n * 86400;
		default:
			return null;
	}
}
