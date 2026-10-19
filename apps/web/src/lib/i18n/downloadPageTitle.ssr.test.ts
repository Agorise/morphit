/**
 * The download page's browser-tab title (and og:/twitter: title) is "Download
 * Morphit" on every site (v1.21.11): no brand, and no site name after it. Head
 * adds " — <instance name>" to an unbranded site's titles; the download page is
 * about the software, so it opts out, while every other page keeps the suffix
 * on an unbranded site and none on a branded one, as before. Renders the real
 * download page (and Head for a control page) on the server with the English
 * strings, as prerender and SSR do, and checks the page's heading and intro
 * links as rendered, not only the strings.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
	const state = { brandName: 'Morphit', instanceName: 'alice-node' };
	// A store whose value is read at subscribe time: each render sees the
	// brand the test set (mock factories run once, so no value is baked in).
	const brand = {
		subscribe(run: (v: { name: string; source: string }) => void) {
			run({ name: state.brandName, source: 'page' });
			return () => {};
		}
	};
	return Object.assign(state, { brand });
});

vi.mock('$app/environment', () => ({ browser: false, dev: false, building: false, version: 't' }));
vi.mock('$app/stores', () => ({
	page: readable({
		url: new URL('https://alice.example/en/download'),
		params: { lang: 'en' },
		data: { lang: 'en' }
	})
}));
vi.mock('svelte-i18n', async (orig) => {
	const { readFileSync: rf } = await import('node:fs');
	const { join: j } = await import('node:path');
	const en = JSON.parse(rf(j(__dirname, 'locales', 'en.json'), 'utf8')) as Record<string, unknown>;
	const lookup = (key: string): string => {
		let v: unknown = en;
		for (const part of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[part];
		return typeof v === 'string' ? v.replace(/\{brand(?:\|[^{}|]*)?\}/g, h.brandName) : key;
	};
	return {
		...((await orig()) as object),
		_: readable((k: string) => lookup(k)),
		locale: readable('en')
	};
});
vi.mock('$stores/instance', () => ({
	instance: readable({ name: h.instanceName, seo: null, alt_networks: {} })
}));
vi.mock('$lib/brand/brand', async (orig) => ({ ...((await orig()) as object), brand: h.brand }));
vi.mock('$lib/notifications/ambient', () => ({ setBaseTitle: () => {} }));

const en = JSON.parse(readFileSync(join(__dirname, 'locales', 'en.json'), 'utf8')) as {
	seo: { download: { title: string } };
	download: { title: string };
};

async function renderDownload(): Promise<{ head: string; body: string }> {
	const { render } = await import('svelte/server');
	const { default: Page } = await import('../../routes/[lang]/download/+page.svelte');
	return render(Page as never, { props: { data: { lang: 'en' } } as never });
}

async function headOf(component: 'download' | 'login'): Promise<string> {
	const { render } = await import('svelte/server');
	if (component === 'download') return (await renderDownload()).head;
	const { default: Head } = await import('../components/Head.svelte');
	return render(Head as never, { props: { routeKey: 'login' } as never }).head;
}
const titleOf = (head: string): string => /<title>([^<]*)<\/title>/.exec(head)?.[1] ?? '';
const metaOf = (head: string, attr: string, key: string): string | null =>
	new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(head)?.[1] ?? null;

describe('download page title: no site name on any site', () => {
	for (const brandName of ['Morphit', 'Vigilante Trading']) {
		const kind = brandName === 'Morphit' ? 'unbranded' : 'branded';
		it(`${kind}: the tab, og:title and twitter:title read the bare title`, async () => {
			h.brandName = brandName;
			const head = await headOf('download');
			for (const t of [
				titleOf(head),
				metaOf(head, 'property', 'og:title'),
				metaOf(head, 'name', 'twitter:title')
			]) {
				expect(t).toBe(en.seo.download.title);
				expect(t).not.toContain('alice-node');
				expect(t).not.toContain('Vigilante');
			}
		});
	}

	// The page itself, not only its strings: the heading shows download.title,
	// the intro is rendered as links (run-a-node, instances), and nothing on
	// the page names the site.
	for (const brandName of ['Morphit', 'Vigilante Trading']) {
		const kind = brandName === 'Morphit' ? 'unbranded' : 'branded';
		it(`${kind}: the heading and the intro's two links render, with no site name`, async () => {
			h.brandName = brandName;
			const { body } = await renderDownload();
			const text = (html: string): string => html.replace(/<[^>]*>/g, '').trim();
			expect(text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(body)?.[1] ?? '')).toBe(en.download.title);
			const intro = /<\/h1>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1] ?? '';
			expect([...intro.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1])).toEqual([
				'/en/run-a-node',
				'/en/instances'
			]);
			expect(text(intro)).not.toContain('](');
			expect(body).not.toContain('Vigilante');
			expect(body).not.toContain('alice-node');
		});
	}

	it('unbranded: another page still carries the instance name', async () => {
		h.brandName = 'Morphit';
		expect(titleOf(await headOf('login'))).toBe('Sign in to Morphit — alice-node');
	});

	it('branded: another page still names the brand, with no suffix', async () => {
		h.brandName = 'Vigilante Trading';
		expect(titleOf(await headOf('login'))).toBe('Sign in to Vigilante Trading');
	});
});
