import { get } from 'svelte/store';
import { goto } from '$app/navigation';
import { page } from '$app/stores';
import { localePath } from './path';
import type { LocaleCode } from './locales';

/**
 * goto() that keeps the user on their current locale.
 *
 * Every Morphit route lives under `[lang]`, so an internal navigation
 * MUST carry a locale prefix — a bare `goto('/orderbook')` resolves
 * `[lang]` = 'orderbook' and 404s with "Unknown locale". This wraps the
 * target with the active locale prefix (read from the page store at call
 * time via `localePath`) so imperative navigations behave like the
 * `lp()`-wrapped `<a href>` links do, instead of silently dropping the
 * user back to the default locale.
 *
 * Use this for ALL internal `goto()` calls — a bare-path `goto()` is a
 * bug (the `no-bare-path-goto-smoke` static sentinel enforces it).
 * `localePath` is idempotent, so passing an already locale-prefixed path
 * simply re-targets it to the current locale.
 */
export function gotoLocale(path: string, opts?: Parameters<typeof goto>[1]): Promise<void> {
	const lang = get(page).params.lang as LocaleCode | undefined;
	return goto(localePath(path, lang), opts);
}
