/**
 * Morphit — per-instance brand: runtime store.
 *
 * See ./brandName.ts for the full design. In short, the SAME canonical frontend
 * serves every federated instance, and the operator's brand (set with
 * `morphit-ops branding`, docs/BRANDING.md) reaches the page at runtime:
 *
 *   1. Prerendered pages carry it on the root element, written server-side by
 *      `morphit-ops branding apply`:
 *        <html data-brand-name="Vigilante Trading">
 *      (a canonical, unbranded page carries data-brand-name="Morphit"). Read
 *      SYNCHRONOUSLY at module load — before the locale bundle loads and before
 *      hydration — so the dictionary is branded from its very first use and
 *      hydration finds text that already matches. No network, no flash.
 *
 *   2. The SPA fallback shell (index.html — every non-prerendered route: chat
 *      threads, profiles, orders, explorer) has NO data-brand-* attributes,
 *      because index.html is covered by the on-chain tamper check and nothing may
 *      rewrite it. It links /brand/theme.css instead (v1.21.8): render-blocking,
 *      so before the first paint — and before this module runs (scripts wait for
 *      a head stylesheet) — it has set the colours and `--brand-name-hex`, which
 *      is read here SYNCHRONOUSLY too. No page shows another site's look first,
 *      not even for an instant (vigilante.trading, 2026-10-13: the profile page
 *      painted Morphit's background, and after a re-brand rendered as Morphit).
 *   3. Only when theme.css names no site (an unbranded instance, or branding
 *      applied by an older ops-cli) does [lang]/+layout.ts await `ensureBrand()`,
 *      which fetches /brand/brand.json (the service worker serves brand files
 *      network-first) before the page renders.
 *
 * COLOUR THEME (docs/BRANDING.md, "Colours"). Every brand/surface colour is a
 * CSS custom property (src/theme.css). A themed instance's prerendered pages
 * carry an `<style id="morphit-theme">html:root{…}</style>` written by
 * `morphit-ops branding apply` — correct on first paint, without JavaScript and
 * in Tor Browser. The SPA shell can't carry it (index.html is on the tamper
 * manifest): there /brand/theme.css carries the colours (v1.21.8), and only
 * where theme.css names no site (branding applied by an older ops-cli) does
 * `ensureBrand()` apply brand.json's `theme.tokens` to <html> as inline custom
 * properties (applyTheme) before the page renders.
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
	BRAND_NAME_CSS_PROP,
	decodeBrandNameCssHex,
	sanitizeBrandName,
	type BrandRenderer
} from './brandName';
import { applyTheme, THEME_STYLE_ID } from './applyTheme';

export { applyTheme };

export interface BrandState {
	/** The site's brand name ("Morphit" on an unbranded instance). */
	readonly name: string;
	/** Where the values came from — `default` until something better is known. */
	readonly source: 'default' | 'page' | 'css' | 'json';
}

/** Served by every instance; rewritten by `morphit-ops branding apply`. */
export const BRAND_JSON_PATH = '/brand/brand.json';

/** Linked from every page's head (app.html), render-blocking; rewritten by
 *  `morphit-ops branding apply` with the instance's colours and name. */
export const BRAND_THEME_CSS_PATH = '/brand/theme.css';

/** How long the SPA-fallback shell waits for brand.json before rendering with
 *  the default brand (clearnet budget; Tor/I2P get the transport floor). */
const BRAND_FETCH_TIMEOUT_MS = 3_000;

const DEFAULT_STATE: BrandState = { name: DEFAULT_BRAND_NAME, source: 'default' };

/** Read the brand a prerendered page was stamped with, if any. */
function readFromDocument(): BrandState | null {
	if (!browser) return null;
	const ds = document.documentElement.dataset;
	const name = sanitizeBrandName(ds.brandName);
	if (name === null) return null;
	return { name, source: 'page' };
}

/** The name /brand/theme.css carries, or null (it names none: an unbranded
 *  instance, or branding applied by an older ops-cli). */
function readFromStylesheet(): BrandState | null {
	if (!browser) return null;
	const raw = getComputedStyle(document.documentElement).getPropertyValue(BRAND_NAME_CSS_PROP);
	const name = decodeBrandNameCssHex(raw);
	return name === null ? null : { name, source: 'css' };
}

/** Resolves once /brand/theme.css has loaded (or failed). Scripts already wait
 *  for a head stylesheet, so this is normally immediate; it is the belt to that
 *  rule's braces. */
