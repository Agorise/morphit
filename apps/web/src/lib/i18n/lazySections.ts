/**
 * v1.20.2 (PageSpeed) — locale sections that only ONE page reads, loaded with
 * that page instead of with every page.
 *
 * Every page used to download the visitor's whole locale file — and, for a
 * visitor whose language is not English, the English one as well (the
 * fallback): about 180 KB compressed EACH, before the page could finish
 * starting. Almost half of it is the FAQ, which only /faq shows. These
 * sections are cut out of the locale bundle at build time
 * (vite.config.js, plugin `morphit-i18n-sections`) and loaded by their
 * route's own +page.ts (`loadI18nSections`). The locale JSON files themselves
 * are unchanged: translators and the i18n smokes still see one file per
 * language.
 *
 * `routes` are the folders under src/routes/[lang]/ whose pages read the
 * section; scripts/i18n-lazy-sections-smoke.ts checks that nothing outside
 * them uses its keys (a page that did would show raw keys) and that each of
 * them loads it.
 *
 * Pure: no SvelteKit or svelte-i18n imports (vite.config.js imports it).
 */
export const LAZY_SECTIONS = {
	faq: { routes: ['faq'] },
	privacy: { routes: ['privacy'] },
	run_a_node: { routes: ['run-a-node'] },
	cheat_sheet: { routes: ['cheat-sheet'] }
} as const;

export type LazySection = keyof typeof LAZY_SECTIONS;

/** The part every page loads. */
export const CORE_PART = 'core';
export type LocalePart = typeof CORE_PART | LazySection;

export const LAZY_SECTION_NAMES = Object.keys(LAZY_SECTIONS) as LazySection[];

export function isLocalePart(x: string): x is LocalePart {
	return x === CORE_PART || (LAZY_SECTION_NAMES as string[]).includes(x);
}

/**
 * One part of a locale's messages: `core` is everything except the lazy
 * sections; a lazy section is `{ [section]: … }` alone (or `{}` when that
 * locale has no such section — svelte-i18n then falls back to English).
 */
export function splitLocaleMessages(
	all: Record<string, unknown>,
	part: LocalePart
): Record<string, unknown> {
	if (part === CORE_PART) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(all)) {
			if (!(LAZY_SECTION_NAMES as string[]).includes(k)) out[k] = v;
		}
		return out;
	}
	return Object.hasOwn(all, part) ? { [part]: all[part] } : {};
}
