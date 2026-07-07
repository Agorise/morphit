/**
 * Morphit — locale-prefixed URL helpers.
 *
 * Part of the per-locale prerendering system (ADR: design doc at
 * `docs/PER-LOCALE-PRERENDERING-DESIGN.md`).
 *
 * When the route tree is restructured under `[lang]/`, every internal
 * link / programmatic navigation needs to carry the user's current
 * locale prefix. These helpers centralize the prefix logic so call
 * sites don't hand-roll string concatenation.
 *
 * Principles:
 *   - Every locale, including the default, gets a prefix. Symmetric
 *     URL structure prevents analytics / canonical-tag asymmetry.
 *   - Idempotent: calling localePath on an already-prefixed URL is
 *     a no-op. Safe to wrap unknown inputs without worrying about
 *     double-prefixing.
 *   - Query strings and hash fragments are preserved verbatim.
 *   - Prefix detection matches ONLY the 10 supported locale codes.
 *     A bare alphabetic pattern like `[a-z]{2,4}` would false-
 *     positive on route segments (e.g. treat `/my/orders` as
 *     "locale my + path /orders" — catastrophic). Keeping the
 *     alternation exact means drift between this helper and the
 *     i18n registry is caught by the test suite.
 *
 * @see docs/PER-LOCALE-PRERENDERING-DESIGN.md
 */

import type { LocaleCode } from '$i18n';

/**
 * Regex matching ONLY the 10 supported Morphit locale codes at the
 * start of a URL path. Order matters — match the multi-segment
 * codes (`zh-CN`, `zh-HK`) before the 2-letter codes so a path
 * like `/zh-HK/faq` isn't partially matched as `/zh`.
 *
 * If SUPPORTED_LOCALES in `$i18n` changes, this alternation must
 * be updated to match. The test suite catches drift via the
 * round-trip test.
 */
const SUPPORTED_LOCALE_PATTERN = /^\/(zh-CN|zh-HK|en|es|de|pl|fr|it|ru|fa)(?=\/|$)/;

/**
 * Attach a locale prefix to a route path.
 *
 * @example
 *   localePath('/orderbook', 'es')    // '/es/orderbook'
 *   localePath('/', 'de')              // '/de/'
 *   localePath('/faq?tag=fees', 'fr') // '/fr/faq?tag=fees'
 *   localePath('/es/orderbook', 'es') // '/es/orderbook' (idempotent)
 *   localePath('/en/orderbook', 'de') // '/de/orderbook' (rewrite)
 *
 * @param path Absolute path starting with '/'. May include query
 *             string and/or hash fragment. Relative paths are not
 *             supported (will return unchanged).
 * @param lang Target locale code. Caller must ensure this is a
 *             supported code — no validation here to keep the
 *             helper dependency-free.
 */
export function localePath(path: string, lang: LocaleCode): string {
	// Bail on inputs that don't look like absolute paths. Relative
	// URLs, external links (https://), and protocol-relative (//)
	// pass through unchanged. The locale prefix only applies to
	// internal routes.
	if (!path || !path.startsWith('/') || path.startsWith('//')) {
		return path;
	}

	// Split off query + hash so we can rewrite the path portion
	// cleanly. URL parsing would be heavier than needed; we want
	// only the first '?' and '#' semantics.
	const hashIdx = path.indexOf('#');
	const queryIdx = path.indexOf('?');
	let splitAt = -1;
	if (queryIdx >= 0 && hashIdx >= 0) splitAt = Math.min(queryIdx, hashIdx);
	else if (queryIdx >= 0) splitAt = queryIdx;
	else if (hashIdx >= 0) splitAt = hashIdx;

	const pathOnly = splitAt >= 0 ? path.slice(0, splitAt) : path;
	const suffix = splitAt >= 0 ? path.slice(splitAt) : '';

	// Is the path already locale-prefixed? If so, replace the
	// existing prefix with the target locale. We match ONLY the
	// 10 supported Morphit locale codes — a generic `[a-z]{2,4}`
	// pattern would false-positive on route segments like `/my/`
	// or `/faq/` that happen to be 2-4 chars.
	const prefixMatch = SUPPORTED_LOCALE_PATTERN.exec(pathOnly);
	if (prefixMatch) {
		const rest = pathOnly.slice(prefixMatch[0].length);
		return `/${lang}${rest || '/'}${suffix}`;
	}

	// No existing prefix — attach one. Ensure the trailing slash
	// behavior matches the input: '/' stays '/' under prefix.
	if (pathOnly === '/') {
		return `/${lang}/${suffix.replace(/^/, '')}`;
	}
	return `/${lang}${pathOnly}${suffix}`;
}

/**
 * Parse a locale-prefixed URL back into {lang, path}. The inverse
 * of `localePath()`. Used by the language picker to navigate to
 * the same page in a different locale — compute (lang, path)
 * from `window.location.pathname`, then apply `localePath(path, newLang)`.
 *
 * Returns `null` if the path doesn't start with a recognizable
 * locale prefix.
 *
 * @example
 *   fromLocalePath('/es/orderbook')       // { lang: 'es', path: '/orderbook' }
 *   fromLocalePath('/zh-HK/faq')          // { lang: 'zh-HK', path: '/faq' }
 *   fromLocalePath('/en/')                 // { lang: 'en', path: '/' }
 *   fromLocalePath('/orderbook')           // null (no prefix)
 */
export function fromLocalePath(path: string): { lang: string; path: string } | null {
	if (!path || !path.startsWith('/')) return null;
	// Match the same 10 supported locale codes as localePath(), but
	// also capture the delimiter (`/` or end-of-string) so the caller
	// can slice the rest of the path correctly.
	const prefixMatch = /^\/(zh-CN|zh-HK|en|es|de|pl|fr|it|ru|fa)(\/|$)/.exec(path);
	if (!prefixMatch || !prefixMatch[1]) return null;
	const lang = prefixMatch[1];
	const rest = path.slice(prefixMatch[0].length);
	return { lang, path: `/${rest}` };
}
