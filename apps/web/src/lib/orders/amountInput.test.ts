/**
 * typed amounts in every locale.
 *
 * The old field sanitizers (post/edit `keepDecimal`, PayBlurtModal
 * `sanitizeAmount`) dropped every "," as it was typed: a German "12,50" became
 * "1250" (100× the money) and Persian digits vanished. The legacy behaviour is
 * reproduced below (`legacyKeepDecimal`, a verbatim copy) so this file shows
 * the defect next to the fix.
 */
import { describe, expect, it } from 'vitest';

import {
	filterAmountTyping,
	formatAmountForInput,
	localeDecimalSeparator,
	parseAmountInput
} from './amountInput';
import { SUPPORTED_LOCALES } from '$lib/i18n/locales';

/** Verbatim pre-fix post/+page.svelte keepDecimal (for contrast). */
function legacyKeepDecimal(raw: string): string {
	let seenDot = false;
	let out = '';
	for (const ch of raw) {
		if (ch >= '0' && ch <= '9') out += ch;
		else if (ch === '.' && !seenDot) {
			out += ch;
			seenDot = true;
		}
	}
	return out;
}

const ok = (raw: string, loc: string, value: string, signed = false) =>
	expect(parseAmountInput(raw, loc, { signed })).toMatchObject({ ok: true, value });
const bad = (raw: string, loc: string, reason: 'invalid' | 'ambiguous' | 'empty') =>
	expect(parseAmountInput(raw, loc)).toMatchObject({ ok: false, reason });

describe('legacy sanitizer (the bug)', () => {
	it('turned a German 12,50 into 1250 and Persian digits into nothing', () => {
		expect(legacyKeepDecimal('12,50')).toBe('1250');
		expect(legacyKeepDecimal('۱۲٫۵')).toBe('');
	});
});

describe('parseAmountInput (G6)', () => {
	it('never turns a comma decimal into a larger number', () => {
		for (const loc of ['de', 'es', 'fr', 'it', 'pl', 'ru']) {
			ok('12,50', loc, '12.50');
			ok('0,5', loc, '0.5');
		}
		// Even in a dot-decimal locale, "12,5" cannot be a thousands group.
		ok('12,5', 'en', '12.5');
		ok('12,50', 'en', '12.50');
	});

	it('dot decimals', () => {
		ok('12.5', 'en', '12.5');
		ok('0.001', 'zh-CN', '0.001');
		ok('12.5', 'de', '12.5'); // cannot be a German thousands group
	});

	it('refuses the genuinely ambiguous single-separator + 3 digits', () => {
		bad('1,234', 'en', 'ambiguous');
		bad('1.234', 'de', 'ambiguous');
		const r = parseAmountInput('1,234', 'en');
		expect(r.ok === false && r.readings).toEqual(['1234', '1.234']);
		const d = parseAmountInput('1.234', 'de');
		expect(d.ok === false && d.readings).toEqual(['1234', '1,234']);
		// …but in the locale where that mark IS the decimal, it is unambiguous.
		ok('1,234', 'de', '1.234');
		ok('1.234', 'en', '1.234');
	});

	it('full grouping with both marks is read structurally', () => {
		ok('1.234,56', 'de', '1234.56');
		ok('1,234.56', 'en', '1234.56');
		ok('1,234,567', 'en', '1234567');
		ok('1 234 567,5', 'fr', '1234567.5');
		ok('1 234,5', 'fr', '1234.5');
		bad('1,23,4.5', 'en', 'invalid');
		bad('1.2.3', 'en', 'invalid');
	});

	it('native digits and marks', () => {
		ok('۱۲٫۵', 'fa', '12.5');
		ok('۱۲', 'fa', '12');
		ok('١٢٫٥', 'fa', '12.5');
		ok('１２．５', 'zh-CN', '12.5');
		ok('۱٬۲۳۴٫۵', 'fa', '1234.5');
	});

	it('rejects junk and empties', () => {
		bad('', 'en', 'empty');
		bad('   ', 'en', 'empty');
		bad('abc', 'en', 'invalid');
		bad('1e3', 'en', 'invalid');
		bad('12,', 'de', 'invalid');
		bad('-5', 'en', 'invalid');
	});

	it('signed (spread) accepts one leading minus', () => {
		ok('-2,5', 'de', '-2.5', true);
		ok('−3', 'en', '-3', true);
	});

	it('locale decimal marks', () => {
		expect(localeDecimalSeparator('de')).toBe(',');
		expect(localeDecimalSeparator('pl')).toBe(',');
		expect(localeDecimalSeparator('fa')).toBe('.');
		expect(localeDecimalSeparator('zh-HK')).toBe('.');
		expect(localeDecimalSeparator(undefined)).toBe('.');
	});
});

describe('filterAmountTyping', () => {
	it('keeps every digit script and both marks; drops letters and symbols', () => {
		expect(filterAmountTyping('12,50 €')).toBe('12,50 ');
		expect(filterAmountTyping('۱۲٫۵')).toBe('۱۲٫۵');
		expect(filterAmountTyping('$1,234.5x')).toBe('1,234.5');
		expect(filterAmountTyping('-5')).toBe('5');
		expect(filterAmountTyping('-5', { signed: true })).toBe('-5');
	});
});

describe('formatAmountForInput', () => {
	it('round-trips a stored number through the parser in every locale', () => {
		for (const { code: loc } of SUPPORTED_LOCALES) {
			for (const n of [1.234, 0.5, 1234.56, 18, 1e-7, 1234567]) {
				const r = parseAmountInput(formatAmountForInput(n, loc), loc);
				expect(r.ok && r.number).toBe(n);
			}
		}
	});
});
