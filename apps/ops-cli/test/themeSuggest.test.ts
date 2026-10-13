/**
 * Easy colours: one main colour, or the colours of the logo, and Morphit works
 * out the rest (2026-10-12: "maybe i can just edit the primary colors and then
 * morphit decides on all of the other colors automatically, based on the colors
 * they have entered, or ones that appear to be the primary colors in their logo").
 *
 * Every suggestion must be a theme the derivation accepts as it is — readable
 * everywhere — so the operator never gets a suggestion that is then refused.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio, deriveTheme, suggestTheme } from '@morphit/operator-config/theme';
import { logoColours } from '../src/lib/brandColours.ts';
import { colourAnswer } from '../src/commands/branding.ts';

/** OKLab lightness, enough to say which of two colours is lighter. */
function lightness(hex: string): number {
	const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const lin = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return Math.cbrt(0.4122 * lin[0]! + 0.5363 * lin[1]! + 0.0514 * lin[2]!);
}

function hue(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
	const max = Math.max(r!, g!, b!);
	const min = Math.min(r!, g!, b!);
	if (max === min) return 0;
	const d = max - min;
	const h = max === r ? ((g! - b!) / d) % 6 : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
	return (h * 60 + 360) % 360;
}

describe('suggestTheme', () => {
	const samples = [
		'#d4a017', // gold
		'#1e88e5', // blue
		'#e53935', // red
		'#8e24aa', // purple
		'#43a047', // green
		'#0b3d91', // a dark navy main colour
		'#ffe082', // a very light yellow
		'#ff6f00' // orange
	];

	it.each(samples)('one main colour %s → a whole theme the derivation accepts', (c) => {
		const s = suggestTheme([c]);
		expect(s).not.toBeNull();
		const r = deriveTheme(s!);
		expect(r.ok, r.ok ? '' : r.problems.join('; ')).toBe(true);
		// A gradient from lighter to deeper, in the colour's own hue family.
		expect(lightness(s!.from)).toBeGreaterThan(lightness(s!.to));
		const dh = Math.abs(hue(s!.from) - hue(c));
		expect(Math.min(dh, 360 - dh)).toBeLessThan(40);
		// A dark page the text reads on.
		expect(contrastRatio(s!.background, '#ffffff')).toBeGreaterThan(12);
	});

	it('two colours: the lighter starts the gradient, the deeper ends it', () => {
		const s = suggestTheme(['#bb872f', '#f3dca0'])!;
		expect(s.from).toBe('#f3dca0');
		expect(s.to).toBe('#bb872f');
		expect(deriveTheme(s).ok).toBe(true);
	});

	it('a deep second colour is lifted until it reads on the page', () => {
		const s = suggestTheme(['#f3dca0', '#5a3d0a'])!;
		expect(s).not.toBeNull();
		expect(deriveTheme(s).ok).toBe(true);
		expect(contrastRatio(s.to, s.background)).toBeGreaterThanOrEqual(3);
	});

	it('greys, black and white alone give no suggestion', () => {
		expect(suggestTheme(['#000000', '#ffffff', '#777777', '#1a1a1a'])).toBeNull();
		expect(suggestTheme([])).toBeNull();
	});

	it('greys are skipped in favour of the first real colour', () => {
		const s = suggestTheme(['#111111', '#ffffff', '#1e88e5'])!;
		const dh = Math.abs(hue(s.from) - hue('#1e88e5'));
		expect(Math.min(dh, 360 - dh)).toBeLessThan(40);
	});
});

