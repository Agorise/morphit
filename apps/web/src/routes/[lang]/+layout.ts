/**
 * [lang]/+layout.ts — per-locale route subtree configuration.
 *
 * Part 121 cp7 (per-locale prerendering route restructure, ADR-0024,
 * design doc docs/PER-LOCALE-PRERENDERING-DESIGN.md, Option C).
 *
 * Every route under `apps/web/src/routes/[lang]/` inherits this:
 *
 *   - `prerender = true` — emit one HTML file per (route × locale).
 *     With 20 indexable routes × 10 supported locales, the build
 *     produces 200 prerendered pages.
 *
 *   - `ssr = true` — server-side render at build time so the HTML
 *     ships in the right language, no client-side string swap, no
 *     flash-of-English-content.
 *
 *   - `entries()` enumerates the {lang} parameter values for the
 *     prerender crawler.  Without this, SvelteKit's auto-crawler
 *     might not visit every locale (it follows links from the root
 *     redirect shell, which only knows one locale at build time).
 *
 *   - `load({params, url})` validates the `lang` URL segment
 *     against SUPPORTED_LOCALES and calls `initI18nFor(lang)` +
 *     `waitLocale(lang)` so every `$_('…')` call below has the
 *     right bundle loaded before the page renders.  A `lang` that
 *     isn't a supported locale — e.g. a shared link with the
 *     `/<lang>/` prefix stripped, `/faq?q=…` — is treated as a
 *     locale-less path: detect the visitor's preferred language
 *     and redirect to the proper prefixed URL (`/en/faq?q=…`),
 *     preserving query + fragment, instead of 404-ing.
 *
 *   - Returns `{ lang }` for downstream pages and components to
 *     read via `$page.data.lang` — used by `localePath()` call
 *     sites and the LanguagePicker.
 *
 * The root-level +layout.ts (one directory up) configures the
 * detection-redirect shell with `prerender = true` for the bare
 * `/` route only (no `entries()` — SvelteKit prerenders the
 * literal `/` page that contains the JS-based locale-detect
 * redirect logic).
 */

import { redirect } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { waitLocale } from 'svelte-i18n';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
import { localePath, pickLocaleFromAcceptLanguages } from '$i18n/path';
import { initI18nFor } from '$i18n';

export const prerender = true;
export const ssr = true;
export const trailingSlash = 'never';

/** Run before every page render in this subtree.  Validates the
 *  URL segment and bootstraps svelte-i18n for SSR + prerender.
 *
 *  Why this can't be a simpler $i18n init: during prerender,
 *  there's no `browser`, no localStorage, no navigator.languages
 *  — the locale comes from the URL segment exclusively.  The
 *  existing `initI18n()` cascade (URL query → localStorage →
 *  navigator → default) is client-side bootstrap; this is the
 *  build-time / SSR equivalent.
 *
 *  Note: `entries()` for the [lang] parameter lives on the
 *  [lang]/+page.ts (SvelteKit only accepts entries() in +page.ts
 *  / +page.server.ts / +server.ts — not on layouts).  Deeper
 *  routes (e.g. /<lang>/orderbook) are discovered by the
 *  prerender crawler following links from the locale-root page
 *  at /<lang>/. */
export async function load({
	params,
	url
}: {
	params: { lang: string };
	url: URL;
}): Promise<{ lang: LocaleCode }> {
	const code = SUPPORTED_LOCALES.find((l) => l.code === params.lang)?.code;
	if (!code) {
		// The `[lang]` segment isn't a supported locale.  This is almost
		// always a shared link with the `/<lang>/` prefix stripped (e.g.
		// `/faq?q=how_morphit_protects_me` instead of `/en/faq?q=…`).
		// Rather than 404, detect the visitor's preferred language from
		// their browser/device and redirect to the proper locale-prefixed
		// URL, preserving the query string and fragment.  The unmatched
		// segment is treated as the first path segment, so localePath
		// prepends the locale: `/faq?q=…` → `/en/faq?q=…`.
		//
		// Detection runs client-side via navigator.languages — this load
		// is reached at runtime through the SPA fallback (`fallback:
		// index.html`) for any path that wasn't prerendered.  During
		// prerender there's no navigator and only valid-locale entries
		// are ever crawled, so the DEFAULT_LOCALE branch isn't exercised
		// there.
		const detected = browser
			? pickLocaleFromAcceptLanguages(navigator.languages ?? [])
			: DEFAULT_LOCALE;
		throw redirect(307, localePath(url.pathname + url.search + url.hash, detected));
	}
	initI18nFor(code);
	await waitLocale(code);
	return { lang: code };
}
