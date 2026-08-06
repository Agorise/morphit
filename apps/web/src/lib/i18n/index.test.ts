/**
 * Locale auto-detection tests.
 *
 * Scenarios exercised:
 *   - Exact match on any of our 10 supported locales
 *   - Chinese script routing (traditional → zh-HK; simplified → zh-CN)
 *   - Regional variants that should family-match (es-MX → es)
 *   - Ambiguous or missing tags → null (so caller falls through to default)
 *
 * navigator-side integration (multi-language array walk) is not
 * covered here — that lives in pickInitialLocale() which is
 * private to the module because svelte-i18n's init() has a global
 * side effect.
 */

import { describe, expect, it } from 'vitest';
import { matchSupported } from './index';
import { SUPPORTED_LOCALES } from './locales';

describe('locale auto-detection — matchSupported', () => {
	it('exact-matches every supported locale', () => {
		for (const { code } of SUPPORTED_LOCALES) {
			expect(matchSupported(code)).toBe(code);
		}
	});

	it('family-matches regional variants for non-Chinese locales', () => {
		expect(matchSupported('es-MX')).toBe('es');
		expect(matchSupported('es-AR')).toBe('es');
		expect(matchSupported('de-AT')).toBe('de');
		expect(matchSupported('de-CH')).toBe('de');
		expect(matchSupported('fr-CA')).toBe('fr');
		expect(matchSupported('fr-BE')).toBe('fr');
		expect(matchSupported('it-IT')).toBe('it');
		expect(matchSupported('pl-PL')).toBe('pl');
		expect(matchSupported('ru-RU')).toBe('ru');
		expect(matchSupported('fa-IR')).toBe('fa');
		expect(matchSupported('fa-AF')).toBe('fa');
		expect(matchSupported('en-US')).toBe('en');
		expect(matchSupported('en-GB')).toBe('en');
	});

	it('routes traditional-script Chinese to zh-HK', () => {
		expect(matchSupported('zh-TW')).toBe('zh-HK');
		expect(matchSupported('zh-HK')).toBe('zh-HK');
		expect(matchSupported('zh-MO')).toBe('zh-HK');
		expect(matchSupported('zh-Hant')).toBe('zh-HK');
		expect(matchSupported('zh-Hant-HK')).toBe('zh-HK');
		expect(matchSupported('zh-Hant-TW')).toBe('zh-HK');
	});

	it('routes simplified-script Chinese to zh-CN', () => {
		expect(matchSupported('zh-CN')).toBe('zh-CN');
		expect(matchSupported('zh-SG')).toBe('zh-CN');
		expect(matchSupported('zh-Hans')).toBe('zh-CN');
		expect(matchSupported('zh-Hans-CN')).toBe('zh-CN');
		expect(matchSupported('zh')).toBe('zh-CN'); // bare "zh" defaults to simplified
	});

	it('is case-insensitive for BCP-47 input', () => {
		// Browsers vary on whether they lowercase the region subtag;
		// e.g. Chrome emits "en-US", Safari has historically emitted
		// "en-us" in some contexts. We must handle both.
		expect(matchSupported('ZH-TW')).toBe('zh-HK');
		expect(matchSupported('zh-tw')).toBe('zh-HK');
		expect(matchSupported('ES-MX')).toBe('es');
		expect(matchSupported('FA-IR')).toBe('fa');
	});

	it('returns null for unsupported language tags', () => {
		expect(matchSupported('ja-JP')).toBeNull();
		expect(matchSupported('ko-KR')).toBeNull();
		expect(matchSupported('ar-SA')).toBeNull();
		expect(matchSupported('pt-BR')).toBeNull();
		expect(matchSupported('tr-TR')).toBeNull();
	});

	it('returns null for empty / malformed input', () => {
		expect(matchSupported('')).toBeNull();
		expect(matchSupported('x')).toBeNull();
		expect(matchSupported('----')).toBeNull();
	});
});
