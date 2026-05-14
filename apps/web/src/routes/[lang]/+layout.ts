/**
 * [lang]/+layout.ts — per-locale route subtree configuration.
 *
 * Part 121 cp7 (per-locale prerendering route restructure, ADR-0024,
 * design doc docs/PER-LOCALE-PRERENDERING-DESIGN.md, Option C).
 *
 * Every route under `apps/web/src/routes/[lang]/` inherits this:
 *
 *   - `prerender = true` — emit one HTML file per (route × locale).
 *     With 17 indexable routes × 10 supported locales, the build
 *     produces 170 prerendered pages.
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
 *   - `load({params})` validates the `lang` URL segment against
 *     SUPPORTED_LOCALES and calls `initI18nFor(lang)` +
 *     `waitLocale(lang)` so every `$_('…')` call below has the
 *     right bundle loaded before the page renders.  Invalid
 *     `lang` (e.g. `/xx/orderbook`) → 404.
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

import { error } from '@sveltejs/kit';
import { waitLocale } from 'svelte-i18n';
import { SUPPORTED_LOCALES, type LocaleCode } from '$i18n/locales';
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
export async function load({ params }: { params: { lang: string } }): Promise<{ lang: LocaleCode }> {
	const code = SUPPORTED_LOCALES.find((l) => l.code === params.lang)?.code;
	if (!code) {
		throw error(404, `Unknown locale: ${params.lang}`);
	}
	initI18nFor(code);
	await waitLocale(code);
	return { lang: code };
}
