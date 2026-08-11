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
	currentLocale.subscribe((code) => {
		document.documentElement.lang = code;
		const meta = SUPPORTED_LOCALES.find((l) => l.code === code);
		document.documentElement.dir = meta?.rtl ? 'rtl' : 'ltr';
	});
}
