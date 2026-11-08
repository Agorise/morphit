/**
 * /<lang>/about → /<lang>/about-this-instance (v1.23.4): people type /about by
 * hand. Prerendered for every locale as a page that forwards at once (script
 * and meta refresh, so it works without JavaScript too). See
 * $i18n/pageAliases.
 */

import { redirect } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { SUPPORTED_LOCALES, type LocaleCode } from '$i18n/locales';
import { PAGE_ALIASES } from '$i18n/pageAliases';

export function entries(): { lang: LocaleCode }[] {
	return SUPPORTED_LOCALES.map((l) => ({ lang: l.code }));
}

export function load({ params, url }: { params: { lang: string }; url: URL }): never {
	// The query and fragment ride along when the app follows a link here. A
	// prerendered page has none to read, and SvelteKit's forwarding page has a
	// fixed target, so `/en/about?x#y` loaded straight from the server lands on
	// `/en/about-this-instance` without them (review: known, accepted — people
	// type `/about`; the bare one keeps them, through the locale redirect).
	const rest = browser ? url.search + url.hash : '';
	throw redirect(301, `/${params.lang}/${PAGE_ALIASES.about}${rest}`);
}
