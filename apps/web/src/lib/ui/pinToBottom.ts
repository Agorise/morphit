/**
 * Morphit — hold a scroll container at the bottom while its content settles.
 *
 * tt.txt #8: opening a conversation dropped the user into the MIDDLE of it.
 *
 * The chat had no first-load handling at all. The first batch of messages took
 * the ordinary "user was at the bottom" path, which calls
 * `scrollToBottom(smooth = true)`. Two things go wrong at once:
 *
 *   1. It scrolls SMOOTHLY toward a `scrollHeight` measured *now* — before the
 *      bubbles, identicons, day separators and web fonts have finished laying
 *      out. The target is stale before the animation finishes.
 *   2. Every late layout pass grows the list ABOVE the viewport, so the
 *      animation ends somewhere in the middle of the history.
 *
 * So on first load we jump INSTANTLY, then keep re-pinning for a short window
 * while the content is still growing. Any user scroll cancels the pin
 * immediately — nothing is more infuriating than a page that yanks you back.
 *
 * cp474 (t.txt #7) — Ken: "it STILL does not always scroll the bubble all the
 * way up so that i can see the last, most recent message". Two reasons, both
 * meaning the settle window above was never real:
 *
 *   1. The ResizeObserver watched the SCROLL CONTAINER. That container is
 *      `flex-1 overflow-y-auto` — a fixed-height viewport whose border-box does
 *      not change when its content grows. A ResizeObserver on it therefore
 *      cannot fire for the only event we care about. It was dead code, so all
 *      the re-pinning came from the rAF loop.
 *   2. The caller tore the pin down on its own scroll event (assigning
 *      `scrollTop` makes the browser fire `scroll`), so even the rAF loop was
 *      cancelled on the first frame. Fixed in ConversationView.onScroll, which
 *      now cancels only when the scroll LEAVES the bottom.
 *
 * Net effect: first load was a single instant jump, and anything that grew the
 * list afterwards — web-font swap, the Payment Receipt bubble, decrypted
 * bodies, avatars — pushed the newest message back under the fold.
 *
 * So: watch `scrollHeight`, which is the thing that actually changes, and keep
 * pinning until it has been STABLE for a quiet period rather than until a fixed
 * wall-clock deadline. A fixed deadline is a guess about how slow the slowest
 * asset is; "stable for 600ms" is the property we actually want. The hard cap
 * still bounds it, but a user scroll cancels long before either matters.
 */

/** How long the content must stop growing before we let go. */
export const PIN_SETTLE_MS = 600;

/** Absolute ceiling on pinning, however long the content keeps growing. Only
 *  reached by a genuinely pathological page; a user scroll cancels first. */
export const PIN_MAX_MS = 3_000;

export interface PinTarget {
	scrollTop: number;
	readonly scrollHeight: number;
}

/**
 * Jump `el` to the bottom, then keep it there while its content grows. Returns
 * a cancel function — call it the moment the user scrolls away, and on destroy.
 *
 * Holds on until `scrollHeight` has been STABLE for `settleMs`, bounded by
 * `maxMs`. An animation-frame loop does the measuring: cp474 removed the
 * ResizeObserver this used to prefer, because it watched the scroll CONTAINER,
 * whose fixed border-box never changes when the content inside it grows — it
 * could not fire for the one event it was there for.
 */
export function pinToBottom(
	el: PinTarget | null,
	opts?: { settleMs?: number; maxMs?: number; now?: () => number }
): () => void {
	if (!el) return () => {};

	const now = opts?.now ?? Date.now;
	const settleMs = opts?.settleMs ?? PIN_SETTLE_MS;
	const hardDeadline = now() + (opts?.maxMs ?? PIN_MAX_MS);
	let cancelled = false;

	const pin = (): void => {
		if (cancelled) return;
		// Assign, don't animate: we want to BE at the bottom, not travel there.
		el.scrollTop = el.scrollHeight;
	};

	// Track the content height so we can tell "still settling" from "settled".
	let lastHeight = el.scrollHeight;
	let lastGrowthAt = now();

	pin();

	let rafId = 0;

	const stop = (): void => {
		cancelled = true;
		if (rafId) cancelAnimationFrame(rafId);
	};

	const tick = (): void => {
		if (cancelled) return;
		const height = el.scrollHeight;
		if (height !== lastHeight) {
			// Content is still arriving — restart the quiet period. This is the
			// whole fix: a late web-font swap or a Payment Receipt bubble that lays
			// out after the old fixed deadline used to leave the user mid-history.
			lastHeight = height;
			lastGrowthAt = now();
		}
		pin();
		const settled = now() - lastGrowthAt >= settleMs;
		if (settled || now() >= hardDeadline) {
			stop();
			return;
		}
		rafId = requestAnimationFrame(tick);
	};

	if (typeof requestAnimationFrame !== 'undefined') {
		rafId = requestAnimationFrame(tick);
	} else {
		// No rAF (SSR / a bare test harness): the instant jump above is all we can
		// honestly do.
		stop();
	}

	return stop;
}
