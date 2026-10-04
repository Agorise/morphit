/**
 * counts render in the reader's own digits.
 *
 * When English formats a count through ICU plural (`{n, plural, … # …}`),
 * the `#` is locale-formatted: "1,234" en, "۱٬۲۳۴" fa. Six fa/zh strings had
 * replaced the plural with a bare `{n}`, which ICU prints as String(n) —
 * Latin digits and no grouping ("1234 ارزیابی" in a Persian sentence). This
 * renders every such message in every locale with a four-digit count and
 * requires the locale-formatted number to appear.
 */
import { describe, expect, it } from 'vitest';
import { IntlMessageFormat } from 'intl-messageformat';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, 'locales');
const flat = (o: unknown, p = '', out = new Map<string, string>()): Map<string, string> => {
	if (typeof o === 'string') out.set(p, o);
	else if (o && typeof o === 'object')
		for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, out);
	return out;
};
const load = (l: string) => flat(JSON.parse(readFileSync(join(DIR, `${l}.json`), 'utf8')));
const en = load('en');
const locales = readdirSync(DIR)
	.filter((f) => f.endsWith('.json') && f !== 'en.json')
	.map((f) => f.slice(0, -5));
const unbrand = (s: string) => s.replace(/\{brand(?:\|[^{}|]*)?\}/g, 'Morphit');

/** Keys where English pluralises variable `v` with `#`. */
const pluralKeys: Array<{ key: string; v: string }> = [];
for (const [key, msg] of en) {
	for (const m of msg.matchAll(/\{(\w+),\s*plural,[^}]*#/g)) pluralKeys.push({ key, v: m[1]! });
}

describe('plural counts are locale-formatted in every locale (G12)', () => {
	it('found the English plural messages', () => {
		expect(pluralKeys.length).toBeGreaterThan(3);
	});
	for (const loc of locales) {
		it(loc, () => {
			const strings = load(loc);
			const want = new Intl.NumberFormat(loc).format(1234);
			const bad: string[] = [];
			for (const { key, v } of pluralKeys) {
				const msg = strings.get(key);
				if (msg === undefined) continue;
				const values: Record<string, unknown> = {};
				for (const m of unbrand(msg).matchAll(/\{(\w+)/g)) values[m[1]!] = 1;
				values[v] = 1234;
				const out = String(new IntlMessageFormat(unbrand(msg), loc).format(values));
				if (!out.includes(want)) bad.push(`${key}: ${out}`);
			}
			expect(bad).toEqual([]);
		});
	}
});
