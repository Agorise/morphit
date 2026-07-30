/**
 * [lang]/+page.ts — locale-root prerender entry list.
 *
 * Part 121 cp7.  SvelteKit only accepts `entries()` on +page.ts,
 * +page.server.ts, or +server.ts (not on layout files), so the
 * enumeration of valid `[lang]` parameter values lives here on the
 * locale-root page rather than on `[lang]/+layout.ts`.
 *
 * The prerender crawler:
 *   1. Visits each `{ lang }` entry returned here — i.e. `/en`,
 *      `/es`, `/de`, …, `/zh-HK` (10 locale-root URLs).
 *   2. For each, the crawler then follows links it finds in the
 *      rendered HTML.  Because the locale-root page (`/<lang>`)
 *      links to `/<lang>/orderbook`, `/<lang>/faq`, etc., the
 *      crawler naturally discovers every (route × locale) pair
 *      it needs to prerender.
 *
 * Total prerendered output: 20 indexable routes × 10 supported
 * locales = 200 HTML files, plus the redirect shell at `/`.
 *
 * If a new locale graduates from PLANNED → SUPPORTED in
 * `$i18n/locales.ts`, the next build automatically produces the
 * full set of HTMLs for that locale; no separate registration
 * step here.
 */

import { SUPPORTED_LOCALES, type LocaleCode } from '$i18n/locales';

export function entries(): { lang: LocaleCode }[] {
	return SUPPORTED_LOCALES.map((l) => ({ lang: l.code }));
}
