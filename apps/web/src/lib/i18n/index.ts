import { browser } from '$app/environment';
import { init, register, locale, _ } from 'svelte-i18n';
import { isolateAtHandles } from './rtlHandle';
import { derived, get, writable } from 'svelte/store';

// Pure constants + matchSupported() are SSoT in ./locales.  This
// module re-exports them so existing call sites that do
// `import { SUPPORTED_LOCALES, DEFAULT_LOCALE, matchSupported, type
// LocaleCode } from '$i18n'` keep working unchanged.
//
// The split exists because ./locales has no SvelteKit deps, so
// modules like ./path.ts (used by the prerender-redirect shell)
// and the i18n-path-helpers-smoke can import the constants
// without dragging in `$app/environment`.
export {
	DEFAULT_LOCALE,
	SUPPORTED_LOCALES,
	PLANNED_LOCALES,
	matchSupported,
	type LocaleCode,
	type KnownLocaleCode
} from './locales';

import { SUPPORTED_LOCALES, DEFAULT_LOCALE, matchSupported, type LocaleCode } from './locales';

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
	// t.txt (Ken) — isolate @{handle} slots (LTR) at load time so usernames
	// render "@alice", never "alice@", in RTL locales. See rtlHandle.ts.
	register(code, () =>
		import(`./locales/${code}.json`).then((m) =>
			isolateAtHandles((m as { default?: unknown }).default ?? m)
		)
	);
}

/**
 * PLANNED_LOCALES and the LocaleCode types are SSoT in ./locales
 * (re-exported at the top of this module).  Module-doc on the
 * original lived here; moved alongside the data:
 *
 *   - Each entry represents work in progress for a future locale.
 *     Once the JSON file ships native-reviewed, an entry moves
 *     from PLANNED → SUPPORTED (one-line edit in ./locales).
 *
 *   - Separate lists (not a `ready: true/false` flag) so the
 *     switcher dropdown can't accidentally expose half-translated
 *     locales, and so vite/rollup only sees the loop over
 *     SUPPORTED_LOCALES for bundle splitting.
 *
 *   - Audience priority order for planned: Hindi (~600M), Arabic
 *     (~370M, second RTL test alongside fa), Bengali (~270M),
 *     Portuguese (~260M), Indonesian (~200M), Japanese (~125M),
 *     Vietnamese (~85M).
 */

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

/** matchSupported(tag) moved to ./locales (SSoT) and re-exported
 *  at the top of this module.  The duplicate body that used to
 *  live here was identical; consolidating eliminates drift risk. */

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
