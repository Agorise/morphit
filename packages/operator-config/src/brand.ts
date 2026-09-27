/**
 * Per-instance BRAND NAME — pure, browser-safe helpers (zero dependencies).
 *
 * Shared by the web frontend (via `@morphit/operator-config/brand`), the indexer
 * (RSS feed titles) and morphit-ops (`branding apply`), so all three agree on
 * what a valid brand name is and how `{brand}` placeholders resolve. See
 * docs/BRANDING.md and apps/web/src/lib/brand/brandName.ts for the design.
 *
 * Kept in its own module (like ./contact) so the browser bundle never pulls in
 * this package's Node-only env loader.
 */

/** The software's own name — the default brand of an unbranded instance. */
export const DEFAULT_BRAND_NAME = 'Morphit';

/**
 * Placeholder the locale JSON uses for a SITE-brand mention: `{brand}`, or
 * `{brand|<default form>}` where the language inflects or transliterates the
 * name — pl "Otwórz {brand|Morphita} na telefonie", fa "{brand|مورفیت}". An
 * unbranded instance renders the default form (so its copy is unchanged, word
 * for word); an operator's brand is inserted as-is, uninflected.
 */
export const BRAND_PLACEHOLDER_RE = /\{brand(?:\|([^{}|]*))?\}/g;

/**
 * Invisible marker (U+2060 WORD JOINER) that BRACKETS every brand slot during
 * PRERENDER only: "\u2060Morphit\u2060", "\u2060Morphita\u2060". Never reaches a
 * browser: scripts/build-brand-slots.mjs records each bracketed slot and strips
 * the markers. Keep in sync with that script and apps/ops-cli/src/lib/branding.ts.
 */
export const BRAND_SLOT_SENTINEL = '\u2060';

/** Longest brand name accepted (keeps titles/headers sane). */
export const BRAND_NAME_MAX_LENGTH = 48;

/**
 * Characters a brand name may not contain.
 *  - `{` `}` `#` `|` would be read as ICU syntax by svelte-i18n when a message IS
 *    formatted with values;
 *  - `<` `>` `"` `\` and backtick would be markup/escaping hazards in `{@html}`
 *    copy, HTML attributes and the JSON-LD script;
 *  - `*` `[` `]` are inline-markdown syntax in the FAQ renderer
 *    (apps/web/src/lib/faq/renderInline.ts): a name like "[Support](https://…)"
 *    would become a live link, "*x*" emphasis (a `__` run is refused below);
 *  - control characters; U+2060 is our own slot sentinel; U+200B / U+FEFF are
 *    invisible; the bidi embeddings/overrides/isolates (U+202A–U+202E,
 *    U+2066–U+2069) and the invisible direction marks (LRM U+200E, RLM U+200F,
 *    ALM U+061C) would reverse or reorder the text AROUND the name in titles
 *    and notifications, or make two names look identical; noncharacters (U+FDD0–U+FDEF, U+FFFE, U+FFFF) are not
 *    valid in XML (RSS/Atom feeds). ZWNJ/ZWJ (U+200C/U+200D) stay allowed:
 *    Persian and other scripts need them.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN =
	/[{}#|<>"\\`*[\]\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u061c\u2060\ufeff\u202a-\u202e\u2066-\u2069\ufdd0-\ufdef\ufffe\uffff]/;
/** A lone UTF-16 surrogate (not part of a valid pair). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Normalise an operator-supplied brand name, or return null if it is unusable.
 *
 *  - trims and collapses internal whitespace;
 *  - turns the ASCII apostrophe into ’ (U+2019): svelte-i18n returns a message
 *    RAW when no values are passed but runs it through ICU when values are, and
 *    ICU treats `'` as an escape — the typographic apostrophe reads identically
 *    ("Alice’s Shop") and is safe on both paths;
 *  - rejects empty, over-long, or FORBIDDEN-character names.
 */
export function sanitizeBrandName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const name = raw.replace(/\s+/g, ' ').trim().replace(/'/g, '\u2019');
	if (name.length === 0 || name.length > BRAND_NAME_MAX_LENGTH) return null;
	if (FORBIDDEN.test(name) || LONE_SURROGATE.test(name) || name.includes('__')) return null;
	// Something must be visible: not only spaces and joiners.
	if (name.replace(/[\s\u200c\u200d]/g, '').length === 0) return null;
	return name;
}

/**
 * How a brand slot is written when it is directly followed by a hyphen and a
 * letter — a compound word, which German builds as "{brand}-Passwort". A
 * multi-word name must then be hyphenated throughout ("Vigilante-Trading-
 * Passwort", not "Vigilante Trading-Passwort"). Shared by the browser
 * (applyBrandToString) and `morphit-ops branding apply` (prerendered pages), so
 * both write exactly the same text.
 */
export function brandForCompound(name: string): string {
	return name.replace(/\s+/g, '-');
}

/** True when `text[at]` starts a "-<letter>" compound continuation. */
export function continuesAsCompound(text: string, at: number): boolean {
	return text[at] === '-' && /\p{L}/u.test(text.slice(at + 1, at + 3));
}

/**
 * Renders one brand slot, given the slot's DEFAULT form ("Morphit", or the
 * locale's inflected/transliterated form from `{brand|…}`).
 */
export type BrandRenderer = (defaultForm: string) => string;

/**
 * Replace every brand placeholder in ONE string. A slot directly followed by
 * "-<letter>" (a compound word) gets the name hyphenated throughout — see
 * brandForCompound. The default form and the prerender sentinel never contain
 * spaces, so an unbranded instance's text is unchanged.
 */
export function applyBrandToString(s: string, render: BrandRenderer): string {
	if (!s.includes('{brand')) return s;
	return s.replace(
		BRAND_PLACEHOLDER_RE,
		(m: string, alt: string | undefined, offset: number, whole: string) => {
			const text = render(alt !== undefined && alt.length > 0 ? alt : DEFAULT_BRAND_NAME);
			return continuesAsCompound(whole, offset + m.length) ? brandForCompound(text) : text;
		}
	);
}

/**
 * Deep-copy a locale dictionary, replacing every brand placeholder in every
 * string leaf via `render`. Non-string leaves are copied as-is; objects and
 * arrays are rebuilt so the source (kept by $i18n for re-application) is never
 * mutated.
 */
export function applyBrandToMessages<T>(dict: T, render: BrandRenderer): T {
	const walk = (v: unknown): unknown => {
		if (typeof v === 'string') return applyBrandToString(v, render);
		if (Array.isArray(v)) return v.map(walk);
		if (v !== null && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child);
			return out;
		}
		return v;
	};
	return walk(dict) as T;
}

/**
 * A filesystem-safe slug of the brand for download filenames
 * ("Vigilante Trading" → "Vigilante-Trading"). Falls back to "Morphit".
 */
export function brandFileSlug(name: string): string {
	const slug = name
		.normalize('NFKD')
		// NFKD splits "é" into "e" + a combining mark; drop the marks so
		// "Café Crème" becomes "Cafe-Creme", not "Cafe-Cre-me".
		.replace(/\p{M}+/gu, '')
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
	return slug.length > 0 ? slug : DEFAULT_BRAND_NAME;
}
