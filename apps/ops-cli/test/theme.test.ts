/**
 * Per-instance colour theme — the palette DERIVATION
 * (packages/operator-config/src/theme.ts, docs/BRANDING.md "Colours").
 *
 *  - The Morphit inputs must reproduce, EXACTLY, the colours v1.20.0 painted
 *    (frozen below from that release's tailwind.config.js, app.css and
 *    components — independent of THEME_TOKENS' own `ref` values). That is what
 *    keeps an unthemed instance pixel-identical.
 *  - Vigilante Trading's champagne-gold inputs produce a frozen palette, and
 *    every contrast rule holds.
 *  - For any input the derivation accepts, every contrast rule holds; for any
 *    it refuses, the suggestion it offers is itself accepted.
 */
import { describe, expect, it } from 'vitest';
import {
	blendOver,
	contrastRatio,
	deriveTheme,
	EDGE_ALPHA,
	normalizeHex,
	parseBrandJsonTheme,
	relativeLuminance as relLum,
	themeStyleElement,
	THEME_TOKENS,
	type ThemePalette
} from '../../../packages/operator-config/src/theme.ts';

/** Every brand/surface colour Morphit v1.20.0 painted, where it came from. */
const FROZEN_V1_19_1: Record<string, string> = {
	'brand-1': '#8eef26', // tailwind morphit.lime, app.css --morphit-lime, gradient stop 1
	'brand-2': '#00da69', // gradient stop 2, app.html theme-color, glow, PrioritiesSection
	'brand-3': '#02a6b2', // tailwind morphit.teal, gradient stop 3
	'brand-accent': '#7fed2d', // tailwind morphit.accent
	'brand-primary': '#00da69', // tailwind morphit.emerald (text/borders/rings)
	'brand-secondary': '#02a6b2', // tailwind morphit.teal (text/borders)
	'brand-soft': '#10b981', // FaqSearch highlight / FocusedField pulse rgba(16,185,129,…)
	'brand-bubble': '#009e51', // tailwind morphit.emerald-bubble
	'brand-btn-face': '#027c86', // tailwind morphit.btn, --morphit-btn-face
	'brand-btn-text': '#ffffff', // text-white on the button face
	// v1.21.8: the primary button's hover edge — brand-primary on Morphit's
	// deep buttons, the same colour it always was.
	'brand-btn-edge': '#00da69',
	'focus-ring': '#00da69', // --focus-ring rgba(0,218,105,.35)
	'card-accent-1': '#8eef26',
	'card-accent-2': '#00da69',
	'card-accent-3': '#02a6b2',
	'glow-tl': '#00da69', // body radial glow
	'glow-br': '#02a6b2',
	'surface-50': '#f7f8fa', // tailwind ink.50 … ink.950
	'surface-100': '#eef1f5',
	'surface-200': '#d9dfe7',
	'surface-300': '#b8c2d0',
	'surface-400': '#8a96a8',
	'surface-500': '#7b889b', // v1.20.2: lifted from #5d6b80 for 4.5:1 on cards (PageSpeed contrast)
	'surface-600': '#3e4a5c',
	'surface-700': '#2a3340',
	'surface-800': '#1a202b',
	'surface-900': '#0f141c',
	'surface-950': '#070a10',
	'surface-page': '#0a0e16', // body background-color, manifest background_color, icon canvas
	shadow: '#0b1220', // tailwind morphit.ink (card shadows)
	'slate-200': '#e2e8f0', // PrioritiesSection rgb(226 232 240)
	'slate-300': '#cbd5e1',
	'slate-400': '#94a3b8',
	'slate-500': '#64748b',
	'slate-600': '#475569',
	'slate-800': '#1e293b',
	'slate-900': '#0f172a',
	'slate-950': '#020617',
	'gray-100': '#f3f4f6', // OrderExpiryChip
	'gray-400': '#9ca3af',
	'gray-500': '#6b7280',
	'gray-800': '#1f2937',
	'gray-333': '#333333', // 2FA page fallbacks
	'gray-444': '#444444',
	'gray-666': '#666666', // pre-hydration "Loading…"
	'surface-alt-1': '#0e0e10',
	'surface-alt-2': '#18181a'
};

