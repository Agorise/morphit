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

// ─── Fiat formatter ────────────────────────────────────────────

/**
 * Tickers Intl.NumberFormat recognizes as ISO 4217 currency codes.
 * For these, `style: 'currency'` produces a locale-aware formatted
 * string with the appropriate symbol ($, €, ¥, etc.).  Listed here
 * to know when to use `currency` style vs. fallback formatting.
 *
 * This is NOT an exhaustive list of ISO 4217 — it's the subset that
 * Morphit's setup wizard offers in its curated list, plus the ones
 * that historically appeared in user-facing strings.  Intl supports
 * many more; if an operator configures a non-listed ISO code,
 * Intl handles it gracefully (the symbol may be the code itself,
 * e.g. "ARS 1,234.56" if no symbol is known for ARS in the locale).
 *
 * Special non-ISO codes:
 *   - XAU (gold ounces) — listed for our purposes; some Intl
 *     implementations recognize it, others don't.  Falls through
 *     to the safe-format path if not recognized.
 *   - XDR (IMF Special Drawing Rights) — same.
 *
 * cp128 design: do NOT hardcode formatting per-ticker here.  Rely
 * on Intl + the locale's own rules.  Trying to be clever about
 * which symbol goes where breaks i18n.
 */
const KNOWN_ISO_4217 = new Set([
	'USD',
	'EUR',
	'GBP',
	'JPY',
	'CNY',
	'INR',
	'BRL',
	'RUB',
	'CAD',
	'AUD',
	'CHF',
	'MXN',
	'KRW',
	'IRR',
	'EGP',
	'ZAR',
	'AED',
	'IDR',
	'XAU',
	'XAG',
	'XDR',
	'BTC',
	'ETH',
	'XMR'
]);

/**
 * Format a fiat amount with locale-aware decimal separator and
 * thousands grouping.
 *
 * Decimal precision adapts to the ticker:
 *   - Standard fiat (USD, EUR, GBP, …) → 2 decimals (cent precision)
 *   - JPY → 0 decimals (no sub-yen)
 *   - XAU, XAG (precious metals) → up to 8 decimals (fractional
 *     ounces traded in tiny amounts at $5,000+/oz)
 *   - XDR (SDR) → 4 decimals
 *   - Anything else → 2 decimals default
 *
 * For ISO-recognized tickers, uses `Intl.NumberFormat`'s currency
 * style, which produces locale-appropriate symbol placement
 * ("$1,234.56" in en-US, "1.234,56 $" in de-DE, "1 234,56 $US" in
 * fr-FR, etc.).  For non-ISO tickers (or when Intl rejects the
 * code), falls back to "{number} {TICKER}" format.
 *
 * cp128: the indexer's listing-fee response carries `denomination_fiat`
 * alongside the numeric value; UI callers pass both into this
 * helper so the rendered output matches the operator's chosen
 * unit.  Default ticker for back-compat = 'USD'.
 */
export function formatFiat(amount: number, ticker: string = 'USD'): string {
	if (!Number.isFinite(amount)) return '—';
	const upperTicker = ticker.toUpperCase();
	const fractionDigits = fractionDigitsForTicker(upperTicker);

	// For ISO-recognized tickers, use the currency style for proper
	// symbol + locale placement.
	if (KNOWN_ISO_4217.has(upperTicker)) {
		try {
			return getNumberFormat(activeLocale(), {
				style: 'currency',
				currency: upperTicker,
				minimumFractionDigits: fractionDigits,
				maximumFractionDigits: fractionDigits
			}).format(amount);
		} catch {
			// Some Intl implementations reject XAU/XAG/XDR/crypto
			// codes; fall through.
		}
	}

	// Fallback for non-ISO tickers (or rejected-by-Intl ones):
	// "{number} {TICKER}".  Use decimal style for the number so it
	// gets locale-appropriate thousands separators.
	const numFormatted = getNumberFormat(activeLocale(), {
		style: 'decimal',
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits
	}).format(amount);
	return `${numFormatted} ${upperTicker}`;
}

