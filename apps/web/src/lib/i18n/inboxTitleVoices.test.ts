/**
 * Every language has the inbox's two subject-line families (v1.21.17), one
 * phrase per order shape, carrying exactly the placeholders the poster's own
 * line carries — a dropped {settlement} reads "… of BLURT with" again.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from './locales';

type Family = Partial<Record<string, string>>;
interface Locale {
	order_title_3p: Family;
	order_title_mine?: Family;
	order_title_who?: Family;
}
const load = (l: string): Locale =>
	JSON.parse(readFileSync(new URL(`./locales/${l}.json`, import.meta.url), 'utf8')) as Locale;
const holes = (s: string | undefined): string[] =>
	[...(s ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('inbox subject-line families', () => {
	const en = load('en');
	it('English reads "Regarding my buy order of …" and "Who is buying …"', () => {
		expect(en.order_title_mine?.buy_min).toBe(
			'Regarding my buy order of at least {amount} {fiat} of {asset} with {settlement}'
		);
		expect(en.order_title_who?.buy_min).toBe(
			'Who is buying at least {amount} {fiat} of {asset} with {settlement}'
		);
	});
	for (const { code: locale } of SUPPORTED_LOCALES) {
		it(`${locale}: every shape, the same placeholders, no "RE:"`, () => {
			const d = load(locale);
			for (const fam of ['order_title_mine', 'order_title_who'] as const) {
				const f: Family = d[fam] ?? {};
				expect(Object.keys(f).sort()).toEqual(Object.keys(d.order_title_3p).sort());
				for (const [k, v] of Object.entries(d.order_title_3p)) {
					expect(holes(f[k]), `${locale} ${fam}.${k}`).toEqual(holes(v));
					expect(f[k]).not.toMatch(/^\s*RE\b/i);
				}
			}
		});
	}
});