/** Vigilante Trading (champagne-gold) — frozen derivation output. */
const VIGILANTE: Record<string, string> = {
	'brand-1': '#f3dca0',
	'brand-2': '#d6b26a',
	'brand-3': '#bb872f',
	'brand-accent': '#edd99c',
	'brand-primary': '#d6b26a',
	'brand-secondary': '#c08c35',
	'brand-soft': '#ab9e6b',
	'brand-bubble': '#9a824e',
	'brand-btn-face': '#d6b26a',
	'brand-btn-text': '#181818',
	// v1.21.8: a light edge on the bright gold face (it was the face's own colour,
	// so the hover edge did not show).
	'brand-btn-edge': '#fff9e8',
	'focus-ring': '#d6b26a',
	'card-accent-1': '#f3dca0',
	'card-accent-2': '#d6b26a',
	'card-accent-3': '#bb872f',
	'glow-tl': '#d6b26a',
	'glow-br': '#bb872f',
	'surface-50': '#f8f8f8',
	'surface-100': '#f2f2f2',
	'surface-200': '#e1e1e1',
	'surface-300': '#c5c5c5',
	'surface-400': '#9d9d9d',
	'surface-500': '#8f8f8f', // v1.20.2: follows the lifted Morphit ink-500 (was #747474)
	'surface-600': '#555555',
	'surface-700': '#404040',
	'surface-800': '#2e2e2e',
	'surface-900': '#222222',
	'surface-950': '#181818',
	'surface-page': '#1c1c1c',
	shadow: '#202020',
	'slate-200': '#e9e9e9',
	'slate-300': '#d7d7d7',
	'slate-400': '#a8a8a8',
	'slate-500': '#7d7d7d',
	'slate-600': '#606060',
	'slate-800': '#363636',
	'slate-900': '#262626',
	'slate-950': '#151515',
	'gray-100': '#f5f5f5',
	'gray-400': '#a9a9a9',
	'gray-500': '#7c7c7c',
	'gray-800': '#363636',
	'gray-333': '#404040',
	'gray-444': '#505050',
	'gray-666': '#717171',
	'surface-alt-1': '#1c1c1c',
	'surface-alt-2': '#262626'
};

function ok(input: Parameters<typeof deriveTheme>[0]): ThemePalette {
	const r = deriveTheme(input);
	if (!r.ok) throw new Error(r.problems.join('; '));
	return r.palette;
}

/** Every contrast rule a derived palette must satisfy (independent of the
 *  derivation's own bookkeeping). */
function assertReadable(p: ThemePalette, label: string): void {
	const t = p.tokens;
	const c = (a: string, b: string): number => contrastRatio(t[a]!, t[b]!);
	const at = (a: string, b: string, min: number): void => {
		expect(c(a, b) + 1e-9, `${label}: ${a} ${t[a]} on ${b} ${t[b]}`).toBeGreaterThanOrEqual(min);
	};
	at('surface-100', 'surface-950', 7);
	at('surface-200', 'surface-950', 7);
	at('surface-400', 'surface-900', 4.5);
	at('slate-300', 'slate-900', 4.5);
	at('surface-100', 'surface-800', 4.5);
	for (const s of ['surface-950', 'surface-900', 'slate-900', 'surface-800']) {
		at('brand-primary', s, 4.5);
		at('brand-secondary', s, 4.5);
	}
	at('brand-btn-text', 'brand-btn-face', 4.5);
	at('surface-950', 'brand-bubble', 4.5);
	for (const i of [1, 2, 3]) {
		at(`card-accent-${i}`, 'slate-900', 3);
		at(`card-accent-${i}`, 'surface-900', 3);
		at(`brand-${i}`, 'surface-950', 3);
	}
	expect(['#ffffff', t['surface-950']]).toContain(t['brand-btn-text']);
	for (const def of THEME_TOKENS) expect(normalizeHex(t[def.name]), def.name).toBe(t[def.name]);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let x = Math.imul(a ^ (a >>> 15), 1 | a);
		x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}
