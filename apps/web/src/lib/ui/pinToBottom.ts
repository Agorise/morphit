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
 */

/** How long to keep re-pinning after the initial jump. */
export const PIN_SETTLE_MS = 600;

export interface PinTarget {
	scrollTop: number;
	readonly scrollHeight: number;
}

/**
 * Jump `el` to the bottom, then keep it there while its content grows, for at
 * most `settleMs`. Returns a cancel function — call it the moment the user
 * scrolls, and on destroy.
 *
 * Uses `ResizeObserver` when available (it fires on the exact layout passes we
 * care about) and falls back to an animation-frame loop otherwise.
 */
export function pinToBottom(
	el: PinTarget | null,
	opts?: { settleMs?: number; now?: () => number }
): () => void {
	if (!el) return () => {};

	const now = opts?.now ?? Date.now;
	const deadline = now() + (opts?.settleMs ?? PIN_SETTLE_MS);
	let cancelled = false;

	const pin = (): void => {
		if (cancelled) return;
		// Assign, don't animate: we want to BE at the bottom, not travel there.
		el.scrollTop = el.scrollHeight;
	};

	pin();

	let observer: ResizeObserver | null = null;
	let rafId = 0;

	const stop = (): void => {
		cancelled = true;
		if (observer) {
			observer.disconnect();
			observer = null;
		}
		if (rafId) cancelAnimationFrame(rafId);
	};

	const tick = (): void => {
		if (cancelled) return;
		if (now() >= deadline) {
			stop();
			return;
		}
		pin();
		rafId = requestAnimationFrame(tick);
	};

	if (typeof ResizeObserver !== 'undefined' && el instanceof Element) {
		observer = new ResizeObserver(() => {
			if (now() >= deadline) {
				stop();
				return;
			}
			pin();
		});
		observer.observe(el);
		// Still bound the observer's life by the deadline.
		rafId = requestAnimationFrame(tick);
	} else if (typeof requestAnimationFrame !== 'undefined') {
		rafId = requestAnimationFrame(tick);
	}

	return stop;
}
