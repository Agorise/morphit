import { browser } from '$app/environment';
import { init, register, locale, _ } from 'svelte-i18n';
import { derived, get, writable } from 'svelte/store';

export const DEFAULT_LOCALE = 'en';

/**
 * The full list of locales Morphit ships translations for.
 *
 * Adding a new language is a SINGLE-ARRAY edit:
 *
 *   1. Add an entry to SUPPORTED_LOCALES below — code (BCP-47),
 *      nativeName (how speakers refer to their own language),
 *      englishName (label for the language switcher when the user
 *      is currently on a different language), rtl (right-to-left
 *      script flag).
 *   2. Drop a fully-translated `<code>.json` into
 *      `apps/web/src/lib/i18n/locales/`.  The i18n parity smoke
 *      enforces that every key from en.json exists in every
 *      locale, so missing translations become a CI failure rather
 *      than a silent empty string at runtime.
 *
 * No second array to update; the register() loop below derives
 * loader bindings from this list automatically.  Pre-2026-05
 * required keeping the SUPPORTED_LOCALES array and the
 * register() calls in sync manually — easy to miss one.
 *
 * ORDER NOTE: the order here is the order languages appear in
 * the language-switcher dropdown.  We currently order roughly
 * by bundle file size (English first as the source language;
 * shorter-name Romance languages next; CJK and RTL trailing).
 * Reorder freely; nothing depends on this beyond the dropdown.
 */
export const SUPPORTED_LOCALES = [
	{ code: 'en', nativeName: 'English', englishName: 'English', rtl: false },
	{ code: 'es', nativeName: 'Español', englishName: 'Spanish', rtl: false },
	{ code: 'de', nativeName: 'Deutsch', englishName: 'German', rtl: false },
	{ code: 'pl', nativeName: 'Polski', englishName: 'Polish', rtl: false },
	{ code: 'fr', nativeName: 'Français', englishName: 'French', rtl: false },
	{ code: 'it', nativeName: 'Italiano', englishName: 'Italian', rtl: false },
	{ code: 'ru', nativeName: 'Русский', englishName: 'Russian', rtl: false },
	{ code: 'fa', nativeName: 'فارسی', englishName: 'Persian', rtl: true },
	{ code: 'zh-CN', nativeName: '中文（简体）', englishName: 'Mandarin', rtl: false },
	{ code: 'zh-HK', nativeName: '中文（繁體）', englishName: 'Cantonese', rtl: false }
] as const;

/**
 * Locales that are scaffolded for upcoming translations but NOT
 * yet shown in the language-switcher.
 *
 * Each entry here represents work in progress: a translator
 * (paid, volunteer, or via a community Weblate/Tolgee instance)
 * is producing the JSON file under
 * `apps/web/src/lib/i18n/locales/<code>.json`.  Once that JSON
 * file exists AND has been native-speaker reviewed, the entry
 * graduates from PLANNED_LOCALES → SUPPORTED_LOCALES (one-line
 * move).  Users start seeing it in the switcher on the next
 * deploy.
 *
 * Why a separate list and not just a "ready: true/false" flag?
 *   - The switcher dropdown filters from SUPPORTED_LOCALES.
 *     Keeping the lists separate means there's no chance of
 *     accidentally exposing a half-translated locale to users.
 *   - Bundle splitter for vite/rollup only sees the loop over
 *     SUPPORTED_LOCALES; PLANNED entries don't ship JS bundles
 *     until they graduate.
 *   - The i18n parity smoke can include planned locales in its
 *     drift check (separate scenario) so the missing-keys count
 *     doesn't block CI for entries that are still being worked.
 *
 * Languages here roughly ordered by speaker count / Morphit
 * audience priority:
 *   - Hindi: ~600M speakers; massive South Asian market
 *   - Arabic: ~370M, RTL — first-class RTL test alongside fa
 *   - Bengali: ~270M, second South Asian script (Devanagari →
 *     Bengali coverage)
 *   - Portuguese: ~260M, Brazil-heavy audience
 *   - Indonesian: ~200M, large mobile-first market
 *   - Japanese: ~125M
 *   - Vietnamese: ~85M, Latin script with Latin-extended chars
 */
