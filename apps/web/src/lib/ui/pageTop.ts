/**
 * Morphit — show the top of the page when a page swaps its whole content.
 *
 * Several pages are wizards that move from step to step by changing a state
 * value (`phase`) rather than by navigating: post an order (form → review →
 * password → posting → done / error), edit an order, set up 2FA. SvelteKit
 * scrolls to the top on a NAVIGATION, never on a state change, so the browser
 * kept the old scroll offset: pressing Continue at the bottom of the long
 * step 3 opened step 4 already scrolled down, its heading out of sight, and
 * every later step the same (v1.21.17, reported on Firefox).
 *
 * `topOnChange()` returns a tracker to call with each new value from an
 * $effect; it scrolls to the top whenever the value differs from the last one
 * it saw — never on the first call, so it does not fight SvelteKit's own
 * scroll restoration when the page is reached with Back.
 */

/** Instant, so nothing animates under a reduced-motion setting either. */
export function scrollToPageTop(): void {
	if (typeof window === 'undefined') return;
	try {
		window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
	} catch {
		// jsdom has no scrolling; a browser that rejects the options form
		// still takes the two-number one.
		try {
			window.scrollTo(0, 0);
		} catch {
			/* nothing to scroll */
		}
	}
}

export function topOnChange<T>(
	opts: {
		/** Leaving these values does not scroll: the page's first load (a
		 *  'loading' placeholder) ends where SvelteKit put it. */
		readonly quietFrom?: readonly T[];
		readonly scroll?: () => void;
	} = {}
): (value: T) => void {
	const scroll = opts.scroll ?? scrollToPageTop;
	let seen = false;
	let last: T | undefined;
	return (value: T): void => {
		if (seen && !Object.is(value, last) && !(opts.quietFrom ?? []).includes(last as T)) scroll();
		seen = true;
		last = value;
	};
}
