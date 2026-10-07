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
 * The mirror holds only a set the user CHOSE in Settings (`{ "v": 2, "langs":
 * [...] }`). Posting an order never creates it: older builds wrote the post's
 * language as a bare array after the first post, which then pinned the
 * orderbook filter to that one language. Such a bare array is dropped on read.
 *
 * Resolution order everywhere: local mirror → chain profile → current UI locale.
 * All functions are pure w.r.t. their inputs (localStorage is the only side
 * effect) and validate every code against the 10 supported locales.
 */
import { browser } from '$app/environment';
import { isOrderLang, ORDER_LANG_CODES } from '$i18n/locales';

const KEY_PREFS = 'morphit.preferredLangs.v1'; // { v: 2, langs: [primary, ...] }
const KEY_LAST = 'morphit.lastPostLang.v1'; // single code (next-post default)
// The orderbook language filter as the user last left it ON THE ORDERBOOK, on
// this device ({ v: 1, langs: [...] }, possibly empty). v1.21.1: a language
// filter lists only orders tagged with its languages, so a filter re-seeded
// from Settings on every visit hid every older (untagged) order each time,
// however often the user cleared it.
const KEY_OB_FILTER = 'morphit.orderbookLangFilter.v1';

function clean(arr: unknown): string[] {
	if (!Array.isArray(arr)) return [];
	return [...new Set(arr.filter((x): x is string => isOrderLang(x)))].slice(0, ORDER_LANG_CODES.length);
}

/** The preferred set the user chose in Settings (primary first), or null if
 *  none. A bare array (written by an older build after a post, not chosen) is
 *  removed and read as none. */
export function readLocalPreferredLangs(): string[] | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(KEY_PREFS);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			localStorage.removeItem(KEY_PREFS);
			return null;
		}
		const c = clean((parsed as { langs?: unknown } | null)?.langs);
		return c.length > 0 ? c : null;
	} catch {
		return null;
	}
}

/** Write the user's chosen set (ordered, primary first). Empty ⇒ removes it.
 *  A new choice in Settings also re-seeds the orderbook filter from it. */
export function writeLocalPreferredLangs(langs: readonly string[]): void {
	if (!browser) return;
	const c = clean(langs);
	try {
		if (c.length === 0) localStorage.removeItem(KEY_PREFS);
		else localStorage.setItem(KEY_PREFS, JSON.stringify({ v: 2, langs: c }));
		localStorage.removeItem(KEY_OB_FILTER);
	} catch {
		/* quota / disabled storage — non-fatal */
	}
}

/** The orderbook language filter as the user last left it there (possibly
 *  empty = all languages), or null when they never changed it there. */
export function readOrderbookLangFilter(): string[] | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(KEY_OB_FILTER);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as { v?: unknown; langs?: unknown } | null;
		return parsed && parsed.v === 1 ? clean(parsed.langs) : null;
	} catch {
		return null;
	}
}

/** Remember the orderbook language filter the user set there (empty too). */
export function writeOrderbookLangFilter(langs: readonly string[]): void {
	if (!browser) return;
	try {
		localStorage.setItem(KEY_OB_FILTER, JSON.stringify({ v: 1, langs: clean(langs) }));
	} catch {
		/* non-fatal */
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
 * refresh (timeapp). An empty seed shows every order; the user opts into a
 * language filter deliberately.
 */
export function resolveOrderbookLangFilter(chainLangs: readonly string[] | null): string[] {
	// What the user last left on the orderbook wins (an empty filter too).
	const own = readOrderbookLangFilter();
	if (own !== null) return own;
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
 * (Requirement: a one-off post in another language sets last-used but never flips the
 * primary; the primary only changes in Settings.)
 */
export function resolvePostDefaultLang(chainLangs: readonly string[] | null, uiLocale: string): string {
	const last = readLastPostLang();
	if (last) return last;
	return resolvePrimaryLang(chainLangs, uiLocale);
}

/**
 * Record that the user just posted in `lang`: remember it as the next-post
 * default, and — only when the user has chosen a preferred set in Settings —
 * WIDEN that set with it (so their own orders show in their filter), keeping
 * the primary at position 0. Without a chosen set nothing else is written: a
 * post must not turn the orderbook filter on. Returns the resulting set.
 */
export function noteUsedPostLang(lang: string, current: readonly string[]): string[] {
	if (!isOrderLang(lang)) return clean(current);
	writeLastPostLang(lang);
	const chosen = readLocalPreferredLangs();
	if (chosen === null) return clean(current);
	const next = chosen.includes(lang) ? chosen : [...chosen, lang]; // primary stays
	writeLocalPreferredLangs(next);
	return next;
}

/** Read preferred_langs out of a profile's json_metadata blob. Tolerant. */
export function preferredLangsFromProfile(jsonMetadata: unknown): string[] {
	if (!jsonMetadata || typeof jsonMetadata !== 'object') return [];
	return clean((jsonMetadata as Record<string, unknown>).preferred_langs);
}
