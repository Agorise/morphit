/**
 * v1.20.0 fix wave, G12 — ratings are shown in the reader's number format.
 * The chips used `rating.toFixed(2)` ("4.50" in every locale).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { locale } from 'svelte-i18n';

import { formatRating } from './formatters';

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
