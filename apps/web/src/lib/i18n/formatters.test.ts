/**
 * ratings are shown in the reader's number format.
 * The chips used `rating.toFixed(2)` ("4.50" in every locale).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { locale } from 'svelte-i18n';

import { formatRating } from './formatters';
import { SUPPORTED_LOCALES } from './locales';

describe('formatRating (G12)', () => {
	afterAll(() => locale.set('en'));
	for (const [loc, want] of [
		['en', '4.50'],
		['de', '4,50'],
		['fr', '4,50'],
		['ru', '4,50'],
		['fa', '۴٫۵۰'],
		['zh-CN', '4.50']
	] as const) {
		it(`${loc}: ${want}`, () => {
			locale.set(loc);
			expect(formatRating(4.5)).toBe(want);
			// The pre-fix expression, for contrast: locale-blind.
			if (loc !== 'en' && loc !== 'zh-CN') expect((4.5).toFixed(2)).not.toBe(want);
		});
	}
});

describe('formatMonthYearShort (v1.23.0, the /witnesses "since Nov \'25")', () => {
	afterAll(() => locale.set('en'));
	it('the short month, an apostrophe and the 2-digit year, in UTC', async () => {
		const { formatMonthYearShort } = await import('./formatters');
		locale.set('en');
		expect(formatMonthYearShort('2025-11-30T23:59:59Z')).toBe("Nov '25");
		// UTC: the first of the month just after midnight UTC is that month everywhere.
		expect(formatMonthYearShort('2022-10-01T00:30:00Z')).toBe("Oct '22");
		locale.set('de');
		expect(formatMonthYearShort('2022-10-01T21:41:42Z')).toBe("Okt '22");
		expect(formatMonthYearShort('')).toBe('');
		expect(formatMonthYearShort('1970-01-01T00:00:00Z')).toBe('');
		expect(formatMonthYearShort('nonsense')).toBe('');
	});

	it('June and July stay apart in every locale (a clipped long name made both "jui" in fr)', async () => {
		const { formatMonthYearShort } = await import('./formatters');
		for (const { code: loc } of SUPPORTED_LOCALES) {
			locale.set(loc);
			const june = formatMonthYearShort('2021-06-15T12:00:00Z');
			const july = formatMonthYearShort('2021-07-15T12:00:00Z');
			expect(june, loc).not.toBe(july);
			expect(june.length, loc).toBeGreaterThan(0);
		}
		locale.set('fr');
		expect(formatMonthYearShort('2021-07-15T12:00:00Z')).toBe("juil. '21");
	});

	it('Chinese uses its own year-month form; Persian the full month and year', async () => {
		const { formatMonthYearShort } = await import('./formatters');
		locale.set('zh-CN');
		expect(formatMonthYearShort('2021-07-15T12:00:00Z')).toBe('21年7月');
		locale.set('fa');
		const fa = formatMonthYearShort('2021-07-15T12:00:00Z');
		expect(fa).toBe('تیر ۱۴۰۰');
		expect(fa).not.toContain("'");
	});
});

describe('formatFiatCode (v1.23.2: the "(≈11 BRL)" beside a coin amount)', () => {
	it('the number, then the currency code; no trailing zeros; at most 2 decimals', async () => {
		const { formatFiatCode } = await import('./formatters');
		locale.set('en');
		expect(formatFiatCode(11, 'BRL')).toBe('11 BRL');
		expect(formatFiatCode(10.98765, 'brl')).toBe('10.99 BRL');
		expect(formatFiatCode(1234.5, 'USD')).toBe('1,234.5 USD');
		expect(formatFiatCode(Number.NaN, 'USD')).toBe('');
	});

	it("each locale's own digits and separators", async () => {
		const { formatFiatCode } = await import('./formatters');
		locale.set('de');
		expect(formatFiatCode(1234.5, 'EUR')).toBe('1.234,5 EUR');
		locale.set('fa');
		expect(formatFiatCode(11, 'IRR')).toBe('۱۱ IRR');
		locale.set('en');
	});
});
