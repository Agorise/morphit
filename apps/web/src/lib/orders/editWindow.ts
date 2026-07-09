/**
 * Morphit — the 15-minute free-edit window.
 *
 * An order can be edited free of charge for 15 minutes after it is posted.
 * After that it must be cancelled and re-posted, so the deadline is real money
 * and the user deserves to see it running out rather than discover it has.
 *
 * The rule lived twice: once in `/my/orders` (with a countdown pill) and once
 * in the order-detail page (as a bare boolean, no countdown at all — you could
 * sit on that page watching an `Edit` button that had silently stopped working).
 * Same class of bug as the featured cards: one surface got the signal, the
 * identical surface beside it didn't. So it lives here now, once, and is
 * unit-tested.
 *
 * Both callers must pass a ticking `nowMs`, not call `Date.now()` internally —
 * a countdown that only recomputes when something else happens to re-render is
 * a countdown that lies.
 */

/** Free-edit window: 15 minutes from the order's creation. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Seconds left in the edit window, or `null` once it has closed (or if the
 * timestamp is unparseable — an order we can't date is one we won't offer to
 * edit).
 *
 * @param createdAt ISO timestamp of the order's creation.
 * @param nowMs     the caller's ticking clock.
 */
export function editWindowRemainingSeconds(createdAt: string, nowMs: number): number | null {
	const createdMs = new Date(createdAt).getTime();
	if (!Number.isFinite(createdMs)) return null;
	const remaining = createdMs + EDIT_WINDOW_MS - nowMs;
	if (remaining <= 0) return null;
	return Math.ceil(remaining / 1000);
}

/** True while the order may still be edited free of charge. */
export function withinEditWindow(createdAt: string, nowMs: number): boolean {
	return editWindowRemainingSeconds(createdAt, nowMs) !== null;
}

/**
 * `4m 20s` — the shape Ken asked for. Under a minute it drops the minutes part
 * entirely (`9s`, not `0m 9s`).
 *
 * Deliberately NOT zero-padded: this reproduces `/my/orders`' existing pill
 * byte-for-byte. Padding would look tidier, but changing a rendering nobody
 * asked me to change is how a "shared helper" quietly becomes a regression.
 */
export function formatRemainingMmSs(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const minutes = Math.floor(s / 60);
	const seconds = s % 60;
	if (minutes === 0) return `${seconds}s`;
	return `${minutes}m ${seconds}s`;
}
