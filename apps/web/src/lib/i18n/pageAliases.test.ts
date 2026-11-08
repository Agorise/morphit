/**
 * Short page addresses typed by hand (v1.23.4): /about lands on the About this
 * instance page, bare or with a language in front.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false, building: false, dev: false }));

import { PAGE_ALIASES, resolvePageAlias } from './pageAliases';

/** What a thrown SvelteKit redirect says. */
async function redirectOf(f: () => unknown): Promise<{ status: number; location: string }> {
	try {
		await f();
	} catch (e) {
		const r = e as { status?: number; location?: string };
		if (typeof r.status === 'number' && typeof r.location === 'string') {
			return { status: r.status, location: r.location };
		}
		throw e;
	}
	throw new Error('no redirect');
}

describe('resolvePageAlias (v1.23.4)', () => {
	it('/about is the About this instance page; its query and fragment ride along', () => {
		expect(PAGE_ALIASES.about).toBe('about-this-instance');
		expect(resolvePageAlias('/about')).toBe('/about-this-instance');
		expect(resolvePageAlias('/about/')).toBe('/about-this-instance');
		expect(resolvePageAlias('/about?x=1#top')).toBe('/about-this-instance?x=1#top');
	});

	it('anything else is left alone', () => {
		for (const p of [
			'/about-this-instance',
			'/aboutx',
			'/about/team',
			'/faq?q=about',
			'/constructor',
			'/toString',
			'/',
			''
		]) {
			expect(resolvePageAlias(p), p).toBe(p);
		}
	});
});

describe('/about, typed by hand (v1.23.4)', () => {
	it("bare: one redirect, straight to the page in the visitor's language", async () => {
		const { load } = await import('../../routes/[lang]/+layout');
		const r = await redirectOf(() =>
			load({ params: { lang: 'about' }, url: new URL('https://vigilante.trading/about') })
		);
		expect(r.location).toBe('/en/about-this-instance');
		// Another unknown first segment still keeps its own path.
		const faq = await redirectOf(() =>
			load({ params: { lang: 'faq' }, url: new URL('https://vigilante.trading/faq?q=x') })
		);
		expect(faq.location).toBe('/en/faq?q=x');
	});

	it("with a language in front: forwarded to that language's page, prerendered for every locale", async () => {
		const page = await import('../../routes/[lang]/about/+page');
		const r = await redirectOf(() =>
			page.load({ params: { lang: 'es' }, url: new URL('https://vigilante.trading/es/about') })
		);
		expect(r).toEqual({ status: 301, location: '/es/about-this-instance' });
		const { SUPPORTED_LOCALES } = await import('./locales');
		expect(page.entries().map((e) => e.lang)).toEqual(SUPPORTED_LOCALES.map((l) => l.code));
	});
});
