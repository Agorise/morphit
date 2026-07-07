/**
 * Viewport / device media-query stores.
 *
 * Thin, SSR-safe wrappers over `window.matchMedia`. On the server (and
 * before hydration) they read their `initial` value — chosen as the
 * desktop/no-match case so prerendered HTML matches the most common
 * first paint — then reconcile to the real match once mounted.
 *
 * Use these only where the difference can't be expressed in pure CSS
 * (e.g. rounding a number differently on mobile). For show/hide and
 * text swaps, prefer Tailwind responsive utilities or the
 * `pointer-fine:` / `pointer-coarse:` variants, which need no JS and
 * have no hydration gap.
 */
import { readable } from 'svelte/store';
import { browser } from '$app/environment';

function mediaQueryStore(query: string, initial = false) {
	return readable(initial, (set) => {
		if (!browser) return;
		const mql = window.matchMedia(query);
		set(mql.matches);
		const onChange = (e: MediaQueryListEvent) => set(e.matches);
		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
	});
}

/**
 * True on phone-width viewports (below Tailwind's `md` breakpoint,
 * 768px). SSR/initial value is `false` (desktop). Pairs with the
 * `md:` responsive boundary used for the matching CSS swaps.
 */
export const isMobileViewport = mediaQueryStore('(max-width: 767px)');
