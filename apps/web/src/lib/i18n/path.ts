/**
 * Morphit — per-locale URL path + Accept-Language picker helpers.
 *
 * Pure utilities for the per-locale prerendering pipeline (Option C
 * per docs/PER-LOCALE-PRERENDERING-DESIGN.md).  These helpers are
 * deliberately decoupled from SvelteKit's load() / page-store
 * runtime so they can be unit-smoked without a working
 * `npm run build`:
 *
 *   - `localePath(path, lang?)`: wrap a bare path (e.g. `/orderbook`)
 *     with the supplied or default locale prefix, returning
 *     `/<lang>/orderbook`.  This is the centraliser the design doc
 *     calls for ("every `<a href="/orderbook">` becomes
 *     `<a href={localePath('/orderbook')}>` ").  Idempotent — calling
 *     it on an already-prefixed path returns the path unchanged,
 *     so authors can use it defensively at any link site.
 *
 *   - `pickLocaleFromAcceptLanguages(prefs)`: pure-function
 *     navigator-style picker used by the detection-redirect shell at
 *     the root.  Takes an ordered list of BCP-47 tags
 *     (`navigator.languages[]` at runtime) and returns the
 *     best-matching SUPPORTED_LOCALE code.  Falls back to
 *     `DEFAULT_LOCALE` when nothing matches.
 *
 * Why a separate module from `$i18n` itself: the design's
 * detection-redirect shell at the root `+page.svelte` must NOT
 * pull in the full svelte-i18n bundle (otherwise the redirect
 * shell HTML carries the same bytes as a fully-rendered page,
 * defeating the purpose).  Keeping the picker pure means the
 * shell can import THIS module without dragging in svelte-i18n.
 *
 * The route-tree restructure under `[lang]/` is the remaining work;
 * this file ships the pieces that don't need a working SvelteKit
 * build to verify.  See docs/PER-LOCALE-PRERENDERING-DESIGN.md for
 * the full implementation plan and remaining gaps.
 */

import { SUPPORTED_LOCALES, DEFAULT_LOCALE, matchSupported, type LocaleCode } from './locales';

/** All currently-supported locale codes as a Set for O(1) membership tests. */
const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_LOCALES.map((l) => l.code));

/**
 * Return the locale-prefixed form of a bare path.
 *
 *   localePath('/orderbook', 'es')        → '/es/orderbook'
 *   localePath('/', 'de')                 → '/de'
 *   localePath('/faq')                    → '/en/faq'         (default)
 *   localePath('/es/orderbook', 'es')     → '/es/orderbook'   (idempotent)
 *   localePath('/zh-HK/post', 'fa')       → '/fa/post'        (re-prefix to new locale)
 *
 * Inputs must be absolute paths (start with `/`).  Trailing slashes
 * are preserved.  Query strings and fragments are preserved verbatim.
 * If the input already starts with a supported locale prefix, that
 * prefix is replaced with the requested one — so a language-switcher
 * widget can call `localePath($page.url.pathname, newLang)` and get
 * the right destination regardless of what locale the current page
 * is on.
 *
 * The function never throws; an invalid `lang` falls back to
 * `DEFAULT_LOCALE`.  A non-absolute path is returned unchanged
 * (caller probably passed a fragment-only or query-only string, in
 * which case prefixing would be wrong).
 */
export function localePath(path: string, lang?: LocaleCode): string {
	const target: LocaleCode =
		lang !== undefined && SUPPORTED_SET.has(lang) ? lang : DEFAULT_LOCALE;

	if (path.length === 0 || !path.startsWith('/')) {
		// Non-absolute input — preserve verbatim.  Callers passing
		// `?lang=es` or `#section` shouldn't get a locale prefix.
		return path;
	}

	// Split path / query / fragment.  We only manipulate the path
	// component; query + fragment ride along untouched.
	let pathPart = path;
	let queryPart = '';
	let fragmentPart = '';
	const fragIdx = pathPart.indexOf('#');
	if (fragIdx >= 0) {
		fragmentPart = pathPart.slice(fragIdx);
		pathPart = pathPart.slice(0, fragIdx);
	}
	const qIdx = pathPart.indexOf('?');
	if (qIdx >= 0) {
		queryPart = pathPart.slice(qIdx);
		pathPart = pathPart.slice(0, qIdx);
	}

	// Detect existing locale prefix.  Segment after the leading `/`
	// must exactly match a SUPPORTED_LOCALES code.
	const segments = pathPart.split('/'); // ['', 'es', 'orderbook'] for /es/orderbook
	const firstSegment = segments[1] ?? '';

	let stripped: string;
	if (SUPPORTED_SET.has(firstSegment)) {
		// Replace existing prefix.  The remainder may be '' (was
		// just /es) or '/orderbook…'.
		stripped = '/' + segments.slice(2).join('/');
		if (stripped === '/') stripped = '';
	} else {
		// No existing prefix.  Strip leading slash so we can
		// concatenate cleanly.
		stripped = pathPart === '/' ? '' : pathPart;
	}

	return `/${target}${stripped}${queryPart}${fragmentPart}`;
}

