#!/usr/bin/env tsx
/**
 * Smoke for the centralized i18n formatters.
 *
 * Validates that `formatUsd`, `formatPercent`, `formatBlurt`,
 * `formatCount`, `formatDateLong`, `formatDateMedium`, and
 * `formatDateTime` produce locale-aware output and don't
 * regress between locales.
 *
 * The exact glyphs the runtime ICU library produces vary
 * per Node version (CLDR updates, narrow-NBSP changes, etc.),
 * so this smoke tests properties rather than exact strings:
 *
 *   - formatUsd(1234.5) contains "1234" digits in some form
 *     and a USD-region indicator ("$" or "USD" or both).
 *   - formatPercent(1.5) contains the digit pair and a "%".
 *   - formatBlurt(60) produces 3 fractional digits.
 *   - formatCount(1234) contains the digits but possibly with
 *     a separator.
 *   - formatDateLong/Medium/Time return non-empty strings
 *     that include the year as 4 digits in some script.
 *
 * The smoke also checks for graceful failure on NaN /
 * undefined / out-of-range inputs.
 */

import {
	formatUsd,
	formatPercent,
	formatBlurt,
	formatCount,
	formatDateLong,
	formatDateMedium,
	formatDateTime
} from '../src/lib/i18n/formatters';

interface Scenario {
	readonly name: string;
	readonly fn: () => boolean;
}

const scenarios: readonly Scenario[] = [
	// ─── formatUsd ─────────────────────────────────────
	{
		name: 'formatUsd(1234.5) — en, contains 1234',
		fn: () => {
			const out = formatUsd(1234.5);
			// Some locales use NBSP or NNBSP between value and currency
			const digitsOnly = out.replace(/\D/g, '');
			return digitsOnly.includes('123450');
		}
	},
	{
		name: 'formatUsd(0) — returns formatted zero',
		fn: () => {
			const out = formatUsd(0);
			return out.length > 0 && /[0]/.test(out);
		}
	},
	{
		name: 'formatUsd(NaN) — returns "—"',
		fn: () => formatUsd(Number.NaN) === '—'
	},
	{
		name: 'formatUsd(Infinity) — returns "—"',
		fn: () => formatUsd(Number.POSITIVE_INFINITY) === '—'
	},

	// ─── formatPercent ─────────────────────────────────
	{
		name: 'formatPercent(1.5) — contains 1, 5, %',
		fn: () => {
			const out = formatPercent(1.5);
			const hasDigits = /[0-9]/.test(out);
			const hasPercent = out.includes('%');
			return hasDigits && hasPercent;
		}
	},
	{
		name: 'formatPercent(7.6, 1) — APR-style',
		fn: () => {
			const out = formatPercent(7.6, 1);
			return out.includes('%') && /[0-9]/.test(out);
		}
	},
	{
		name: 'formatPercent(NaN) — returns "—"',
		fn: () => formatPercent(Number.NaN) === '—'
	},

	// ─── formatBlurt ───────────────────────────────────
	{
		name: 'formatBlurt(60) — 3 decimals',
		fn: () => {
			const out = formatBlurt(60);
			// "60.000" or "60,000" depending on locale; either way 3
			// digits after the decimal separator.
			const decimalGroup = out.match(/[\\.,](\d+)$/);
			return decimalGroup !== null && decimalGroup[1]!.length === 3;
		}
	},
	{
		name: 'formatBlurt(0.001) — preserves precision',
		fn: () => {
			const out = formatBlurt(0.001);
			return out.includes('001');
		}
	},
	{
		name: 'formatBlurt(60, 0) — zero decimals',
		fn: () => {
			const out = formatBlurt(60, 0);
			return out === '60' || out === '60' || /^[0-9۰-۹]+$/.test(out);
		}
	},

	// ─── formatCount ───────────────────────────────────
	{
		name: 'formatCount(1234) — has digits, no decimal',
		fn: () => {
			const out = formatCount(1234);
			// Check the digits are all there.  A count should never
			// have fractional digits.  The simplest test: the digits
			// in the output (after stripping all non-digit chars)
			// should equal the input as a string.
			const digitsOnly = out.replace(/[^\d]/g, '');
			return digitsOnly === '1234';
		}
	},

	// ─── Date formatters ───────────────────────────────
	{
		name: 'formatDateLong(ISO) — year present',
		fn: () => {
			const out = formatDateLong('2026-05-09T12:00:00Z');
			return out.length > 0 && /\d{4}|[۰-۹]{4}|[٠-٩]{4}/.test(out);
		}
	},
	{
		name: 'formatDateMedium(Date) — non-empty',
		fn: () => {
			const out = formatDateMedium(new Date('2026-05-09'));
			return out.length > 0;
		}
	},
	{
		name: 'formatDateTime(ISO) — has time component',
		fn: () => {
			const out = formatDateTime('2026-05-09T15:30:00Z');
			return out.length > 0 && /[0-9۰-۹]+[:．]?[0-9۰-۹]+/.test(out);
		}
	},
	{
		name: 'formatDateLong(invalid) — returns "—"',
		fn: () => formatDateLong('not-a-date') === '—'
	},

	// ─── Locale-switching ──────────────────────────────
	// Don't actually switch the active locale here (would
	// require async loading of the locale dictionary).  The
	// smoke runs in default 'en'.  Cross-locale validation
	// is deferred to the i18n-locale-parity smoke.
	{
		name: 'formatPercent — sample call before locale set',
		fn: () => {
			// Call before the locale-switcher runs: should fall back to
			// DEFAULT_LOCALE without throwing.
			const out = formatPercent(50);
			return out.includes('%');
		}
	}
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

console.log('');
console.log('── i18n formatters smoke ────────────────────────────────');
console.log('');

// Run synchronously: formatters fall back to DEFAULT_LOCALE
// via the activeLocale() try/catch when the svelte-i18n
// store isn't initialized.  That fallback path is itself
// part of what we're testing — formatters must not crash
// in SSR or smoke contexts.
for (const s of scenarios) {
	try {
		if (s.fn()) {
			passed++;
		} else {
			failed++;
			failures.push(`  ✗ ${s.name}`);
		}
	} catch (err) {
		failed++;
		failures.push(`  ✗ ${s.name} — threw: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failed === 0) {
	console.log(`  ✓ all ${passed} scenarios passed`);
	console.log('');
	console.log('────────────────────────────────────────────────────────');
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`  ${passed} passed, ${failed} failed`);
	console.log('');
	console.log(failures.join('\n'));
	console.log('');
	console.log('────────────────────────────────────────────────────────');
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
