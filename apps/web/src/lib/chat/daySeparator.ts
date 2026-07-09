/**
 * Morphit — chat day grouping.
 *
 * The message log shows a hairline divider with a date centred above it at the
 * first message of each calendar day, so scrolling back through hundreds of
 * lazy-loaded messages lands you on a specific day's conversation instead of
 * making you read bubbles to work out where you are.
 *
 * Two invariants worth stating, because both have bitten date-grouping code
 * elsewhere:
 *
 *   1. GROUP IN THE SAME ZONE YOU LABEL IN. `formatDayMonth` renders in UTC
 *      (Morphit's sitewide standard — a displayed timestamp is never ambiguous
 *      about which day it means). If we grouped by the viewer's LOCAL day but
 *      labelled in UTC, a reader east of UTC would see a "9 July" heading
 *      sitting over bubbles that render as 8 July. So the day key is UTC too.
 *
 *   2. A PENDING MESSAGE HAS NO DAY. Until the chain stamps it, `createdAt` is
 *      null. Such a message inherits the previous timestamped message's day, so
 *      a divider never appears above an in-flight bubble and then disappears
 *      (or jumps) the moment it confirms.
 */

/** The minimum shape this module needs from a chat message. */
export interface DayGroupable {
	readonly createdAt: Date | null;
}

/** Stable per-UTC-calendar-day key. Not a display string — never render it. */
export function dayKeyUTC(d: Date): string {
	return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/**
 * Should a day divider be rendered above `messages[i]`, and if so, for which
 * date? Returns the Date to label, or null when no divider belongs there.
 *
 * A divider appears above the first timestamped message of each UTC day —
 * including the very first one in the log, so the oldest visible day is always
 * named rather than left implicit.
 */
export function daySeparatorAt(
	messages: readonly DayGroupable[],
	i: number
): Date | null {
	const at = messages[i]?.createdAt;
	if (!at) return null; // pending / broadcasting — no chain timestamp yet
	const key = dayKeyUTC(at);
	// Walk back to the closest message that HAS a timestamp. Consecutive
	// pending bubbles must not make the next confirmed one look like a new day.
	for (let j = i - 1; j >= 0; j--) {
		const prev = messages[j]?.createdAt;
		if (prev) return dayKeyUTC(prev) === key ? null : at;
	}
	// No earlier timestamped message — this is the first day in the log.
	return at;
}