/**
 * Per-ticker decimal precision.  Centralized so callers don't have
 * to think about it.  Returns the recommended `minimumFractionDigits`
 * and `maximumFractionDigits` for formatFiat.
 */
function fractionDigitsForTicker(ticker: string): number {
	switch (ticker) {
		case 'JPY':
			return 0;
		case 'XAU':
		case 'XAG':
			return 8;
		case 'XDR':
			return 4;
		case 'BTC':
		case 'ETH':
		case 'XMR':
			return 8;
		default:
			return 2;
	}
}

// ─── (cp128 cleanup) ───────────────────────────────────────────
//
// Prior to cp128 this file exported `formatUsd(amount)`.  All call
// sites have been migrated to `formatFiat(amount, ticker)` with the
// ticker provided from the listing-fee response's `denomination_fiat`
// field.  Pre-launch, no external consumers depend on `formatUsd`,
// so the compat wrapper was removed to keep the API surface
// honestly denomination-agnostic.  If you need a USD-specific
// formatter (e.g. for accounting displays that should always read
// in USD regardless of the operator's configured denomination),
// call `formatFiat(amount, 'USD')` directly.

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

/**
 * Format an integer count COMPACTLY, locale-aware: "1.2K" / "1M" in en,
 * "1,2 Mio." in de, "۱۲۳" in fa. Used for the order-card trade count
 * ("1.2K trades since {month}") where a full grouped number would crowd
 * the row. Small values (< 1000) render as-is. Returns "0" for a
 * zero/absent count so the card can always show "N trades".
 */
export function formatCountCompact(n: number): string {
	if (!Number.isFinite(n)) return '0';
	return getNumberFormat(activeLocale(), {
		notation: 'compact',
		maximumFractionDigits: 1
	}).format(n);
}

// ─── Date formatters ───────────────────────────────────────────

/**
 * Format an ISO timestamp or Date as a localized full-date string, in
 * UTC. "Saturday, May 9, 2026" in en, "samedi 9 mai 2026" in fr. UTC so
 * every displayed date is unambiguous and identical for all parties (see
 * {@link formatDayMonthTime} for the rationale) — the weekday matches the
 * UTC calendar day too.
 */
export function formatDateLong(input: string | Date): string {
	const d = typeof input === 'string' ? new Date(input) : input;
	if (isNaN(d.getTime())) return '—';
	return getDateFormat(activeLocale(), {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		weekday: 'long',
		timeZone: 'UTC'
	}).format(d);
}

/**
 * Format an ISO timestamp or Date as a localized medium-date string, in
 * UTC. "May 9, 2026" in en, "9 mai 2026" in fr.
 */
export function formatDateMedium(input: string | Date): string {
	const d = typeof input === 'string' ? new Date(input) : input;
	if (isNaN(d.getTime())) return '—';
	return getDateFormat(activeLocale(), {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	}).format(d);
}

/**
 * Localized date-and-time string in 24-hour UTC. "May 9, 2026, 17:47" in
 * en. Superseded for most UI by {@link formatDayMonthTime} (the canonical
 * "30 June, 2026 @ HH:MM:SS UTC"); kept UTC + 24-hour here so any future
 * caller stays consistent with the sitewide standard.
 */
export function formatDateTime(input: string | Date): string {
	const d = typeof input === 'string' ? new Date(input) : input;
	if (isNaN(d.getTime())) return '—';
	return getDateFormat(activeLocale(), {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZone: 'UTC'
	}).format(d);
}

