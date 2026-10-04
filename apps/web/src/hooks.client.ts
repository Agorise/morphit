/**
 * Client-side hooks. Run once when the app boots in the browser.
 * No network calls from here — everything local.
 */

import { initI18n, currentLocale, SUPPORTED_LOCALES } from '$i18n';
import { browser } from '$app/environment';
// Side-effect import: registers the `beforeinstallprompt` capture at BOOT.
// That event fires once, shortly after first load — if the listener isn't
// already installed it's lost for the session. It used to be imported only by
// the settings page, so unless the user happened to open settings first, the
// deferred prompt was never captured and the install affordance never appeared.
import '$lib/pwa/installPrompt';

initI18n();

if (browser) {
	// An older build kept shared crypto addresses in plaintext, with dates
	// and order ids. Convert that record to the hashed form and delete it as
	// soon as the app starts, not only when chat or settings is opened.
	try {
		if (localStorage.getItem('morphit.address-history.v1') !== null) {
			void import('$lib/privacy/addressHistory')
				.then((m) => m.migrateLegacyAddressHistory())
				.catch(() => {});
		}
	} catch {
		// storage unavailable: nothing to convert
	}

	currentLocale.subscribe((code) => {
		document.documentElement.lang = code;
		const meta = SUPPORTED_LOCALES.find((l) => l.code === code);
		document.documentElement.dir = meta?.rtl ? 'rtl' : 'ltr';
	});
}
