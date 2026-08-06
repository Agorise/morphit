/**
 * Morphit — scrolling to a section that is behind a lazy dynamic import.
 *
 * `/my/orders` opens two panels on click — the Feature form and the "Mark this
 * trade complete" review form — and both are `{#await import(...)}` chunks.
 * Both scroll helpers did the same thing:
 *
 *     let attempts = 0;
 *     const tryScroll = () => { … else if (attempts++ < 40) requestAnimationFrame(tryScroll); };
 *
 * 40 animation frames is ~0.66s at 60fps. That is a **rendering** budget being
 * spent on a **network** wait: on a cold click the chunk is still downloading,
 * the element never appears inside 40 frames, and the page silently doesn't
 * scroll. Ken watched exactly that happen.
 *
 * Two fixes, both needed:
 *
 *   1. AWAIT THE CHUNK. The import is cached, so the second click costs nothing;
 *      the first one waits for the real thing it was implicitly waiting for.
 *   2. BOUND THE RETRY BY WALL CLOCK, NOT FRAMES. `requestAnimationFrame` is
 *      throttled to roughly one call per second in a background tab, so a frame
 *      count silently becomes a many-second timeout there and a sub-second one
 *      in the foreground. A deadline means the same thing everywhere.
 *
 * The target element is expected to carry `scroll-mt-24` (6rem ≈ 1in) so it
 * lands a breath below the viewport top rather than flush against it.
 */

import { tick } from 'svelte';

/** How long to keep looking for the element after its chunk has loaded. */
export const SCROLL_RETRY_BUDGET_MS = 5_000;

/**
 * Load `loadChunk`, wait for Svelte to flush the DOM, then smooth-scroll to
 * `#{elementId}`. Resolves once the scroll has been requested (or abandoned).
 *
 * Returns `true` if the element was found and scrolled to, `false` otherwise —
 * useful in tests, ignored by callers.
 */
export async function scrollToLazySection(
	elementId: string,
	loadChunk: () => Promise<unknown>,
	opts?: { now?: () => number; budgetMs?: number }
): Promise<boolean> {
	if (typeof window === 'undefined' || typeof document === 'undefined') return false;
	try {
		await loadChunk();
	} catch {
		// The caller's `{:catch}` branch renders a LazyLoadError; nothing to scroll to.
		return false;
	}
	await tick();

	const now = opts?.now ?? Date.now;
	const deadline = now() + (opts?.budgetMs ?? SCROLL_RETRY_BUDGET_MS);

	return new Promise<boolean>((resolve) => {
		const tryScroll = (): void => {
			const el = document.getElementById(elementId);
			if (el) {
				el.scrollIntoView({ behavior: 'smooth', block: 'start' });
				resolve(true);
				return;
			}
			if (now() < deadline) {
				requestAnimationFrame(tryScroll);
			} else {
				resolve(false);
			}
		};
		requestAnimationFrame(tryScroll);
	});
}
