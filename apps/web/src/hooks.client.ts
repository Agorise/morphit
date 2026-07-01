/**
 * Client-side hooks. Run once when the app boots in the browser.
 * No network calls from here — everything local.
 */

import { initI18n, currentLocale, SUPPORTED_LOCALES } from '$i18n';
import { browser } from '$app/environment';

initI18n();

if (browser) {
	currentLocale.subscribe((code) => {
		document.documentElement.lang = code;
		const meta = SUPPORTED_LOCALES.find((l) => l.code === code);
		document.documentElement.dir = meta?.rtl ? 'rtl' : 'ltr';
	});
}