export const PLANNED_LOCALES = [
	{ code: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi', rtl: false },
	{ code: 'ar', nativeName: 'العربية', englishName: 'Arabic', rtl: true },
	{ code: 'bn', nativeName: 'বাংলা', englishName: 'Bengali', rtl: false },
	{ code: 'pt', nativeName: 'Português', englishName: 'Portuguese', rtl: false },
	{ code: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian', rtl: false },
	{ code: 'ja', nativeName: '日本語', englishName: 'Japanese', rtl: false },
	{ code: 'vi', nativeName: 'Tiếng Việt', englishName: 'Vietnamese', rtl: false }
] as const;

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]['code'];

/** Type covering every locale we know about, supported or
 *  planned.  Used by the parity smoke and by docs that reference
 *  language codes that might not yet ship translations. */
export type KnownLocaleCode = LocaleCode | (typeof PLANNED_LOCALES)[number]['code'];

// Register each SUPPORTED locale with a lazy loader — only the
// chosen bundle is fetched at runtime.  Planned locales are NOT
// registered (no JSON file exists yet); the switcher dropdown
// only iterates SUPPORTED_LOCALES so users can't pick one.
//
// The loader path is computed from the locale code; svelte-i18n
// memoizes the result, so repeated lookups don't re-import.
//
// Note: vite/rollup needs static-analyzable import paths to do
// code-splitting per locale.  Computing `./locales/${code}.json`
// inside an arrow returned from a loop body, with `code` from
// `for...of`, is fine — vite recognizes the pattern as long as
// the directory and extension are literal strings.
for (const { code } of SUPPORTED_LOCALES) {
	register(code, () => import(`./locales/${code}.json`));
}

const STORAGE_KEY = 'morphit.locale';

/**
 * Pick the best supported locale for a first-time visitor.
 *
 * Resolution order (first match wins):
 *   1. `?lang=<code>` query parameter (explicit intent — a user
 *      clicked a hreflang link expecting that language)
 *   2. Persisted preference in localStorage (explicit past choice)
 *   3. Exact match on any entry in navigator.languages[]
 *   4. Script-aware Chinese variant routing
 *      (zh-TW/zh-HK/zh-Hant → zh-HK; zh-CN/zh-SG/zh-Hans → zh-CN)
 *   5. Language-family match (e.g. "es-MX" → "es")
 *   6. DEFAULT_LOCALE
 *
 * Key improvement over the original implementation: navigator.languages
 * is an ORDERED list of preferences. A user may have Polish as their
 * top preference and English as their browser default; looking only
 * at navigator.language (singular) would miss Polish entirely.
 */
function pickInitialLocale(): LocaleCode {
	if (!browser) return DEFAULT_LOCALE;

	// ─── 1. URL query parameter ────────────────────────────────
	// A ?lang=XX link from a hreflang-aware SERP, an llms.txt
	// pointer, or an explicit user-shared URL. This must win over
	// every other signal — the URL is the user's stated intent.
	try {
		const qLang = new URLSearchParams(window.location.search).get('lang');
		if (qLang) {
			const hit = matchSupported(qLang);
			if (hit) return hit;
		}
	} catch {
		// URLSearchParams shouldn't throw but defend against exotic
		// bots that fake a window.location. Fall through.
	}

	// ─── 2. Persisted user choice ─────────────────────────────
	try {
		const saved = window.localStorage.getItem(STORAGE_KEY);
		if (saved && SUPPORTED_LOCALES.some((l) => l.code === saved)) {
			return saved as LocaleCode;
		}
	} catch {
		// localStorage may be disabled (Privacy Mode); fall through.
	}

	// ─── 3–5. Navigator preferences, in priority order ────────
	const prefs = readNavigatorLanguages();
	for (const tag of prefs) {
		const hit = matchSupported(tag);
		if (hit) return hit;
	}

	return DEFAULT_LOCALE;
}

/** Return navigator.languages[] if available, falling back to the
 *  single navigator.language when the array isn't exposed (older
 *  browsers, some headless environments). Always lowercased except
 *  for the region part which is preserved uppercase so our "zh-CN"
 *  / "zh-HK" comparisons remain case-sensitive. */
function readNavigatorLanguages(): readonly string[] {
	if (typeof navigator === 'undefined') return [];
	const list: string[] = [];
	// navigator.languages is the spec; navigator.language is the
	// older single-value fallback. We concat + dedupe so the spec
	// path wins when both exist.
	if (Array.isArray(navigator.languages)) {
		for (const l of navigator.languages) if (l && !list.includes(l)) list.push(l);
	}
	if (navigator.language && !list.includes(navigator.language)) {
		list.push(navigator.language);
	}
	return list;
}

/** Map a single BCP-47 tag to a supported locale, or null. Handles
 *  the Chinese script-variant cases explicitly because a simple
 *  language-family match picks whichever supported variant appears
 *  first in SUPPORTED_LOCALES — arbitrary, not correct.
 *
 *  Exported for unit testing only; pickInitialLocale is the
 *  public entrypoint for runtime locale selection.
 */
export function matchSupported(tag: string): LocaleCode | null {
	// Exact match first — covers the common cases (en, es, de, pl,
	// fr, it, ru, fa, zh-CN, zh-HK).
	const exact = SUPPORTED_LOCALES.find((l) => l.code === tag);
	if (exact) return exact.code;

	const lower = tag.toLowerCase();

	// Chinese script handling. BCP-47 is messy here:
	//   zh-TW, zh-HK, zh-Hant-*, zh-MO  →  Traditional → zh-HK
	//   zh-CN, zh-SG, zh-Hans-*, zh      →  Simplified → zh-CN
	// Order matters: check Traditional markers before Simplified
	// because a tag like "zh-Hant-HK" matches both "hant" and "hk".
	if (lower.startsWith('zh')) {
		if (/\bhant\b|^zh-tw$|^zh-hk$|^zh-mo$/.test(lower)) return 'zh-HK';
		// Everything else under zh defaults to zh-CN (Simplified).
		// This covers bare "zh", zh-Hans, zh-CN, zh-SG.
		return 'zh-CN';
	}

	// Language-family match for the non-Chinese cases. e.g. "es-MX"
	// → "es", "de-AT" → "de", "fa-IR" → "fa". Because Chinese was
	// handled above, this branch only runs for tags whose base
	// language has exactly one supported variant in our list.
	const base = lower.split('-')[0] ?? lower;
	const familyMatch = SUPPORTED_LOCALES.find((l) => l.code.split('-')[0] === base);
	return familyMatch?.code ?? null;
}

export function initI18n(): void {
	init({
		fallbackLocale: DEFAULT_LOCALE,
		initialLocale: pickInitialLocale()
	});
}

/**
 * Initialize i18n with an explicit locale code.
 *
 * Used by the per-locale prerendering pipeline: when the route tree
 * moves under `[lang]/`, each route's load() knows the locale from
 * URL params directly — no need to pick one from client signals.
 *
 * This is the right entrypoint for SSR/prerender contexts where
 * `browser` is false and `navigator` doesn't exist. `initI18n()`
 * (no-arg) handles client-side bootstrap after hydration when the
 * locale isn't yet known.
 *
 * Safe to call before any component renders: the underlying
 * `init()` from svelte-i18n is idempotent within a single module
 * evaluation, and callers generally pair this with `waitLocale(code)`
 * to guarantee the bundle is loaded before render.
 */
export function initI18nFor(code: LocaleCode): void {
	init({
		fallbackLocale: DEFAULT_LOCALE,
		initialLocale: code
	});
}

/** Live switch — triggers only the new locale bundle to be fetched. */
export async function setLocale(code: LocaleCode): Promise<void> {
	locale.set(code);
	if (browser) {
		try {
			window.localStorage.setItem(STORAGE_KEY, code);
		} catch {
			// Privacy Mode — no persistence, but the in-memory switch still works.
		}
		document.documentElement.lang = code;
	}
}

/** Expose current locale as a store consumers can subscribe to. */
export const currentLocale = derived(locale, ($l) => ($l ?? DEFAULT_LOCALE) as LocaleCode);

export { _ };
export const t = _;

/** Used by the language switcher widget. */
export const localeMenuOpen = writable(false);

// Helper: call without subscribing (for imperative flows like pushing notifications).
// `values` matches the shape svelte-i18n's MessageFormat accepts —
// scalars + Date.  `unknown` would be wider but the formatter
// rejects unknown shapes at runtime, so keeping the type narrow
// catches caller bugs at compile time.
export function tNow(
	key: string,
	values?: Record<string, string | number | boolean | Date | null | undefined>
): string {
	const translator = get(_);
	return translator({ id: key, values }) as string;
}
