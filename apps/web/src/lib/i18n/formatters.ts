/**
 * Morphit — locale-aware number and date formatters.
 *
 * Tier 3.3 of the grandma-friendly investigation: the
 * codebase has 35+ call sites that format numbers, currency,
 * percentages, and dates using a mix of approaches —
 * `.toFixed(2)` (raw, locale-blind), `.toLocaleString()`
 * (locale-aware but with default formatting), and ad-hoc
 * `Intl.NumberFormat` invocations.  A grandma in Germany
 * sees "$1,234.56" in one place and "1.234,56 USD" in
 * another for the same amount.  Or a fa-locale user sees
 * "1.5%" in one place and "۱٫۵٪" in another.
 *
 * This module centralizes the formatters so every
 * user-facing number/date display flows through a single
 * code path that respects the active locale.
 *
 * Scope intentional:
 *
 *   - On-chain precision values stay raw.  BLURT amounts
 *     are stored at 3-decimal precision on the chain;
 *     `formatBlurt(n)` displays them at that precision
 *     using the locale's decimal separator but does NOT
 *     add thousands separators (the chain doesn't have
 *     them; UI consistency with what the user signs).
 *   - Percentages, USD displays, and counts DO get
 *     locale-aware grouping and decimal separators.
 *   - Dates are timezone-local + locale-formatted via
 *     `Intl.DateTimeFormat`.
 *
 * The helpers read the current locale from svelte-i18n's
 * `currentLocale` store at call time.  In SSR contexts
 * (no store available) they fall back to the
 * `defaultLocale` parameter or 'en'.
 *
 * Performance note: `Intl.NumberFormat` instances are
 * cached per (locale, options) tuple to avoid
 * re-instantiating on every call.  The cache is bounded
 * (one entry per locale × format-kind) so memory stays
 * tiny even for long-running pages.
 */

import { get } from 'svelte/store';
import { locale } from 'svelte-i18n';

// Hardcoded default; matches DEFAULT_LOCALE in i18n/index.ts.
// Kept local so this module doesn't pull in `$app/environment`
// (transitively dragged by `i18n/index`), keeping formatters
// usable in smoke contexts and pure-Node tests.
const DEFAULT_LOCALE = 'en';

// ─── Locale resolution ─────────────────────────────────────────

/** Resolve the active locale.  In SSR or smoke contexts
 *  where the svelte-i18n store hasn't been initialized,
 *  falls back to DEFAULT_LOCALE ('en'). */
function activeLocale(): string {
	try {
		const l = get(locale);
		return l || DEFAULT_LOCALE;
	} catch {
		return DEFAULT_LOCALE;
	}
}

// ─── Cache of NumberFormat instances ───────────────────────────

const numberFormatCache = new Map<string, Intl.NumberFormat>();

function getNumberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
	const key = `${locale}|${JSON.stringify(options)}`;
	const cached = numberFormatCache.get(key);
	if (cached) return cached;
	const fmt = new Intl.NumberFormat(locale, options);
	numberFormatCache.set(key, fmt);
	return fmt;
}

const dateFormatCache = new Map<string, Intl.DateTimeFormat>();

function getDateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${locale}|${JSON.stringify(options)}`;
	const cached = dateFormatCache.get(key);
	if (cached) return cached;
	const fmt = new Intl.DateTimeFormat(locale, options);
	dateFormatCache.set(key, fmt);
	return fmt;
}

// ─── USD formatter ─────────────────────────────────────────────

/**
 * Format a USD amount with locale-aware decimal separator
 * and thousands grouping.  Two decimal places, the standard
 * cent-precision display.  Returns "$1,234.56" in en, "1.234,56 $"
 * in de, "۱٬۲۳۴٫۵۶ $" in fa, etc.
 *
 * The leading "~" tilde used by some call sites for
 * "approximate" should be added by the caller; this
 * function just returns the formatted number.
 */
export function formatUsd(amount: number): string {
	if (!Number.isFinite(amount)) return '—';
	return getNumberFormat(activeLocale(), {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	}).format(amount);
}

// ─── Percent formatter ─────────────────────────────────────────

/**
 * Format a percent value (input is the percentage itself,
 * e.g. 1.5 for 1.5%, NOT 0.015) with locale-aware decimal
 * separator.  Optional `fractionDigits` parameter (default 2)
 * controls precision.  Both minimum and maximum fraction
 * digits are set to `fractionDigits`, so trailing zeros are
 * preserved — "7.50%" not "7.5%" — for visual consistency
 * across rows in tables and lists where adjacent values may
 * have different natural precision.
 *
 * Returns "1.50%" in en, "1,50 %" in de/fr, "۱٫۵۰٪" in fa.
 *
 * Note: we use `style: 'decimal'` and append "%" manually
 * rather than `style: 'percent'` because the latter expects
 * the input to be the fraction (0.015), and most call sites
 * already store the percent value (1.5).  Manually appending
 * loses the locale's percent symbol variant (e.g. fa's "٪")
 * but the difference is small and the consistency benefit
 * across the existing call sites is large.
 */
export function formatPercent(value: number, fractionDigits = 2): string {
	if (!Number.isFinite(value)) return '—';
	const formatted = getNumberFormat(activeLocale(), {
		style: 'decimal',
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits
	}).format(value);
	return `${formatted}%`;
}

// ─── BLURT amount formatter ────────────────────────────────────

/**
 * Format a BLURT amount.  Chain precision is 3 decimals;
 * we preserve that.  Locale-aware decimal separator but no
 * thousands grouping (the chain doesn't have them, and
 * fee/balance displays should match what the user signs in
 * their broadcast op).
 *
 * Returns "60.000" in en, "60,000" in de (note: 60 BLURT,
 * not 60 thousand — the locale flips comma/dot for decimal
 * separators).  This is a known UX papercut for
 * comma-as-decimal locales but a smaller one than mismatched
 * fee text vs broadcast op text.
 */
export function formatBlurt(amount: number, decimals = 3): string {
	if (!Number.isFinite(amount)) return '—';
	return getNumberFormat(activeLocale(), {
		style: 'decimal',
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
		useGrouping: false
	}).format(amount);
}

// ─── Count formatter ───────────────────────────────────────────

/**
 * Format an integer count with locale-aware thousands
 * grouping.  Returns "1,234" in en, "1.234" in de,
 * "1 234" in ru/fr, "۱٬۲۳۴" in fa.
 */
export function formatCount(n: number): string {
	if (!Number.isFinite(n)) return '—';
	return getNumberFormat(activeLocale(), {
		style: 'decimal',
		maximumFractionDigits: 0
	}).format(n);
}

// ─── Date formatters ───────────────────────────────────────────

/**
 * Format an ISO timestamp or Date as a localized
 * full-date string.  "Saturday, May 9, 2026" in en,
 * "samedi 9 mai 2026" in fr, "9 мая 2026 г." in ru.
 */
export function formatDateLong(input: string | Date): string {
	const d = typeof input === 'string' ? new Date(input) : input;
	if (isNaN(d.getTime())) return '—';
	return getDateFormat(activeLocale(), {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		weekday: 'long'
	}).format(d);
}

/**
 * Format an ISO timestamp or Date as a localized
 * medium-date string.  "May 9, 2026" in en,
 * "9 mai 2026" in fr, "9 мая 2026" in ru.
 */
export function formatDateMedium(input: string | Date): string {
	const d = typeof input === 'string' ? new Date(input) : input;
	if (isNaN(d.getTime())) return '—';
	return getDateFormat(activeLocale(), {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	}).format(d);
}

/**
 * Format an ISO timestamp or Date as a localized
 * date-and-time string at the time component's precision.
 * "May 9, 2026, 5:47 PM" in en, "9 mai 2026 à 17:47" in fr.
 */
export function formatDateTime(input: string | Date): string {
	const d = typeof input === 'string' ? new Date(input) : input;
	if (isNaN(d.getTime())) return '—';
	return getDateFormat(activeLocale(), {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	}).format(d);
}
