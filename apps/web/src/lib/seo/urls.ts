/**
 * Morphit — SEO URL helpers.
 *
 * WHOSE ORIGIN. Every instance serves the same prebuilt frontend, so the
 * absolute URLs in its SEO metadata (canonical, hreflang, og:url, og:image,
 * JSON-LD, sitemap, robots, llms.txt) must name THAT instance — never
 * morphit.io on someone else's site, and no clearnet URL at all on a
 * hidden-only instance. So:
 *   - in the browser, `siteOrigin()` is the page's own origin;
 *   - in the prerendered HTML it is the BUILD origin (morphit.io for the
 *     release build) wrapped in invisible U+2063 markers. The build records
 *     each marked place (apps/web/scripts/origin-slots.mjs → build/.origin-
 *     slots.json) and strips the markers; `morphit-ops` install/upgrade then
 *     rewrites those places with the instance's own origin. The root
 *     index.html (on the on-chain integrity manifest) carries none.
 * The build origin exists only in server-side (prerender) code: the client
 * bundle carries no fixed site origin.
 *
 * URL shape (post per-locale prerendering, ADR-0003 follow-up):
 *
 *   /            — language-detection redirect shell; also x-default
 *   /en/         — English prerendered
 *   /es/         — Spanish prerendered
 *   /zh-CN/      — Simplified Chinese prerendered
 *   ...etc for every SUPPORTED_LOCALE
 *
 * Hreflang always points at the canonical URL of each language — `/es/faq`,
 * not `/faq?lang=es` — matching the path-based `/[lang]/...` routing and the
 * `/{locale}{path}` URLs the sitemap emits.
 */

import { building } from '$app/environment';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type LocaleCode } from '$i18n';

/** Marks the build origin in prerendered output (U+2063 INVISIBLE SEPARATOR);
 *  apps/web/scripts/origin-slots.mjs records and strips every marked place. */
export const ORIGIN_SLOT_MARK = '\u2063';

/** The site origin for absolute URLs: the page's own origin in the browser
 *  (`runtimeOrigin`, e.g. `$page.url.origin`, else `window.location.origin`);
 *  in prerender, the marked build origin (see the header); on the dev server,
 *  the request's origin. */
export function siteOrigin(runtimeOrigin?: string): string {
	if (import.meta.env.SSR) {
		// Prerender: `$page.url.origin` is SvelteKit's placeholder origin, never
		// the site's.
		if (building) return `${ORIGIN_SLOT_MARK}${__MORPHIT_SITE_ORIGIN__}${ORIGIN_SLOT_MARK}`;
		return runtimeOrigin ?? __MORPHIT_SITE_ORIGIN__;
	}
	if (runtimeOrigin) return runtimeOrigin;
	return typeof window !== 'undefined' ? window.location.origin : '';
}

/** Build a full canonical URL for a given path (no query/hash). */
export function canonicalFor(path: string, runtimeOrigin?: string): string {
	const p = path.startsWith('/') ? path : `/${path}`;
	return `${siteOrigin(runtimeOrigin)}${p}`;
}

/**
 * Strip a `/{locale}` prefix off a path, returning the locale (or null)
 * and the rest of the path.  Used by hreflang to convert
 * `/es/faq` back to `/faq` before re-prefixing for each alternate.
 *
 * Exported for the canonical-hreflang-consistency smoke + the
 * sitemap-style URL generators that mirror this transformation.
 */
export function stripLocalePrefix(path: string): {
	locale: LocaleCode | null;
	rest: string;
} {
	const p = path.startsWith('/') ? path : `/${path}`;
	const m = p.match(/^\/([a-z]{2}(?:-[A-Za-z]{2,4})?)(?:\/(.*))?$/);
	if (!m) return { locale: null, rest: p };
	const code = m[1];
	const known = SUPPORTED_LOCALES.some((l) => l.code === code);
	if (!known) return { locale: null, rest: p };
	// rest captures `''` for `/es` and `''` for `/es/`; treat both as root.
	const rest = m[2] === undefined || m[2] === '' ? '' : `/${m[2]}`;
	return { locale: code as LocaleCode, rest };
}

