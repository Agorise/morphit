/**
 * Morphit — per-instance brand: runtime store.
 *
 * See ./brandName.ts for the full design. In short, the SAME canonical frontend
 * serves every federated instance, and the operator's brand (set with
 * `morphit-ops branding`, docs/BRANDING.md) reaches the page at runtime:
 *
 *   1. Prerendered pages carry it on the root element, written server-side by
 *      `morphit-ops branding apply`:
 *        <html data-brand-name="Vigilante Trading" data-brand-beta="off">
 *      (a canonical, unbranded page carries data-brand-name="Morphit"). Read
 *      SYNCHRONOUSLY at module load — before the locale bundle loads and before
 *      hydration — so the dictionary is branded from its very first use and
 *      hydration finds text that already matches. No network, no flash.
 *
 *   2. The SPA fallback shell (index.html — every non-prerendered route: chat
 *      threads, profiles, orders, explorer) has NO data-brand-* attributes,
 *      because index.html is covered by the on-chain tamper check and nothing may
 *      rewrite it. There, [lang]/+layout.ts awaits `ensureBrand()`, which fetches
 *      /brand/brand.json (tiny, same-origin, served stale-while-revalidate by the
 *      service worker) before the page renders. Nothing was server-rendered on
 *      those routes, so there is nothing to flash.
 *
 * During PRERENDER (`building`), every brand slot is bracketed by an invisible
 * sentinel so scripts/build-brand-slots.mjs can find it in the emitted HTML (it
 * records the slots, then strips the sentinels).
 */

import { writable, derived, get, type Readable } from 'svelte/store';
import { browser, building } from '$app/environment';
import { fetchWithTimeout } from '$net/fetchWithTimeout';
import {
	DEFAULT_BRAND_NAME,
	BRAND_SLOT_SENTINEL,
	sanitizeBrandName,
	type BrandRenderer
} from './brandName';

export interface BrandState {
	/** The site's brand name ("Morphit" on an unbranded instance). */
	readonly name: string;
	/** Show the red "BETA" marker over the header/hero/footer logo. */
	readonly betaBadge: boolean;
	/** Where the values came from — `default` until something better is known. */
	readonly source: 'default' | 'page' | 'json';
}

/** Served by every instance; rewritten by `morphit-ops branding apply`. */
export const BRAND_JSON_PATH = '/brand/brand.json';

/** How long the SPA-fallback shell waits for brand.json before rendering with
 *  the default brand (clearnet budget; Tor/I2P get the transport floor). */
const BRAND_FETCH_TIMEOUT_MS = 3_000;

const DEFAULT_STATE: BrandState = { name: DEFAULT_BRAND_NAME, betaBadge: true, source: 'default' };

/** Read the brand a prerendered page was stamped with, if any. */
function readFromDocument(): BrandState | null {
	if (!browser) return null;
	const ds = document.documentElement.dataset;
	const name = sanitizeBrandName(ds.brandName);
	if (name === null) return null;
	return { name, betaBadge: ds.brandBeta !== 'off', source: 'page' };
}

/** Mirror the resolved brand onto <html> so CSS (the BETA marker) and any later
 *  synchronous reader agree with the store — needed on the SPA-fallback shell,
 *  whose markup was never stamped server-side. Also the iOS home-screen label:
 *  Safari reads `apple-mobile-web-app-title` from the live DOM when the visitor
 *  taps "Add to Home Screen", and the shell's static tag says "Morphit". */
function stampDocument(state: BrandState): void {
	if (!browser) return;
	const ds = document.documentElement.dataset;
	ds.brandName = state.name;
	ds.brandBeta = state.betaBadge ? 'on' : 'off';
	const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
	if (apple !== null && state.source !== 'default') apple.setAttribute('content', state.name);
}

/** Longest the SPA shell holds its first render for /brand/brand.json. A plain
 *  wall-clock cap — NOT raised by the hidden-transport floor: on a stalled Tor
 *  circuit the page renders with the default name and the brand is applied in
 *  place when it arrives (the fetch keeps going). */
export const BRAND_WAIT_MS = 3_000;

const store = writable<BrandState>(readFromDocument() ?? DEFAULT_STATE);

/** The instance's brand. Components normally use `$brandName` instead. */
export const brand: Readable<BrandState> = { subscribe: store.subscribe };

/**
 * How to render a brand slot, given the slot's default form ("Morphit", or a
 * locale's inflected/transliterated `{brand|…}` form):
 *   - prerender → the default form bracketed by the slot sentinel, so the
 *     post-build step can locate (and later rewrite) every slot in the HTML;
 *   - unbranded instance → the default form, unchanged (copy stays word-for-word);
 *   - branded instance → the operator's brand, uninflected.
 */
export function brandRenderer(state: BrandState = get(store)): BrandRenderer {
	if (building) return (form) => BRAND_SLOT_SENTINEL + form + BRAND_SLOT_SENTINEL;
	if (state.name === DEFAULT_BRAND_NAME) return (form) => form;
	const name = state.name;
	return () => name;
}

/** The brand text for a plain (uninflected) slot, right now. */
export function brandTextNow(): string {
	return brandRenderer()(DEFAULT_BRAND_NAME);
}

/** Reactive brand text — use in markup: `alt={$brandName}`. */
export const brandName: Readable<string> = derived(store, ($b) =>
	brandRenderer($b)(DEFAULT_BRAND_NAME)
);

let pending: Promise<BrandState> | null = null;

/** ensureBrand(), but give up WAITING after `ms` (the fetch continues and the
 *  store updates when it lands). */
export function ensureBrandWithin(ms: number): Promise<BrandState> {
	const p = ensureBrand();
	if (!browser) return p;
	return Promise.race([
		p,
		new Promise<BrandState>((resolve) => setTimeout(() => resolve(get(store)), ms))
	]);
}

/**
 * Resolve the brand before first render. Instant (no network) on a stamped,
 * prerendered page; otherwise fetches /brand/brand.json once per session.
 * Never throws — any failure resolves to the default brand.
 */
export function ensureBrand(): Promise<BrandState> {
	if (!browser) return Promise.resolve(get(store));
	const current = get(store);
	if (current.source !== 'default') return Promise.resolve(current);
	if (pending !== null) return pending;
	pending = (async (): Promise<BrandState> => {
		let next: BrandState = { ...DEFAULT_STATE, source: 'json' };
		try {
			const res = await fetchWithTimeout(
				BRAND_JSON_PATH,
				{ credentials: 'same-origin', cache: 'no-cache' },
				BRAND_FETCH_TIMEOUT_MS
			);
			if (res.ok) {
				const body: unknown = await res.json();
				if (body !== null && typeof body === 'object') {
					const b = body as { name?: unknown; beta_badge?: unknown };
					next = {
						name: sanitizeBrandName(b.name) ?? DEFAULT_BRAND_NAME,
						betaBadge: b.beta_badge !== false,
						source: 'json'
					};
				}
			}
		} catch {
			// Offline / slow / malformed → default brand. The page still works.
		}
		stampDocument(next);
		store.set(next);
		return next;
	})();
	return pending;
}