const hex = (r: () => number, max = 255): string =>
	'#' +
	[0, 1, 2]
		.map(() =>
			Math.floor(r() * (max + 1))
				.toString(16)
				.padStart(2, '0')
		)
		.join('');

describe('theme derivation', () => {
	it('the Morphit inputs reproduce every v1.20.0 colour exactly (unthemed = pixel-identical)', () => {
		expect(Object.keys(FROZEN_V1_19_1).sort()).toEqual(THEME_TOKENS.map((t) => t.name).sort());
		for (const input of [
			{ preset: 'morphit' },
			{ from: '#8EEF26', mid: '#00DA69', to: '#02A6B2' },
			{ from: '#8eef26', mid: '#00da69', to: '#02a6b2', background: '#070a10' }
		]) {
			const p = ok(input);
			expect(p.tokens).toEqual(FROZEN_V1_19_1);
			expect(p.isDefault).toBe(true);
			expect(p.gridOpacity).toBe(0.035);
			expect(p.adjusted).toEqual([]);
		}
		// …and the table's reference values are those same colours.
		for (const t of THEME_TOKENS) expect(t.ref, t.name).toBe(FROZEN_V1_19_1[t.name]);
	});

	it('Vigilante Trading (champagne-gold #f3dca0 → #bb872f on #181818): the frozen palette, readable', () => {
		const p = ok({ preset: 'champagne-gold' });
		expect(p.tokens).toEqual(VIGILANTE);
		expect(p.isDefault).toBe(false);
		expect(p.gridOpacity).toBe(0.05);
		expect(p.inputs).toEqual({
			from: '#f3dca0',
			mid: '#d6b26a',
			to: '#bb872f',
			background: '#181818',
			preset: 'champagne-gold',
			button: 'bright'
		});
		// A neutral near-black background yields pure greys (no navy left).
		for (const t of THEME_TOKENS) {
			if (t.rule.kind !== 'neutral') continue;
			const v = p.tokens[t.name]!;
			expect(
				v.slice(1, 3) === v.slice(3, 5) && v.slice(3, 5) === v.slice(5, 7),
				`${t.name} ${v}`
			).toBe(true);
		}
		expect(p.tokens['surface-950']).toBe('#181818');
		assertReadable(p, 'champagne-gold');
		// The same colours given by hand (no preset) derive the same palette.
		expect(
			ok({ from: '#f3dca0', to: '#bb872f', background: '#181818', button: 'bright' }).tokens
		).toEqual(VIGILANTE);
	});

	it('button styles: deep (Morphit\u2019s rule) vs bright (middle stop, dark text); champagne-gold is bright', () => {
		const deep = ok({ preset: 'champagne-gold', button: 'deep' });
		expect([deep.tokens['brand-btn-face'], deep.tokens['brand-btn-text']]).toEqual([
			'#8c6520',
			'#ffffff'
		]);
		assertReadable(deep, 'champagne-gold deep');
		const bright = ok({ preset: 'champagne-gold' });
		expect(bright.inputs.button).toBe('bright');
		expect(bright.tokens['brand-btn-face']).toBe(bright.tokens['brand-2']);
		expect(bright.tokens['brand-btn-text']).toBe(bright.tokens['surface-950']);
		// Only the button changes between the two.
		const diff = Object.keys(bright.tokens).filter((k) => bright.tokens[k] !== deep.tokens[k]);
		expect(diff.sort()).toEqual(['brand-btn-edge', 'brand-btn-face', 'brand-btn-text']);
		// Morphit stays deep (exact v1.20.0 colours); bright on Morphit is a real theme.
		expect(ok({ preset: 'morphit' }).inputs.button).toBe('deep');
		const mb = ok({ preset: 'morphit', button: 'bright' });
		expect(mb.isDefault).toBe(false);
		expect([mb.tokens['brand-btn-face'], mb.tokens['brand-btn-text']]).toEqual([
			'#00da69',
			'#070a10'
		]);
		// A dark middle stop is lifted until the dark text reads.
		const dim = ok({ from: '#c9a24c', mid: '#806430', to: '#c9a24c', button: 'bright' });
		expect(
			contrastRatio(dim.tokens['brand-btn-face']!, dim.tokens['surface-950']!)
		).toBeGreaterThanOrEqual(4.5);
		expect(dim.adjusted).toContain('brand-btn-face');
		const bad = deriveTheme({ preset: 'morphit', button: 'neon' });
		expect(bad.ok ? '' : bad.problems.join()).toMatch(/deep or bright/);
	});

	it('the primary button\u2019s hover edge always stands out from its face (deep and bright, any colours)', () => {
		// The 1px edge a primary button lights on hover was drawn in brand-primary,
		// which IS the face of a bright button: on Vigilante Trading's gold
		// buttons it was invisible (2026-10-13).
		// As painted: app.css draws the edge at EDGE_ALPHA over the face.
		const edgeOf = (p: { tokens: Record<string, string> }): number =>
			contrastRatio(
				blendOver(p.tokens['brand-btn-edge']!, p.tokens['brand-btn-face']!, EDGE_ALPHA),
				p.tokens['brand-btn-face']!
			);
		const whiteOn = (face: string): number =>
			contrastRatio(blendOver('#ffffff', face, EDGE_ALPHA), face);
		// The presets' deep buttons keep the edge they always had: brand-primary.
		for (const input of [{ preset: 'morphit' }, { preset: 'champagne-gold', button: 'deep' }]) {
			const p = ok(input);
			expect(p.tokens['brand-btn-edge']).toBe(p.tokens['brand-primary']);
			expect(edgeOf(p)).toBeGreaterThanOrEqual(1.8);
		}
		const gold = ok({ preset: 'champagne-gold' });
		expect(edgeOf(gold)).toBeGreaterThanOrEqual(1.8);
		// …and lighter than the face: a BRIGHT flash.
		expect(relLum(gold.tokens['brand-btn-edge']!)).toBeGreaterThan(
			relLum(gold.tokens['brand-btn-face']!)
		);
		// Any theme, deep or bright: at least 1.8:1 from the face, lighter than
		// it — or, on a face so pale that not even white is 1.8:1 from it, a
		// darker shade. Deep faces can sit right on brand-primary with some
		// colours (#338ec0 face, #3e91a8 primary: 1.01:1).
		const r = rng(7);
		let n = 0;
		for (let i = 0; i < 800 && n < 240; i++) {
			const button = i % 2 ? 'bright' : 'deep';
			const res = deriveTheme({ from: hex(r), mid: hex(r), to: hex(r), button });
			if (!res.ok) continue;
			n++;
			const p = res.palette;
			const face = p.tokens['brand-btn-face']!;
			const whiteReaches = whiteOn(face) >= 1.8;
			const what = `${button}: ${face} → ${p.tokens['brand-btn-edge']}`;
			expect(edgeOf(p), what).toBeGreaterThanOrEqual(1.8 - 1e-9);
			if (whiteReaches)
				expect(relLum(p.tokens['brand-btn-edge']!), what).toBeGreaterThan(relLum(face));
		}
		expect(n).toBeGreaterThan(100);
		// White and near-white bright buttons (the random colours above rarely
		// make one): not even white stands out from them, so the edge is a
		// darker shade of the face — never the face itself.
		let pale = 0;
		for (const mid of ['#ffffff', '#fdfdfd', '#e8e0c8', '#d0d0d0', '#f6f0ff']) {
			const res = deriveTheme({ from: '#f3dca0', mid, to: '#bb872f', button: 'bright' });
			if (!res.ok) continue;
			pale++;
			const p = res.palette;
			const face = p.tokens['brand-btn-face']!;
			const what = `bright ${mid}: ${face} → ${p.tokens['brand-btn-edge']}`;
			expect(edgeOf(p), what).toBeGreaterThanOrEqual(1.8 - 1e-9);
			if (whiteOn(face) < 1.8)
				expect(relLum(p.tokens['brand-btn-edge']!), what).toBeLessThan(relLum(face));
		}
		expect(pale).toBeGreaterThanOrEqual(3);
	});

	it('prototype keys are not presets (T2)', () => {
		for (const p of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
			const d = deriveTheme({ preset: p });
			expect(d.ok, p).toBe(false);
			expect(d.ok ? '' : d.problems.join(), p).toMatch(/unknown theme/);
		}
	});

	it('is deterministic', () => {
		expect(ok({ from: '#3a7bd5', to: '#fedcba' })).toEqual(ok({ from: '#3a7bd5', to: '#fedcba' }));
	});

	it('property: accepted inputs are always readable; refused inputs come with a suggestion that works', () => {
		const r = rng(20260927);
		let accepted = 0;
		let refused = 0;
		for (let i = 0; i < 300; i++) {
			const input = {
				from: hex(r),
				to: hex(r),
				mid: r() < 0.3 ? hex(r) : null,
				background: r() < 0.7 ? hex(r, 90) : null,
				button: r() < 0.5 ? 'bright' : 'deep'
			};
			const d = deriveTheme(input);
			if (d.ok) {
				accepted++;
				assertReadable(d.palette, JSON.stringify(input));
				continue;
			}
			refused++;
			for (const problem of d.problems) {
				const m =
					/(--theme-[a-z]+|the middle stop)[^#]*#[0-9a-f]{6}.*?(?:try|such as) (#[0-9a-f]{6})/.exec(
						problem
					);
				expect(m, problem).not.toBeNull();
				const flag = m![1]!;
				const field = flag.includes('from')
					? 'from'
					: flag.includes('background')
						? 'background'
						: flag.includes('to')
							? 'to'
							: 'mid';
				const fixed = { ...input, [field]: m![2] };
				const again = deriveTheme(fixed);
				// The suggested value clears THAT problem (another input may still fail).
				if (!again.ok)
					expect(again.problems.join(' '), problem).not.toContain(
						`${flag} ${input[field as keyof typeof input]}`
					);
			}
		}
		expect(accepted).toBeGreaterThan(100);
		expect(refused).toBeGreaterThan(10);
	});

	it('refuses bad input with a clear message', () => {
		const bad = (i: Parameters<typeof deriveTheme>[0]): string => {
			const d = deriveTheme(i);
			expect(d.ok).toBe(false);
			return d.ok ? '' : d.problems.join('; ');
		};
		expect(bad({ from: 'gold', to: '#bb872f' })).toMatch(/--theme-from "gold" is not a hex colour/);
		expect(bad({ from: '#f3dca0', to: 'rgb(1,2,3)' })).toMatch(/--theme-to .* not a hex colour/);
		expect(bad({ from: '#f3dca0' })).toMatch(/needs at least --theme-from and --theme-to/);
		expect(bad({ preset: 'neon' })).toMatch(/unknown theme "neon"/);
		expect(bad({ from: '#f3dca0', to: '#bb872f', background: '#ffffff' })).toMatch(
			/--theme-background #ffffff is too light .* try a darker background such as #[0-9a-f]{6}/
		);
		expect(bad({ from: '#101010', to: '#bb872f', background: '#181818' })).toMatch(
			/--theme-from #101010 is too dark to read .* try #[0-9a-f]{6}/
		);
	});

	it('the emitted <style> carries only "R G B" triplets and a number', () => {
		const style = themeStyleElement(ok({ preset: 'champagne-gold' }));
		expect(style).toMatch(
			/^<style id="morphit-theme">html:root\{(--[a-z0-9-]+-rgb:\d{1,3} \d{1,3} \d{1,3};)+--grid-opacity:0\.05\}<\/style>$/
		);
		expect(() =>
			themeStyleElement({
				tokens: { ...VIGILANTE, 'brand-1': 'red;}</style><script>' },
				gridOpacity: 0.05
			})
		).toThrow();
	});

	it('parseBrandJsonTheme keeps only known tokens with #rrggbb values', () => {
		const t = parseBrandJsonTheme({
			tokens: { 'brand-1': '#F3DCA0', 'brand-2': 'url(x)', evil: '#000000' },
			grid_opacity: 9
		});
		expect(t).toEqual({ tokens: { 'brand-1': '#f3dca0' }, gridOpacity: 0.2, themeColor: null });
		expect(parseBrandJsonTheme({ tokens: {} })).toBeNull();
		expect(parseBrandJsonTheme('x')).toBeNull();
	});
});