/**
 * Strip a locale prefix from a path, returning the bare path.
 *
 *   stripLocalePrefix('/es/orderbook')  → '/orderbook'
 *   stripLocalePrefix('/de')            → '/'
 *   stripLocalePrefix('/orderbook')     → '/orderbook'   (no prefix to strip)
 *   stripLocalePrefix('/zh-HK/faq')     → '/faq'
 *
 * Useful for the language-switcher widget that wants to swap to a
 * different locale while keeping the user on the same page:
 * `localePath(stripLocalePrefix(currentPath), newLang)`.
 *
 * Query strings and fragments are preserved.
 */
export function stripLocalePrefix(path: string): string {
	if (path.length === 0 || !path.startsWith('/')) return path;
	let pathPart = path;
	let queryPart = '';
	let fragmentPart = '';
	const fragIdx = pathPart.indexOf('#');
	if (fragIdx >= 0) {
		fragmentPart = pathPart.slice(fragIdx);
		pathPart = pathPart.slice(0, fragIdx);
	}
	const qIdx = pathPart.indexOf('?');
	if (qIdx >= 0) {
		queryPart = pathPart.slice(qIdx);
		pathPart = pathPart.slice(0, qIdx);
	}
	const segments = pathPart.split('/');
	const firstSegment = segments[1] ?? '';
	if (!SUPPORTED_SET.has(firstSegment)) return path; // nothing to strip
	const remainder = segments.slice(2).join('/');
	const stripped = remainder === '' ? '/' : '/' + remainder;
	return `${stripped}${queryPart}${fragmentPart}`;
}

/**
 * Pick the best-matching supported locale from an ordered list of
 * BCP-47 tags (typically `navigator.languages`).
 *
 * Walks `prefs` in order; the first entry that matches a supported
 * locale (via the existing `matchSupported()` mapping that also
 * handles `zh-Hant`/`zh-Hans` script variants and language-family
 * fallback) wins.  Returns `DEFAULT_LOCALE` ('en') when no entry
 * matches.
 *
 *   pickLocaleFromAcceptLanguages(['pl', 'en-US', 'en'])      → 'pl'
 *   pickLocaleFromAcceptLanguages(['zh-TW'])                  → 'zh-HK' (Traditional → HK)
 *   pickLocaleFromAcceptLanguages(['zh-Hans-CN'])             → 'zh-CN' (Simplified → CN)
 *   pickLocaleFromAcceptLanguages(['de-AT'])                  → 'de'    (family match)
 *   pickLocaleFromAcceptLanguages(['ko', 'ja', 'vi'])         → 'en'    (no match)
 *   pickLocaleFromAcceptLanguages([])                         → 'en'    (no signal)
 *
 * Pure function — no DOM, no window, no localStorage.  Designed to
 * be safe to import into the root-level redirect shell that must
 * not pull svelte-i18n into the prerendered bundle.
 *
 * Contrast with `pickInitialLocale()` (internal to $i18n): that one
 * does URL query + localStorage + navigator preference cascade and
 * is intended for the post-hydration client-side flow.  This helper
 * is the navigator-only slice for the prerender-redirect shell.
 */
export function pickLocaleFromAcceptLanguages(prefs: readonly string[]): LocaleCode {
	for (const tag of prefs) {
		if (typeof tag !== 'string' || tag.length === 0) continue;
		const hit = matchSupported(tag);
		if (hit) return hit;
	}
	return DEFAULT_LOCALE;
}

/**
 * Check if a path string is already locale-prefixed.
 *
 *   isLocalePrefixed('/es/orderbook')   → true
 *   isLocalePrefixed('/orderbook')      → false
 *   isLocalePrefixed('/zh-HK/')         → true
 *
 * Useful at link sites that want to short-circuit `localePath()`
 * when the input is already correct.  `localePath()` is itself
 * idempotent so this isn't required for correctness — it's a
 * performance + clarity helper.
 */
export function isLocalePrefixed(path: string): boolean {
	if (path.length === 0 || !path.startsWith('/')) return false;
	const segments = path.split('/');
	const firstSegment = segments[1] ?? '';
	return SUPPORTED_SET.has(firstSegment);
}
