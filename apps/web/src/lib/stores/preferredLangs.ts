/**
 * apps/web/src/lib/stores/preferredLangs.ts (v1.15.0)
 *
 * The user's language preferences that drive two defaults:
 *   • the "This post is in …" select on the order form, and
 *   • the orderbook "Language" filter.
 *
 * Source of truth is the on-chain profile (json_metadata.preferred_langs, an
 * ordered array whose FIRST entry is the primary). This module keeps a LOCAL
 * mirror (localStorage) so those defaults are instant — no chain round-trip on
 * page load — and a separate "last post language" so a one-off post in another
 * language becomes the default for the NEXT post without disturbing the primary
 * the user set in Settings.
 *
 * Resolution order everywhere: local mirror → chain profile → current UI locale.
 * All functions are pure w.r.t. their inputs (localStorage is the only side
 * effect) and validate every code against the 10 supported locales.
 */
import { browser } from '$app/environment';
import { isOrderLang, ORDER_LANG_CODES } from '$i18n/locales';

const KEY_PREFS = 'morphit.preferredLangs.v1'; // ordered array, primary = [0]
const KEY_LAST = 'morphit.lastPostLang.v1'; // single code (next-post default)

function clean(arr: unknown): string[] {
	if (!Array.isArray(arr)) return [];
	return [...new Set(arr.filter((x): x is string => isOrderLang(x)))].slice(0, ORDER_LANG_CODES.length);
}

/** The locally-mirrored preferred set (primary first), or null if none stored. */
export function readLocalPreferredLangs(): string[] | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(KEY_PREFS);
		if (!raw) return null;
		const c = clean(JSON.parse(raw));
		return c.length > 0 ? c : null;
	} catch {
		return null;
	}
}

/** Write the local mirror (ordered, primary first). Empty ⇒ removes it. */
export function writeLocalPreferredLangs(langs: readonly string[]): void {
	if (!browser) return;
	const c = clean(langs);
	try {
		if (c.length === 0) localStorage.removeItem(KEY_PREFS);
		else localStorage.setItem(KEY_PREFS, JSON.stringify(c));
	} catch {
		/* quota / disabled storage — non-fatal */
	}
}

/** The last language the user posted in (default for their next post), or null. */
export function readLastPostLang(): string | null {
	if (!browser) return null;
	try {
		const v = localStorage.getItem(KEY_LAST);
		return v && isOrderLang(v) ? v : null;
	} catch {
		return null;
	}
}

export function writeLastPostLang(lang: string): void {
	if (!browser || !isOrderLang(lang)) return;
	try {
		localStorage.setItem(KEY_LAST, lang);
	} catch {
		/* non-fatal */
	}
}

/**
 * Resolve the preferred set (primary first) that the orderbook filter defaults
 * to: local mirror → chain profile's preferred_langs → [UI locale]. Never empty.
 */
export function resolvePreferredLangs(
	chainLangs: readonly string[] | null,
	uiLocale: string
): string[] {
	const local = readLocalPreferredLangs();
	if (local && local.length > 0) return local;
	const fromChain = clean(chainLangs);
	if (fromChain.length > 0) return fromChain;
	return [isOrderLang(uiLocale) ? uiLocale : 'en'];
}

/**
 * The orderbook language FILTER seed. Returns an EXPLICIT saved (local mirror) or
 * on-chain preferred set, else EMPTY (= all languages). Unlike resolvePreferredLangs
 * it does NOT fall back to the UI locale: browsing the site in Italian must not
 * silently hide non-Italian orders, and the hidden filter re-appeared on every
 * refresh (the maintainer/timeapp). An empty seed shows every order; the user opts into a
 * language filter deliberately.
 */
export function resolveOrderbookLangFilter(chainLangs: readonly string[] | null): string[] {
	const local = readLocalPreferredLangs();
	if (local && local.length > 0) return local;
	const fromChain = clean(chainLangs);
	if (fromChain.length > 0) return fromChain;
	return [];
}

/** The primary preferred language (the settings default), = resolved set [0]. */
export function resolvePrimaryLang(chainLangs: readonly string[] | null, uiLocale: string): string {
	return resolvePreferredLangs(chainLangs, uiLocale)[0]!;
}

/**
 * The default language for a NEW post: last-posted → primary → UI locale.
 * (the maintainer: a one-off post in another language sets last-used but never flips the
 * primary; the primary only changes in Settings.)
 */
export function resolvePostDefaultLang(chainLangs: readonly string[] | null, uiLocale: string): string {
	const last = readLastPostLang();
	if (last) return last;
	return resolvePrimaryLang(chainLangs, uiLocale);
}

/**
 * Record that the user just posted in `lang`: remember it as the next-post
 * default and WIDEN the preferred set with it (so those orders start showing in
 * their filter) — keeping the existing primary at position 0. Returns the new
 * ordered set (caller persists to chain on the next profile save; the local
 * mirror is updated here immediately). Pure aside from localStorage.
 */
export function noteUsedPostLang(lang: string, current: readonly string[]): string[] {
	if (!isOrderLang(lang)) return clean(current);
	writeLastPostLang(lang);
	const set = clean(current);
	const next = set.includes(lang) ? set : [...set, lang]; // primary (set[0]) stays
	writeLocalPreferredLangs(next);
	return next;
}

/** Read preferred_langs out of a profile's json_metadata blob. Tolerant. */
export function preferredLangsFromProfile(jsonMetadata: unknown): string[] {
	if (!jsonMetadata || typeof jsonMetadata !== 'object') return [];
	return clean((jsonMetadata as Record<string, unknown>).preferred_langs);
}