/**
 * The project's CANONICAL UI date format: day number, full
 * (translated) month name, a comma, then the 4-digit year —
 * "11 June, 2026" in en, "11 junio, 2026" in es, "11 Juni, 2026"
 * in de, with the digits themselves localized too (e.g. fa shows
 * Persian numerals).  Every plain date the UI shows should flow
 * through this so the format is consistent and translated.
 *
 * The parts are assembled explicitly (rather than via a single
 * Intl pattern) so the ORDER is the same in every locale — Ken's
 * spec is "day, full month, comma, year" regardless of the
 * locale's own default ordering — while the month name and digits
 * are still locale-correct.
 *
 * Guards a missing / unparseable / clearly-bogus pre-2000 value
 * (e.g. an unset epoch-0 timestamp would otherwise render as
 * "31 December, 1969"): returns an em-dash instead.
 */
export function formatDayMonth(input: string | Date | null | undefined): string {
	if (input === null || input === undefined || input === '') return '—';
	const d = typeof input === 'string' ? new Date(input) : input;
	if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '—';
	return dayMonthYearParts(d);
}

/**
 * Assemble "day full-month, year" (Ken's canonical order) with the month
 * name + digits localized, in UTC. UTC so a displayed date is unambiguous
 * and identical for every viewer regardless of their timezone — the same
 * reason the time is UTC (see {@link formatDayMonthTime}); without it a
 * 23:30-UTC instant near month-end would render a different calendar day
 * for a viewer east/west of UTC, and the two chat parties would disagree
 * about "what day did this happen".
 */
function dayMonthYearParts(d: Date): string {
	const loc = activeLocale();
	const day = getDateFormat(loc, { day: 'numeric', timeZone: 'UTC' }).format(d);
	const month = getDateFormat(loc, { month: 'long', timeZone: 'UTC' }).format(d);
	const year = getDateFormat(loc, { year: 'numeric', timeZone: 'UTC' }).format(d);
	return `${day} ${month}, ${year}`;
}

/**
 * The canonical format plus the time in 24-hour UTC, joined by " @ " —
 * "30 June, 2026 @ 16:45:18 UTC" in en, "30 Junio, 2026 @ 16:45:18 UTC"
 * in es. Ken's court-friendly standard: 24-hour time in UTC with an
 * explicit "UTC" suffix, so a displayed timestamp is unambiguous about
 * the timezone it refers to (needed if a chat/order log is ever produced
 * as evidence). The DATE part is rendered in UTC too so it always agrees
 * with the UTC time-of-day (no midnight-boundary mismatch); the month
 * name stays translated. The time itself is fixed Western-digit HH:MM:SS
 * (never locale-shifted digits/separators) so "UTC" always means the same
 * unambiguous string everywhere. Same guards as {@link formatDayMonth}.
 */
export function formatDayMonthTime(input: string | Date | null | undefined): string {
	if (input === null || input === undefined || input === '') return '—';
	const d = typeof input === 'string' ? new Date(input) : input;
	if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '—';
	const date = dayMonthYearParts(d);
	const hh = String(d.getUTCHours()).padStart(2, '0');
	const mm = String(d.getUTCMinutes()).padStart(2, '0');
	const ss = String(d.getUTCSeconds()).padStart(2, '0');
	return `${date} @ ${hh}:${mm}:${ss} UTC`;
}

/**
 * "July, 2026" in en, "julio, 2026" in es — a coarse month+year label
 * (the month name translated, digits localized), in UTC. Used for "N
 * trades since {month year}" on order cards. UTC keeps it consistent
 * with every other displayed date (same rationale as {@link formatDayMonth}).
 * Same missing/bogus guards as {@link formatDayMonth}.
 */
export function formatMonthYear(input: string | Date | null | undefined): string {
	if (input === null || input === undefined || input === '') return '—';
	const d = typeof input === 'string' ? new Date(input) : input;
	if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '—';
	const loc = activeLocale();
	const month = getDateFormat(loc, { month: 'long', timeZone: 'UTC' }).format(d);
	const year = getDateFormat(loc, { year: 'numeric', timeZone: 'UTC' }).format(d);
	return `${month}, ${year}`;
}
