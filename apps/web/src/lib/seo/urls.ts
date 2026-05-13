/**
 * Morphit — SEO URL helpers.
 *
 * The production origin is fixed at build time. Development and preview
 * servers run on different origins, but the emitted SEO metadata always
 * points at the canonical production URL so that hreflang / canonical /
 * sitemap references remain stable.
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
 * Build the full set of hreflang alternates for a given path. Morphit uses
 * query-string-based locale switching (the active locale lives in
 * client state, not in the URL), so the alternate URL for `es` on `/faq`
 * is `/faq?lang=es` rather than `/es/faq`. This is the second form of
 * hreflang Google's docs call out as valid.
 *
 * Includes `x-default` pointing at the English root, which Google uses
 * when no other hreflang matches the user's browser language.
 */
export function hreflangAlternates(path: string): Array<{ hreflang: string; href: string }> {
	const p = path.startsWith('/') ? path : `/${path}`;
	const out: Array<{ hreflang: string; href: string }> = [];
	for (const loc of SUPPORTED_LOCALES) {
		// The default locale gets the bare URL; others carry ?lang= so
		// a user arriving from a localized SERP sees the right language
		// without a client-side redirect loop.
		const href =
			loc.code === DEFAULT_LOCALE
				? `${CANONICAL_ORIGIN}${p}`
				: `${CANONICAL_ORIGIN}${p}${p.includes('?') ? '&' : '?'}lang=${loc.code}`;
		out.push({ hreflang: loc.code, href });
	}
	out.push({ hreflang: 'x-default', href: `${CANONICAL_ORIGIN}${p}` });
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
