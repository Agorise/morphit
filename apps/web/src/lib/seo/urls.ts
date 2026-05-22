/**
 * Morphit — SEO URL helpers.
 *
 * The production origin is fixed at build time. Development and preview
 * servers run on different origins, but the emitted SEO metadata always
 * points at the canonical production URL so that hreflang / canonical /
 * sitemap references remain stable.
 *
 * URL shape (post per-locale prerendering, ADR-0003 follow-up):
 *
 *   /            — language-detection redirect shell; also x-default
 *   /en/         — English prerendered
 *   /es/         — Spanish prerendered
 *   /zh-CN/      — Simplified Chinese prerendered
 *   ...etc for every SUPPORTED_LOCALE
 *
 * Older revisions of this file used `?lang=<code>` query-string form
 * for hreflang alternates, which conflicted with both the SvelteKit
 * routing (which is path-based at `/[lang]/...`) AND the sitemap
 * (which emits `/{locale}{path}` URLs).  Hreflang must always point
 * at the canonical URL of each language — `/es/faq`, not `/faq?lang=es`.
 * Fixed cp112.
 */

import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type LocaleCode } from '$i18n';

/** The production origin used in canonical URLs + sitemap + OG tags. */
export const CANONICAL_ORIGIN = 'https://morphit.io';

/** Build a full canonical URL for a given path (no query/hash). */
export function canonicalFor(path: string): string {
	const p = path.startsWith('/') ? path : `/${path}`;
	return `${CANONICAL_ORIGIN}${p}`;
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
export function localizedUrl(locale: LocaleCode, restPath: string): string {
	const p = restPath.startsWith('/') ? restPath : `/${restPath}`;
	const suffix = p === '/' || p === '' ? `/${locale}/` : `/${locale}${p}`;
	return `${CANONICAL_ORIGIN}${suffix}`;
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
export function hreflangAlternates(path: string): Array<{ hreflang: string; href: string }> {
	const { rest } = stripLocalePrefix(path);
	const restPath = rest === '' ? '/' : rest;
	const out: Array<{ hreflang: string; href: string }> = [];
	for (const loc of SUPPORTED_LOCALES) {
		out.push({ hreflang: loc.code, href: localizedUrl(loc.code, restPath) });
	}
	// x-default — bare path, no locale prefix.  Mirrors sitemap.xml.
	out.push({
		hreflang: 'x-default',
		href: restPath === '/' ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${restPath}`
	});
	return out;
}

/**
 * For JSON-LD — the base URL identity of the site. Google matches
 * `Organization` nodes by `url`, so this must stay stable.
 */
export function siteUrl(): string {
	return CANONICAL_ORIGIN;
}

/** Return the locale we should emit in `<html lang="…">` for a given code. */
export function htmlLang(code: LocaleCode | string | null | undefined): string {
	return (code as string | null | undefined) ?? DEFAULT_LOCALE;
}
