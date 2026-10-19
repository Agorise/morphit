/**
 * The download page is about the software, so it is not branded (v1.21.11):
 * on a branded site "Get Vigilante Trading" and "install a Vigilante Trading
 * instance … or run your own node" read as if the site were the software.
 * Its title (the heading and the browser tab) is "Download Morphit"; the
 * intro says the site runs on Morphit and links "run their own" to the
 * run-a-node page and "the Federation directory" to the instances page; the
 * source paragraph names the Agorise server. Every locale, as the page
 * renders the intro.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderFaqInline } from '../faq/renderInline';
import { applyBrandToString } from '$lib/brand/brandName';

const DIR = join(__dirname, 'locales');
type Strings = {
	download: { title: string; subtitle: string; mirrors_body: string };
	seo: { download: { title: string; description: string } };
};
const LOCALES = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const read = (f: string): Strings => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Strings;

describe('download page: not branded', () => {
	it('English reads as the maintainer worded it', () => {
		const en = read('en.json');
		expect(en.download.title).toBe('Download Morphit');
		expect(en.seo.download.title).toBe('Download Morphit');
		expect(en.download.subtitle).toBe(
			'This website runs on open source software called Morphit. It enables anyone to [run their own](/run-a-node) Morphit-powered website like this one and get auto-listed in [the Federation directory](/instances) so you can start earning from it.'
		);
		expect(en.download.mirrors_body).toBe(
			'Morphit is 100% free and open source. The canonical repository lives on the Agorise server and is mirrored across the web, so the code stays reachable even if one host is blocked or disappears.'
		);
	});

	it('the 10 locales are all here', () => {
		expect(LOCALES).toHaveLength(10);
	});

	for (const f of LOCALES) {
		it(`${f}: no site name in the title, tab title or intro; Morphit named; both links`, () => {
			const s = read(f);
			for (const t of [s.download.title, s.seo.download.title, s.download.subtitle])
				expect(t, f).not.toContain('{brand}');
			expect(s.download.title, f).toContain('Morphit');
			expect(s.seo.download.title, f).toBe(s.download.title);
			expect(s.download.subtitle, f).toContain('Morphit');
			const html = renderFaqInline(s.download.subtitle, (p) => `/xx${p}`);
			expect(html.match(/href="\/xx\/run-a-node"/g), f).toHaveLength(1);
			expect(html.match(/href="\/xx\/instances"/g), f).toHaveLength(1);
			expect(s.download.mirrors_body, f).toContain('Agorise');
			expect(s.download.mirrors_body, f).not.toContain('Forgejo');
		});

		it(`${f}: on a branded site nothing on the page or in its link preview names the site`, () => {
			const s = read(f);
			const site = 'Vigilante Trading';
			for (const t of [
				s.download.title,
				s.seo.download.title,
				s.seo.download.description,
				s.download.subtitle,
				s.download.mirrors_body
			])
				expect(
					applyBrandToString(t, () => site),
					f
				).not.toContain(site);
		});
	}

	// Chinese text puts a space between Han characters and a Latin word
	// ("名为 Morphit 的"), as the rest of both Chinese locale files does.
	for (const f of ['zh-CN.json', 'zh-HK.json']) {
		it(`${f}: Latin words are spaced from Han characters`, () => {
			const s = read(f);
			for (const t of [
				s.download.title,
				s.seo.download.title,
				s.seo.download.description,
				s.download.subtitle,
				s.download.mirrors_body
			])
				expect(t, f).not.toMatch(/\p{Script=Han}[A-Za-z]|[A-Za-z]\p{Script=Han}/u);
		});
	}
});
