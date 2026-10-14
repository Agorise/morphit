// @vitest-environment jsdom
/**
 * /brand/theme.css carries the site name (v1.21.8): every page links it before
 * anything paints, so the pages the app draws in the browser know the name
 * and colours from their first frame — no Morphit look first, no wait for
 * brand.json (vigilante.trading, 2026-10-13).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	BRAND_NAME_CSS_PROP,
	brandNameCssHex,
	decodeBrandNameCssHex,
	sanitizeBrandName
} from '@morphit/operator-config/brand';
import { brandThemeCss, deriveTheme } from '@morphit/operator-config/theme';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

describe('the name in /brand/theme.css', () => {
	it('round-trips every usable name exactly', () => {
		for (const name of [
			'Vigilante Trading',
			'Libertad Latina',
			'Café Ñandú',
			'מורפיט מרקט',
			'交易所',
			'Mörph’it 24/7',
			'A}B{C;D"E\\F',
			'x'.repeat(48)
		]) {
			const want = sanitizeBrandName(name);
			expect(decodeBrandNameCssHex(brandNameCssHex(name)), name).toBe(want);
		}
	});
	it('is one CSS identifier, whatever the name (nothing breaks out of the stylesheet)', () => {
		for (const name of ['A}B{C;D"E\\F', 'x</style><script>', 'a\nb'])
			expect(brandNameCssHex(name)).toMatch(/^h[0-9a-f]+$/);
	});
	it('anything that is not exactly that encoding names no site', () => {
		for (const raw of [
			'',
			'h',
			'h5',
			'hzz',
			'"Vigilante"',
			'Vigilante',
			'H5669',
			'hff',
			'h' + '61'.repeat(300),
			'h00',
			'xh5669',
			'h5669x',
			'h5669 h5669'
		])
			expect(decodeBrandNameCssHex(raw), raw).toBeNull();
		expect(decodeBrandNameCssHex(undefined)).toBeNull();
	});
	it('the file branding writes: the name, and the colours when there is a theme', () => {
		const t = deriveTheme({ preset: 'champagne-gold' });
		if (!t.ok) throw new Error('theme');
		const css = brandThemeCss('Vigilante Trading', t.palette);
		expect(css).toContain(`${BRAND_NAME_CSS_PROP}:${brandNameCssHex('Vigilante Trading')}`);
		expect(css).toContain('--brand-btn-edge-rgb:255 249 232');
		expect(css).toMatch(/^\/\*[^]*?\*\/\nhtml:root\{[^{}]*\}\n$/);
		expect(brandThemeCss('Vigilante Trading', null)).not.toContain('-rgb:');
	});
});

describe('the page reads it before anything renders', () => {
	afterEach(() => {
		document.head.innerHTML = '';
		document.documentElement.removeAttribute('style');
		delete document.documentElement.dataset.brandName;
		vi.unstubAllGlobals();
		vi.resetModules();
	});
	const sheet = (css: string): void => {
		const st = document.createElement('style');
		st.textContent = css;
		document.head.appendChild(st);
	};

	it('a page the app draws in the browser (no data-brand-name) is branded from the start — no brand.json wait', async () => {
		sheet(`html:root{${BRAND_NAME_CSS_PROP}:${brandNameCssHex('Vigilante Trading')}}`);
		const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);
		vi.resetModules();
		const b = await import('./brand');
		// At module load — before the layout awaits anything.
		expect(get(b.brand)).toEqual({ name: 'Vigilante Trading', source: 'css' });
		expect(get(b.brandName)).toBe('Vigilante Trading');
		expect(document.documentElement.dataset.brandName).toBe('Vigilante Trading');
		// ensureBrand resolves at once with it (brand.json only refreshes the
		// browser's theme-color, off the render path).
		await expect(b.ensureBrand()).resolves.toEqual({ name: 'Vigilante Trading', source: 'css' });
	});

	it("the browser's toolbar colour (theme-color) is the site's from the start, with brand.json never answering", async () => {
		const meta = document.createElement('meta');
		meta.name = 'theme-color';
		meta.content = '#00DA69';
		document.head.appendChild(meta);
		sheet(
			`html:root{${BRAND_NAME_CSS_PROP}:${brandNameCssHex('Vigilante Trading')};--brand-2-rgb:214 178 106}`
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>(() => undefined))
		);
		vi.resetModules();
		const b = await import('./brand');
		await expect(b.ensureBrand()).resolves.toEqual({ name: 'Vigilante Trading', source: 'css' });
		expect(meta.content.toLowerCase()).toBe('#d6b26a');
	});

	it('a stylesheet that arrives after the script started still names the site, and colours the toolbar (no brand.json)', async () => {
		const meta = document.createElement('meta');
		meta.name = 'theme-color';
		meta.content = '#00DA69';
		document.head.appendChild(meta);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>(() => undefined))
		);
		vi.resetModules();
		const b = await import('./brand');
		expect(get(b.brand).source).toBe('default');
		sheet(
			`html:root{${BRAND_NAME_CSS_PROP}:${brandNameCssHex('Vigilante Trading')};--brand-2-rgb:214 178 106}`
		);
		await expect(b.ensureBrand()).resolves.toEqual({ name: 'Vigilante Trading', source: 'css' });
		expect(get(b.brandName)).toBe('Vigilante Trading');
		expect(meta.content.toLowerCase()).toBe('#d6b26a');
	});

	/** brand.json as a copy stored before a re-brand: the old colours. */
	const staleBrandJson = () =>
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						schema: 1,
						name: 'Vigilante Trading',
						theme: { tokens: { 'brand-2': '#c81e1e', 'brand-primary': '#c81e1e' } }
					}),
					{ status: 200 }
				)
		);
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
	};

	for (const late of [false, true])
		it(`colours from the stylesheet are never painted over by an older brand.json (${late ? 'stylesheet arriving late' : 'stylesheet there from the start'})`, async () => {
			const meta = document.createElement('meta');
			meta.name = 'theme-color';
			meta.content = '#00DA69';
			document.head.appendChild(meta);
			const css = `html:root{${BRAND_NAME_CSS_PROP}:${brandNameCssHex('Vigilante Trading')};--brand-2-rgb:214 178 106}`;
			if (!late) sheet(css);
			vi.stubGlobal('fetch', staleBrandJson());
			vi.resetModules();
			const b = await import('./brand');
			if (late) sheet(css);
			await b.ensureBrand();
			await settle();
			expect(document.documentElement.style.getPropertyValue('--brand-2-rgb')).toBe('');
			expect(document.documentElement.style.getPropertyValue('--brand-primary-rgb')).toBe('');
			expect(meta.content.toLowerCase()).toBe('#d6b26a');
		});

	it('ensureBrand on a page the stylesheet names does not wait for brand.json', async () => {
		sheet(`html:root{${BRAND_NAME_CSS_PROP}:${brandNameCssHex('Vigilante Trading')}}`);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>(() => undefined))
		);
		vi.resetModules();
		const b = await import('./brand');
		let settled = false;
		void b.ensureBrand().then(() => (settled = true));
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(settled).toBe(true);
	});

	it('a stylesheet that names no site (unbranded, or an older branding) falls back to brand.json', async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ schema: 1, name: 'Libertad Latina' }), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchSpy);
		vi.resetModules();
		const b = await import('./brand');
		expect(get(b.brand).source).toBe('default');
		await expect(b.ensureBrand()).resolves.toEqual({ name: 'Libertad Latina', source: 'json' });
		expect(fetchSpy).toHaveBeenCalled();
	});

	it('a prerendered page keeps the name it was stamped with', async () => {
		document.documentElement.dataset.brandName = 'Vigilante Trading';
		sheet(`html:root{${BRAND_NAME_CSS_PROP}:${brandNameCssHex('Something Else')}}`);
		vi.resetModules();
		const b = await import('./brand');
		expect(get(b.brand)).toEqual({ name: 'Vigilante Trading', source: 'page' });
	});
});