function stylesheetSettled(): Promise<void> {
	if (!browser) return Promise.resolve();
	const link = document.querySelector<HTMLLinkElement>(
		`link[rel="stylesheet"][href$="${BRAND_THEME_CSS_PATH}"]`
	);
	if (link === null || link.sheet !== null) return Promise.resolve();
	return new Promise<void>((resolve) => {
		link.addEventListener('load', () => resolve(), { once: true });
		link.addEventListener('error', () => resolve(), { once: true });
		setTimeout(resolve, BRAND_WAIT_MS);
	});
}

/** Mirror the resolved brand onto <html> so any later synchronous reader
 *  agrees with the store — needed on the SPA-fallback shell,
 *  whose markup was never stamped server-side. Also the iOS home-screen label:
 *  Safari reads `apple-mobile-web-app-title` from the live DOM when the visitor
 *  taps "Add to Home Screen", and the shell's static tag says "Morphit". */
function stampDocument(state: BrandState): void {
	if (!browser) return;
	const ds = document.documentElement.dataset;
	ds.brandName = state.name;
	const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
	if (apple !== null && state.source !== 'default') apple.setAttribute('content', state.name);
}

/** Longest the SPA shell holds its first render for /brand/brand.json. A plain
 *  wall-clock cap — NOT raised by the hidden-transport floor: on a stalled Tor
 *  circuit the page renders with the default name and the brand is applied in
 *  place when it arrives (the fetch keeps going). */
export const BRAND_WAIT_MS = 3_000;

/** The browser's toolbar colour (theme-color meta) from the colours
 *  /brand/theme.css set — on the pages the app draws in the browser the shared
 *  shell's meta says Morphit's green, and brand.json (which also carries it)
 *  arrives after the first paint, or never. Same token as applyTheme (the
 *  gradient's middle stop). A prerendered page's meta was rewritten by
 *  branding and is left alone. */
function themeColorFromStylesheet(): void {
	if (!browser) return;
	if (document.getElementById(THEME_STYLE_ID) !== null) return;
	const raw = getComputedStyle(document.documentElement).getPropertyValue('--brand-2-rgb').trim();
	const m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(raw);
	if (m === null) return;
	const rgb = [m[1], m[2], m[3]].map(Number);
	if (rgb.some((v) => v > 255)) return;
	const hex = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
	document.querySelector('meta[name="theme-color"]')?.setAttribute('content', hex);
}

const initial: BrandState = readFromDocument() ?? readFromStylesheet() ?? DEFAULT_STATE;
if (initial.source === 'css') {
	stampDocument(initial);
	themeColorFromStylesheet();
}
const store = writable<BrandState>(initial);

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

/** brand.json, or null (offline, slow, malformed). */
async function fetchBrandJson(): Promise<{ name?: unknown; theme?: unknown } | null> {
	try {
		const res = await fetchWithTimeout(
			BRAND_JSON_PATH,
			{ credentials: 'same-origin', cache: 'no-cache' },
			BRAND_FETCH_TIMEOUT_MS
		);
		if (!res.ok) return null;
		const body: unknown = await res.json();
		// (A `beta_badge` field from an older ops-cli is ignored: the BETA
		// marker was removed in v1.21.5.)
		return body !== null && typeof body === 'object'
			? (body as { name?: unknown; theme?: unknown })
			: null;
	} catch {
		return null;
	}
}

/**
 * Resolve the brand before first render. Instant (no network) on a stamped,
 * prerendered page, and wherever /brand/theme.css names the site (brand.json
 * is then never read); otherwise fetches /brand/brand.json once per session.
 * Never throws — any failure resolves to the default brand.
 */
export function ensureBrand(): Promise<BrandState> {
	if (!browser) return Promise.resolve(get(store));
	const current = get(store);
	// theme.css named the site: it carries the colours too, and the toolbar
	// colour was taken from it. brand.json is not read at all — a copy the
	// browser stored before a re-brand would paint the old colours over the
	// new ones (v1.21.8).
	if (current.source !== 'default') return Promise.resolve(current);
	if (pending !== null) return pending;
	pending = (async (): Promise<BrandState> => {
		await stylesheetSettled();
		const css = readFromStylesheet();
		if (css !== null) {
			stampDocument(css);
			themeColorFromStylesheet();
			store.set(css);
			return css;
		}
		let next: BrandState = { ...DEFAULT_STATE, source: 'json' };
		const b = await fetchBrandJson();
		if (b !== null) {
			applyTheme(b.theme);
			next = { name: sanitizeBrandName(b.name) ?? DEFAULT_BRAND_NAME, source: 'json' };
		}
		stampDocument(next);
		store.set(next);
		return next;
	})();
	return pending;
}