describe('logoColours', () => {
	it('reads fills, strokes, gradient stops and styles, most used first, as #rrggbb', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20">
			<style>.a{fill:#D4A017}.b{stroke: rgb(30, 136, 229)}</style>
			<defs><linearGradient id="g"><stop offset="0" stop-color="#f3dca0"/><stop offset="1" stop-color="#bb872f"/></linearGradient></defs>
			<path class="a" d="M0 0h10v10z"/><path fill="#d4a017" d="M0 0h10v10z"/>
			<path style="fill:#d4a017;stroke:#000" d="M0 0h10v10z"/>
			<rect fill="#fff" width="100" height="20"/><circle fill="none" stroke="url(#g)" r="3"/>
		</svg>`;
		const cs = logoColours(svg);
		expect(cs[0]).toBe('#d4a017');
		expect(cs).toEqual(
			expect.arrayContaining(['#1e88e5', '#f3dca0', '#bb872f', '#000000', '#ffffff'])
		);
		expect(new Set(cs).size).toBe(cs.length);
	});

	it('the most used colour comes first, wherever it first appears', () => {
		const svg =
			'<svg viewBox="0 0 9 9"><path fill="#e53935"/><path fill="#1e88e5"/><path fill="#1e88e5"/></svg>';
		expect(logoColours(svg)).toEqual(['#1e88e5', '#e53935']);
	});

	it('reads colour names, hsl(), and 4- and 8-digit hex; a transparent colour is none', () => {
		const svg = `<svg viewBox="0 0 9 9">
			<path fill="red"/><path stroke="Orange"/><path fill="hsl(210, 79%, 51%)"/>
			<path fill="#d4a017ff"/><path fill="#00f8"/><path fill="#12345600"/><path fill="rgba(1,2,3,0)"/>
			<path fill="none"/><path fill="url(#g)"/><path fill="currentColor"/></svg>`;
		expect(logoColours(svg)).toEqual(['#ff0000', '#ffa500', '#1f82e5', '#d4a017', '#0000ff']);
	});

	it('takes time in step with the file\u2019s size, never more (a hostile logo)', () => {
		// 2 MB of "fill:rgb(" with no ")" (9 minutes before), and of rgb()
		// argument lists full of spaces (cubic before).
		const a = `<svg viewBox="0 0 1 1"><desc>${'fill:rgb('.repeat(230_000)}</desc></svg>`;
		const b = `<svg viewBox="0 0 1 1"><desc>${`fill:rgb(${' '.repeat(50)}1${' '.repeat(10)})`.repeat(30_000)}</desc></svg>`;
		for (const svg of [a, b]) {
			const t0 = performance.now();
			logoColours(svg);
			expect(performance.now() - t0).toBeLessThan(3_000);
		}
	});

	it('hands on at most the 32 most used colours', () => {
		const paths = Array.from(
			{ length: 5000 },
			(_, i) => `<path fill="#${i.toString(16).padStart(6, '0')}"/>`
		);
		paths.push('<path fill="#d4a017"/>'.repeat(3));
		const cs = logoColours(`<svg viewBox="0 0 1 1">${paths.join('')}</svg>`);
		expect(cs).toHaveLength(32);
		expect(cs[0]).toBe('#d4a017');
	});

	it('a logo of one colour suggests a theme in that colour', () => {
		const svg = '<svg viewBox="0 0 10 10"><path fill="#e53935" d="M0 0h10v10z"/></svg>';
		const s = suggestTheme(logoColours(svg))!;
		const dh = Math.abs(hue(s.to) - hue('#e53935'));
		expect(Math.min(dh, 360 - dh)).toBeLessThan(40);
	});
});

describe('the colour question in branding setup', () => {
	const logo = '<svg viewBox="0 0 10 10"><path fill="#1e88e5" d="M0 0h10v10z"/></svg>';

	it('"logo" takes the colours from the logo', () => {
		const a = colourAnswer('logo', [logo]);
		expect('flags' in a && a.flags['theme-from']).toBeTruthy();
		const s = suggestTheme(['#1e88e5'])!;
		expect('flags' in a && a.flags).toMatchObject({
			'theme-from': s.from,
			'theme-to': s.to,
			'theme-background': s.background
		});
	});

	it('"logo" without a colourful logo says so', () => {
		expect(colourAnswer('logo', [])).toHaveProperty('error');
		expect(
			colourAnswer('logo', ['<svg viewBox="0 0 1 1"><path fill="#000"/></svg>'])
		).toHaveProperty('error');
	});

	it('one colour is the main colour; the rest is worked out', () => {
		const a = colourAnswer('#d4a017', []);
		const s = suggestTheme(['#d4a017'])!;
		expect('flags' in a && a.flags).toMatchObject({ 'theme-from': s.from, 'theme-to': s.to });
	});

	it('two or three colours replace the whole theme (no old middle stop or button style left over)', () => {
		expect(colourAnswer('#f3dca0 #bb872f', [])).toEqual({
			flags: { theme: '', 'theme-from': '#f3dca0', 'theme-to': '#bb872f' }
		});
		expect(colourAnswer('#f3dca0 #bb872f #181818', [])).toEqual({
			flags: {
				theme: '',
				'theme-from': '#f3dca0',
				'theme-to': '#bb872f',
				'theme-background': '#181818'
			}
		});
		expect(colourAnswer('champagne-gold', [])).toEqual({ flags: { theme: 'champagne-gold' } });
	});

	it('anything else is refused with what to type', () => {
		expect(colourAnswer('blue', [])).toHaveProperty('error');
		expect(colourAnswer('#12 #34 #56 #78', [])).toHaveProperty('error');
	});
});

describe('what branding setup tells you about the files', () => {
	it('names the three files, says SVG only, and gives the real size limit and display sizes', async () => {
		const { brandingFilesGuide } = await import('../src/commands/branding.ts');
		const { BRANDING_FILE_FLAGS, MAX_SVG_BYTES } = await import('../src/lib/branding.ts');
		const text = brandingFilesGuide().join('\n');
		for (const name of Object.values(BRANDING_FILE_FLAGS)) expect(text).toContain(name);
		expect(text).toMatch(/SVG/);
		expect(text).toContain(`${MAX_SVG_BYTES / 1024 / 1024} MB`);
		// The heights the site shows them at (apps/web: header 32, footer 40, hero 44–96).
		for (const px of ['32', '40', '96']) expect(text).toContain(px);
	});
});
