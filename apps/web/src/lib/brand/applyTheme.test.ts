/**
 * applyTheme — the SPA shell's half of per-instance colour theming: brand.json's
 * `theme` block becomes inline custom properties on <html>. brand.json is
 * served by the instance, but only strictly-shaped values may reach the style
 * attribute, and a page themed server-side (prerendered, `<style
 * id="morphit-theme">`) must not be overridden.
 */
import { describe, expect, it } from 'vitest';
import { applyTheme, THEME_STYLE_ID } from './applyTheme';

function fakeRoot(opts: { themedPage?: boolean; meta?: boolean } = {}) {
	const props = new Map<string, string>();
	let metaContent = '#00DA69';
	const meta = { setAttribute: (_: string, v: string) => (metaContent = v) };
	const root = {
		style: { setProperty: (k: string, v: string) => props.set(k, v) },
		ownerDocument: {
			getElementById: (id: string) => (opts.themedPage && id === THEME_STYLE_ID ? {} : null),
			querySelector: (sel: string) =>
				opts.meta !== false && sel === 'meta[name="theme-color"]' ? meta : null
		}
	};
	return { root: root as unknown as HTMLElement, props, meta: () => metaContent };
}

describe('applyTheme (SPA shell, brand.json theme)', () => {
	it('sets every token as an "R G B" custom property, the grid opacity and theme-color', () => {
		const f = fakeRoot();
		const ok = applyTheme(
			{
				tokens: { 'brand-1': '#f3dca0', 'brand-2': '#D6B26A', 'surface-950': '#181818' },
				grid_opacity: 0.05
			},
			f.root
		);
		expect(ok).toBe(true);
		expect(Object.fromEntries(f.props)).toEqual({
			'--brand-1-rgb': '243 220 160',
			'--brand-2-rgb': '214 178 106',
			'--surface-950-rgb': '24 24 24',
			'--grid-opacity': '0.05'
		});
		expect(f.meta()).toBe('#D6B26A');
	});

	it('drops anything that is not a plain token name with a #rrggbb value', () => {
		const f = fakeRoot();
		applyTheme(
			{
				tokens: {
					'brand-1': 'red',
					'brand-2': '#00da69; background: url(//evil)',
					'x;y': '#000000',
					'--brand-3': '#000000',
					'Brand-3': '#000000',
					'brand-3': '#123',
					'surface-900': 123,
					'surface-800': '#1a202b'
				},
				grid_opacity: 5
			},
			f.root
		);
		expect(Object.fromEntries(f.props)).toEqual({ '--surface-800-rgb': '26 32 43' });
		expect(f.meta()).toBe('#00DA69');
	});

	it('leaves a server-side-themed page alone, and ignores a missing/garbage block', () => {
		const themed = fakeRoot({ themedPage: true });
		expect(applyTheme({ tokens: { 'brand-1': '#f3dca0' } }, themed.root)).toBe(false);
		expect(themed.props.size).toBe(0);
		for (const junk of [null, undefined, 'x', 42, {}, { tokens: null }, { tokens: 'x' }]) {
			const f = fakeRoot();
			expect(applyTheme(junk, f.root)).toBe(false);
			expect(f.props.size).toBe(0);
		}
	});
});
