/**
 * FAQ search on the real FAQ text. On a branded site the FAQ names the site with its
 * brand; a visitor who types a question as the FAQ shows it must find that
 * answer, whatever the brand: one that is part of other words ("Bit" in
 * "Bitcoin", "Trade" in "Trader"), one with a short word ("Crypto 4 All"), one
 * that shares a word with a topic ("Bitcoin Barter"), one in a script without
 * spaces (交易所, "exchange"). And "the app" asks for the app, not what the site
 * is.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAQ_KEYS, searchEntries, type FaqEntry } from './faqIndex';
import { applyBrandToString } from '../../../../../packages/operator-config/src/brand';

function entries(locale: string, brand: string): FaqEntry[] {
	const j = JSON.parse(
		readFileSync(join(__dirname, '..', 'i18n', 'locales', `${locale}.json`), 'utf8')
	);
	const fill = (s: string): string => applyBrandToString(s, () => brand);
	return FAQ_KEYS.map((key) => ({
		key,
		question: fill(j.faq.entries[key].q),
		answer: fill(j.faq.entries[key].a),
		related: []
	}));
}
function top(
	locale: string,
	brand: string,
	key: string
): { top: string | undefined; found: boolean } {
	const e = entries(locale, brand);
	const q = e.find((x) => x.key === key)!.question;
	const hits = searchEntries(e, q, Infinity, brand);
	return { top: hits[0]?.entry.key, found: hits.some((h) => h.entry.key === key) };
}

describe('FAQ search, branded site', () => {
	it.each([
		['en', 'Bit', 'vs_others'],
		['de', 'Bit', 'vs_others'],
		['en', 'Vigilante Trading', 'what_is_morphit_chat'],
		['en', 'Bitcoin Barter', 'what_is_barter'],
		['de', 'Trade', 'new_trader_badge'],
		['zh-CN', 'Crypto 4 All', 'what_is_morphit_chat'],
		['zh-CN', '交易所', 'arbitrage_morphit_vs_exchanges']
	])('%s, brand %s: the question of %s finds it first', (locale, brand, key) => {
		expect(top(locale, brand, key)).toEqual({ top: key, found: true });
	});
});

const enJson = JSON.parse(
	readFileSync(join(__dirname, '..', 'i18n', 'locales', 'en.json'), 'utf8')
);
const enEntries: FaqEntry[] = FAQ_KEYS.map((key) => ({
	key,
	question: applyBrandToString(enJson.faq.entries[key].q, (f: string) => f),
	answer: applyBrandToString(enJson.faq.entries[key].a, (f: string) => f),
	related: []
}));
const INSTALL = ['android_sideload', 'iphone_install', 'mobile_desktop'];
describe('FAQ search: the app', () => {
	it.each(['where is the app', 'the app', 'your app'])(
		'"%s" leads with how to get the app',
		(q) => {
			expect(INSTALL).toContain(searchEntries(enEntries, q, 1)[0]?.entry.key);
		}
	);
	it.each(["what's this app", 'what is this site', 'what is this'])(
		'"%s" is the introduction',
		(q) => {
			expect(searchEntries(enEntries, q, 1)[0]?.entry.key).toBe('what_is_morphit');
		}
	);
});