/**
 * Compose the canonical URL for a (locale, restPath) pair, mirroring the
 * exact pattern the sitemap emits via `scripts/build-sitemap.mjs`.  Root
 * paths get a trailing slash (`/en/`); deeper paths don't (`/en/faq`).
 * Exported for the consistency smoke.
 */
export function localizedUrl(locale: LocaleCode, restPath: string, runtimeOrigin?: string): string {
	const p = restPath.startsWith('/') ? restPath : `/${restPath}`;
	const suffix = p === '/' || p === '' ? `/${locale}/` : `/${locale}${p}`;
	return `${siteOrigin(runtimeOrigin)}${suffix}`;
}

/**
 * Build the full set of hreflang alternates for a given path.  Morphit
 * routes are path-based at `/[lang]/...`, so the alternate URL for `es`
 * on `/en/faq` is `/es/faq` — the same URL the user would see in their
 * browser bar after switching languages.  Hreflang values must match
 * the URLs in the sitemap byte-for-byte (Google joins the two signals).
 *
 * The caller passes either a localed path (`/es/faq`) or a bare path
 * (`/faq`) — both work; we strip the prefix and re-emit.
 *
 * Includes `x-default` pointing at the bare path (no locale prefix),
 * which mirrors the sitemap's x-default entries.  Google uses x-default
 * when no other hreflang matches the user's browser language.
 */
export function hreflangAlternates(
	path: string,
	runtimeOrigin?: string
): Array<{ hreflang: string; href: string }> {
	const { rest } = stripLocalePrefix(path);
	const restPath = rest === '' ? '/' : rest;
	const origin = siteOrigin(runtimeOrigin);
	const out: Array<{ hreflang: string; href: string }> = [];
	for (const loc of SUPPORTED_LOCALES) {
		out.push({ hreflang: loc.code, href: localizedUrl(loc.code, restPath, runtimeOrigin) });
	}
	// x-default — bare path, no locale prefix.  Mirrors sitemap.xml.
	out.push({
		hreflang: 'x-default',
		href: restPath === '/' ? `${origin}/` : `${origin}${restPath}`
	});
	return out;
}

/**
 * Map a Morphit locale code → an Open Graph–conformant `language_TERRITORY`
 * code (audit fix A10/A11).
 *
 * Facebook's OG spec requires `<meta property="og:locale">` to be in
 * `language_TERRITORY` form (e.g. `en_US`, `zh_CN`).  Emitting bare 2-letter
 * codes like `en` or `es` causes some scrapers to fall back to default-
 * locale handling, weakening the share-preview signal.
 *
 * For territory-less codes we pick the most-common region pairing
 * (e.g. `en` → `en_US`, `es` → `es_ES`, `fr` → `fr_FR`).  The Persian
 * pairing is `fa_IR` (Iran), which is the largest Persian-speaking
 * population and the de-facto default for the language tag.
 *
 * For the two CJK codes we already carry the region (`zh-CN`, `zh-HK`)
 * so the mapping is the byte-for-byte canonical OG form with hyphen→
 * underscore.
 *
 * Reference: https://developers.facebook.com/docs/internationalization
 */
const OG_LOCALE_MAP: Record<string, string> = {
	en: 'en_US',
	es: 'es_ES',
	de: 'de_DE',
	pl: 'pl_PL',
	fr: 'fr_FR',
	it: 'it_IT',
	ru: 'ru_RU',
	fa: 'fa_IR',
	'zh-CN': 'zh_CN',
	'zh-HK': 'zh_HK'
};
export function ogLocale(code: LocaleCode | string | null | undefined): string {
	const c = (code as string | null | undefined) ?? DEFAULT_LOCALE;
	return OG_LOCALE_MAP[c] ?? c.replace('-', '_');
}

/**
 * Return all OG-conformant locales EXCEPT the current one — used to emit
 * `<meta property="og:locale:alternate">` tags.  Same shape as
 * hreflangAlternates() but for the OG signal.
 */
export function ogLocaleAlternates(currentCode: LocaleCode | string): string[] {
	const current = ogLocale(currentCode);
	return SUPPORTED_LOCALES.map((l) => ogLocale(l.code)).filter((c) => c !== current);
}
