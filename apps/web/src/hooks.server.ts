/**
 * Server-side hooks.  This is a fully static (adapter-static) build, so this
 * `handle` runs ONLY at PRERENDER time — there is no runtime server.  Its sole
 * job is to bake the correct `<html lang>`/`<html dir>` into each prerendered
 * locale page.
 *
 * Why this is needed:  `app.html` ships a static `<html lang="en" dir="ltr">`.
 * Without this hook every prerendered page — including `/fa/…` — is emitted
 * with `lang="en" dir="ltr"`, so:
 *   - search crawlers and screen readers see Persian pages labelled English
 *     (wrong pronunciation + wrong SEO language signal), and
 *   - a Farsi visitor gets a left-to-right first paint that only flips to RTL
 *     once `hooks.client.ts` hydrates — and a NO-JAVASCRIPT Farsi visitor
 *     (Morphit supports read-only browsing with JS off) stays LTR forever.
 *
 * We derive the locale from the route's URL prefix (`/fa/orderbook` → `fa`),
 * map it to a direction via the i18n source of truth, and string-replace the
 * `<html>` attributes.  For English pages the replacement is a no-op (idempotent
 * `lang="en" dir="ltr"` → `lang="en" dir="ltr"`).  In-app locale switches are
 * still handled client-side by `hooks.client.ts`; this only fixes the FIRST
 * paint + the no-JS / SEO case.
 *
 * Only an EXACT supported-locale prefix counts, so non-localized paths (a bare
 * `/about`, `/rss`, the `index.html` SPA fallback) keep the English default and
 * let the client hook / the `?lang=` inline script sort out direction.
 */

import type { Handle } from '@sveltejs/kit';
import { SUPPORTED_LOCALES, isRtlLocale, DEFAULT_LOCALE } from '$i18n/locales';

export const handle: Handle = async ({ event, resolve }) => {
	const seg = event.url.pathname.split('/')[1] ?? '';
	const code = SUPPORTED_LOCALES.some((l) => l.code === seg) ? seg : DEFAULT_LOCALE;
	const dir = isRtlLocale(code) ? 'rtl' : 'ltr';

	return resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('lang="en" dir="ltr"', `lang="${code}" dir="${dir}"`)
	});
};
