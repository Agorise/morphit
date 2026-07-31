/**
 * Morphit — pure locale constants + matchSupported helper.
 *
 * Extracted from $i18n/index.ts so that modules and smoke tests
 * which don't need the i18n-library runtime (and therefore don't
 * need the SvelteKit browser-environment flag) can import these
 * values without dragging the whole bundle in.
 *
 * The SUPPORTED_LOCALES and PLANNED_LOCALES arrays are the source
 * of truth — `$i18n/index.ts` re-exports from here for backward
 * compatibility with existing call sites that import `from '$i18n'`.
 *
 * What lives here:
 *   - SUPPORTED_LOCALES + PLANNED_LOCALES (the data)
 *   - DEFAULT_LOCALE
 *   - LocaleCode + KnownLocaleCode type aliases
 *   - matchSupported(tag) — pure BCP-47 → LocaleCode mapper
 *
 * What does NOT live here:
 *   - i18n-library init/register/locale-store bindings
 *   - browser/localStorage/navigator.languages logic
 *   - setLocale / waitLocale / currentLocale / tNow runtime API
 *
 * Anything in that "what does not live here" list belongs in
 * $i18n/index.ts instead because it depends on SvelteKit's
 * browser-env flag (imported in index.ts as `browser`) or on
 * the i18n-library runtime stores (imported in index.ts).
 */

export const DEFAULT_LOCALE = 'en';

/**
 * The full list of locales Morphit ships translations for.
 *
 * See $i18n/index.ts module-doc for the workflow on adding a new
 * locale; this array is the SSoT and is referenced by:
 *   - $i18n/index.ts (register() loop + locale switching)
 *   - $i18n/path.ts (URL prefix + Accept-Language picker)
 *   - i18n-locale-parity-smoke (key-shape parity across all locales)
 *   - i18n-path-helpers-smoke (helper invariants)
 *
 * Order: English first (source language), Romance + Slavic by
 * audience size, CJK and RTL trailing.  Reorder freely; nothing
 * depends on this beyond the dropdown display order.
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
 * Locales scaffolded for upcoming translations but NOT yet shown
 * in the switcher.  Move an entry from PLANNED → SUPPORTED once
 * its JSON file ships native-reviewed translations.
 *
 * See $i18n/index.ts module-doc for the graduation workflow.
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

/** Every locale we know about, supported or planned. */
export type KnownLocaleCode = LocaleCode | (typeof PLANNED_LOCALES)[number]['code'];

/**
 * Map a single BCP-47 tag to a supported locale code, or null.
 *
 * Handles Chinese script-variant cases explicitly because a naive
 * language-family fallback picks whichever supported zh variant
 * appears first in SUPPORTED_LOCALES — arbitrary, not correct.
 *
 *   zh-TW / zh-HK / zh-Hant-* / zh-MO  →  zh-HK (Traditional)
 *   zh-CN / zh-SG / zh-Hans-* / zh     →  zh-CN (Simplified)
 *
 * For non-Chinese tags, language-family match wins:
 *   es-MX → es, de-AT → de, fa-IR → fa, en-GB → en.
 *
 * Pure function — no DOM, no globals, no async — so it's safe to
 * call in any context (SSR, prerender, smoke harness, web worker).
 */
export function matchSupported(tag: string): LocaleCode | null {
	// Exact match first — covers the common cases.
	const exact = SUPPORTED_LOCALES.find((l) => l.code === tag);
	if (exact) return exact.code;

	const lower = tag.toLowerCase();

	// Chinese script handling.  Order matters: Traditional markers
	// before Simplified, because a tag like "zh-Hant-HK" matches
	// both "hant" and "hk".
	if (lower.startsWith('zh')) {
		if (/\bhant\b|^zh-tw$|^zh-hk$|^zh-mo$/.test(lower)) return 'zh-HK';
		return 'zh-CN';
	}

	// Language-family match for the non-Chinese cases.
	const base = lower.split('-')[0] ?? lower;
	const familyMatch = SUPPORTED_LOCALES.find((l) => l.code.split('-')[0] === base);
	return familyMatch?.code ?? null;
}

/**
 * True when a locale renders right-to-left. Currently only Persian (fa);
 * Arabic (ar) when it ships from PLANNED_LOCALES. This is the single source
 * of truth for text direction — it drives `<html dir>` (hooks) and the bidi
 * isolation of LTR tokens embedded in an RTL sentence (the order title).
 * Tolerates a region/script subtag (fa-IR, ar-EG) by matching the base.
 */
export function isRtlLocale(code: string | null | undefined): boolean {
	if (!code) return false;
	const base = code.split('-')[0];
	return [...SUPPORTED_LOCALES, ...PLANNED_LOCALES].some(
		(l) => l.rtl && (l.code === code || l.code === base || l.code.split('-')[0] === base)
	);
}
