/**
 * Per-instance COLOUR THEME — pure, browser-safe palette derivation (zero deps).
 *
 * WHY. Every federated operator serves the same canonical frontend (the on-chain
 * build-integrity check depends on it), so an operator can never recompile the
 * CSS with their own colours. Instead every brand / surface colour the frontend
 * paints is a CSS custom property (apps/web/src/theme.css — the ONE file that
 * holds colour values), and `morphit-ops branding apply --theme-from … --theme-to …`
 * overrides those properties at runtime: a <style> slot in every prerendered
 * page (first paint, no-JS visitors, Tor Browser without a service worker) and
 * /brand/brand.json for the SPA shell. See docs/BRANDING.md ("Colours").
 *
 * WHAT. From 2–3 input colours — the gradient's first and last stop, an optional
 * middle stop, and an optional page background — derive EVERY token
 * deterministically:
 *
 *   - Brand tokens keep the SAME OKLCH relationship to their gradient stop that
 *     Morphit's hand-tuned palette has (the button face is Morphit's teal
 *     deepened by ΔL; the chat bubble is the emerald deepened; …): each token's
 *     offset from its anchor stop in the reference palette is transplanted onto
 *     the new stop. Then contrast rules are enforced (text colours ≥ 4.5:1 on
 *     every surface they sit on, the button text is white or dark — whichever
 *     passes WCAG AA —, icons ≥ 3:1).
 *   - Neutral tokens (the "ink" surface/text scale and the few extra greys) are
 *     re-tinted from the background: every step keeps its lightness (shifted by
 *     how much lighter/darker the new background is, fading to zero at white),
 *     and its chroma/hue follow the background's (a neutral near-black
 *     background → pure greys; Morphit's navy → the navy scale).
 *
 * By construction the Morphit inputs reproduce the reference palette EXACTLY —
 * which is what keeps an unthemed instance pixel-identical (guarded by
 * apps/ops-cli/test/theme.test.ts and scripts/theme-tokens-smoke.ts).
 */

/** '#rrggbb', lower case. */
export type Hex = string;

export interface ThemePreset {
	readonly label: string;
	readonly from: Hex;
	readonly mid: Hex | null;
	readonly to: Hex;
	readonly background: Hex;
	/** Opacity of the homepage hero grid lines (they are drawn in the body text colour). */
	readonly grid: number;
	/** Primary-button style (see ThemeButtonStyle). */
	readonly button: ThemeButtonStyle;
}

/**
 * Primary-button style:
 *  - 'deep'   — Morphit's rule: the last gradient stop, DEEPENED by the same
 *               ΔL Morphit's button teal has (#02a6b2 → #027c86), white or dark
 *               text, whichever passes 4.5:1;
 *  - 'bright' — the gradient's middle stop itself as the face with the dark
 *               surface colour as text (lifted until that text reaches 4.5:1).
 */
export type ThemeButtonStyle = 'deep' | 'bright';
export const THEME_BUTTON_STYLES: readonly ThemeButtonStyle[] = ['deep', 'bright'];

/** The preset of that name — own keys only, so "__proto__" / "constructor"
 *  are never mistaken for a preset. */
export function themePreset(name: string | null | undefined): ThemePreset | null {
	if (typeof name !== 'string') return null;
	return Object.hasOwn(THEME_PRESETS, name) ? THEME_PRESETS[name]! : null;
}

/** Named presets for `--theme <name>`. `morphit` is the canonical look. */
export const THEME_PRESETS: Readonly<Record<string, ThemePreset>> = {
	morphit: {
		label: 'Morphit (default: lime → emerald → teal on navy)',
		from: '#8eef26',
		mid: '#00da69',
		to: '#02a6b2',
		background: '#070a10',
		grid: 0.035,
		button: 'deep'
	},
	'champagne-gold': {
		label: 'Champagne to Gold (#f3dca0 → #bb872f on near-black, gold buttons)',
		from: '#f3dca0',
		mid: null,
		to: '#bb872f',
		background: '#181818',
		grid: 0.05,
		// The gold middle stop with dark text reads as "gold" next to the
		// champagne→gold heading; the deepened last stop (#8c6520) looked
		// brownish (review of the v1.20.0 preview; see
		// scratchpad shots vigilante-button-deep/-bright).
		button: 'bright'
	}
};

export const DEFAULT_THEME_PRESET = 'morphit';
const REF = THEME_PRESETS[DEFAULT_THEME_PRESET]!;

/** How a token is derived. */
type TokenRule =
	| { kind: 'stop'; stop: 1 | 2 | 3 }
	| { kind: 'offset'; stop: 1 | 2 | 3 }
	| { kind: 'neutral' }
	| { kind: 'text'; stop: 1 | 2 | 3 }
	| { kind: 'icon'; stop: 1 | 2 | 3 }
	| { kind: 'bubble'; stop: 1 | 2 | 3 }
	| { kind: 'btn-face'; stop: 1 | 2 | 3 }
	| { kind: 'btn-text' }
	| { kind: 'alias'; of: string };

export interface ThemeTokenDef {
	/** CSS custom property is `--<name>-rgb` ("r g b"). */
	readonly name: string;
	/** The Morphit (reference) value — what the default theme must equal. */
	readonly ref: Hex;
	readonly rule: TokenRule;
	/** Where it is used (for `branding status`, the palette table, reviewers). */
	readonly use: string;
}

const stop = (s: 1 | 2 | 3): TokenRule => ({ kind: 'stop', stop: s });
const off = (s: 1 | 2 | 3): TokenRule => ({ kind: 'offset', stop: s });
const N: TokenRule = { kind: 'neutral' };

/**
 * THE token table. Order is the order of the emitted CSS. Every colour the
 * frontend paints for the brand or a surface is one of these (the literal
 * scanner, scripts/theme-literal-scan-smoke.ts, keeps it that way).
 */
export const THEME_TOKENS: readonly ThemeTokenDef[] = [
	// ── Brand ────────────────────────────────────────────────────────────
	{
		name: 'brand-1',
		ref: '#8eef26',
		rule: stop(1),
		use: 'gradient first stop (hero heading, logo-style gradients, priority-#1 bar)'
	},
	{
		name: 'brand-2',
		ref: '#00da69',
		rule: stop(2),
		use: 'gradient middle stop; browser theme-color + manifest theme_color'
	},
	{ name: 'brand-3', ref: '#02a6b2', rule: stop(3), use: 'gradient last stop' },
	{ name: 'brand-accent', ref: '#7fed2d', rule: off(1), use: '--morphit-accent (legacy alias)' },
	{
		name: 'brand-primary',
		ref: '#00da69',
		rule: { kind: 'text', stop: 2 },
		use: 'primary accent: links, accent text, borders, rings, badges (Tailwind morphit-emerald); ≥ 4.5:1 on every dark surface'
	},
	{
		name: 'brand-secondary',
		ref: '#02a6b2',
		rule: { kind: 'text', stop: 3 },
		use: 'secondary accent text/borders (Tailwind morphit-teal); ≥ 4.5:1 on every dark surface'
	},
	{
		name: 'brand-soft',
		ref: '#10b981',
		rule: off(2),
		use: 'soft attention tint: FAQ search highlight, focused-field pulse'
	},
	{
		name: 'brand-bubble',
		ref: '#009e51',
		rule: { kind: 'bubble', stop: 2 },
		use: 'outgoing chat bubble face (dark text on it ≥ 4.5:1)'
	},
	{
		name: 'brand-btn-face',
		ref: '#027c86',
		rule: { kind: 'btn-face', stop: 3 },
		use: 'primary button face (.btn-primary, Tailwind morphit-btn)'
	},
	{
		name: 'brand-btn-text',
		ref: '#ffffff',
		rule: { kind: 'btn-text' },
		use: 'text on the primary button (white or dark, whichever passes WCAG AA)'
	},
	{
		name: 'focus-ring',
		ref: '#00da69',
		rule: { kind: 'alias', of: 'brand-primary' },
		use: 'keyboard focus ring (35% alpha glow / solid field ring)'
	},
	{
		name: 'card-accent-1',
		ref: '#8eef26',
		rule: { kind: 'icon', stop: 1 },
		use: 'homepage priority cards 1, 4, 7 icon colour (≥ 3:1 on the card)'
	},
	{
		name: 'card-accent-2',
		ref: '#00da69',
		rule: { kind: 'icon', stop: 2 },
		use: 'homepage priority cards 2, 5 icon colour'
	},
	{
		name: 'card-accent-3',
		ref: '#02a6b2',
		rule: { kind: 'icon', stop: 3 },
		use: 'homepage priority cards 3, 6 icon colour'
	},
	{
		name: 'glow-tl',
		ref: '#00da69',
		rule: { kind: 'alias', of: 'brand-2' },
		use: 'page background top-left glow (6% alpha)'
	},
	{
		name: 'glow-br',
		ref: '#02a6b2',
		rule: { kind: 'alias', of: 'brand-3' },
		use: 'page background bottom-right glow (5.5% alpha)'
	},
	// ── Neutral surface / text scale (Tailwind `ink-*`) ────────────────────
	{ name: 'surface-50', ref: '#f7f8fa', rule: N, use: 'ink-50' },
	{ name: 'surface-100', ref: '#eef1f5', rule: N, use: 'ink-100: body text, autofill text' },
	{ name: 'surface-200', ref: '#d9dfe7', rule: N, use: 'ink-200: hero body text, secondary text' },
	{ name: 'surface-300', ref: '#b8c2d0', rule: N, use: 'ink-300' },
	{ name: 'surface-400', ref: '#8a96a8', rule: N, use: 'ink-400: muted text' },
	{ name: 'surface-500', ref: '#5d6b80', rule: N, use: 'ink-500' },
	{ name: 'surface-600', ref: '#3e4a5c', rule: N, use: 'ink-600: field hover borders' },
	{ name: 'surface-700', ref: '#2a3340', rule: N, use: 'ink-700: borders' },
	{
		name: 'surface-800',
		ref: '#1a202b',
		rule: N,
		use: 'ink-800: raised surfaces, secondary buttons, incoming chat bubble'
	},
	{ name: 'surface-900', ref: '#0f141c', rule: N, use: 'ink-900: cards, inputs, autofill face' },
	{
		name: 'surface-950',
		ref: '#070a10',
		rule: N,
		use: 'ink-950: page background (the --theme-background input), dark text on accents'
	},
	{
		name: 'surface-page',
		ref: '#0a0e16',
		rule: N,
		use: 'body background fallback, manifest background_color, app-icon / launch-screen canvas'
	},
	{ name: 'shadow', ref: '#0b1220', rule: N, use: 'card shadows (Tailwind morphit-ink)' },
	// ── Extra neutrals some components use (slate / gray families) ─────────
	{ name: 'slate-200', ref: '#e2e8f0', rule: N, use: 'priority card border (light scheme)' },
	{ name: 'slate-300', ref: '#cbd5e1', rule: N, use: 'priority card body text' },
	{
		name: 'slate-400',
		ref: '#94a3b8',
		rule: N,
		use: 'priority card CTA text / hover border (light), textarea hint'
	},
	{
		name: 'slate-500',
		ref: '#64748b',
		rule: N,
		use: 'priority card CTA (light), coin carousel label, textarea hint (light)'
	},
	{ name: 'slate-600', ref: '#475569', rule: N, use: 'priority card hover border' },
	{ name: 'slate-800', ref: '#1e293b', rule: N, use: 'priority card border' },
	{ name: 'slate-900', ref: '#0f172a', rule: N, use: 'priority card face' },
	{ name: 'slate-950', ref: '#020617', rule: N, use: 'priority card shadow (light scheme)' },
	{ name: 'gray-100', ref: '#f3f4f6', rule: N, use: 'expired-order chip (light scheme)' },
	{ name: 'gray-400', ref: '#9ca3af', rule: N, use: 'expired-order chip text' },
	{ name: 'gray-500', ref: '#6b7280', rule: N, use: 'expired-order chip text (light scheme)' },
	{ name: 'gray-800', ref: '#1f2937', rule: N, use: 'expired-order chip face' },
	{ name: 'gray-333', ref: '#333333', rule: N, use: '2FA page app-card border' },
	{ name: 'gray-444', ref: '#444444', rule: N, use: '2FA page field/button border' },
	{ name: 'gray-666', ref: '#666666', rule: N, use: 'pre-hydration "Loading…" text' },
	{ name: 'surface-alt-1', ref: '#0e0e10', rule: N, use: '2FA page code field' },
	{ name: 'surface-alt-2', ref: '#18181a', rule: N, use: '2FA page buttons' }
];

export const THEME_TOKEN_NAMES: readonly string[] = THEME_TOKENS.map((t) => t.name);

// ─── Colour math (sRGB ↔ OKLab ↔ OKLCH, WCAG contrast) ───────────────────

type RGB = [number, number, number]; // 0..1 gamma-encoded
interface LCH {
	L: number;
	C: number;
	h: number; // radians
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** '#abc' / '#AABBCC' → '#aabbcc', or null when not a hex colour. */
export function normalizeHex(v: string | null | undefined): Hex | null {
	if (typeof v !== 'string') return null;
	const s = v.trim();
	if (!HEX_RE.test(s)) return null;
	const h = s.toLowerCase();
	return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
}

function hexToRgb(hex: Hex): RGB {
	const n = parseInt(hex.slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** "r g b" (0–255) — the form the CSS custom properties hold. */
export function hexToRgbTriplet(hex: Hex): string {
	const n = parseInt(hex.slice(1), 16);
	return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function rgbToHex(rgb: RGB): Hex {
	return (
		'#' +
		rgb
			.map((c) =>
				Math.round(Math.min(1, Math.max(0, c)) * 255)
					.toString(16)
					.padStart(2, '0')
			)
			.join('')
	);
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number): number =>
	c <= 0.0031308 ? 12.92 * c : 1.055 * Math.sign(c) * Math.abs(c) ** (1 / 2.4) - 0.055;

function rgbToOklab([r, g, b]: RGB): [number, number, number] {
	const lr = toLinear(r);
	const lg = toLinear(g);
	const lb = toLinear(b);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
	];
}

function oklabToLinear([L, a, b]: [number, number, number]): RGB {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	];
}

function hexToLch(hex: Hex): LCH {
	const [L, a, b] = rgbToOklab(hexToRgb(hex));
	return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}

const EPS = 1e-7;
function inGamut(lin: RGB): boolean {
	return lin.every((c) => c >= -EPS && c <= 1 + EPS);
}

/** OKLCH → hex; out-of-gamut colours keep L and h and lose chroma. */
function lchToHex({ L, C, h }: LCH): Hex {
	const Lc = Math.min(1, Math.max(0, L));
	const lin = (c: number): RGB => oklabToLinear([Lc, c * Math.cos(h), c * Math.sin(h)]);
	let c = Math.max(0, C);
	let out = lin(c);
	if (!inGamut(out)) {
		let lo = 0;
		let hi = c;
		for (let i = 0; i < 40; i++) {
			const mid = (lo + hi) / 2;
			if (inGamut(lin(mid))) lo = mid;
			else hi = mid;
		}
		c = lo;
		out = lin(c);
	}
	return rgbToHex(out.map((v) => toGamma(Math.min(1, Math.max(0, v)))) as RGB);
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(hex: Hex): number {
	const [r, g, b] = hexToRgb(hex).map(toLinear) as RGB;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio (1–21). */
export function contrastRatio(a: Hex, b: Hex): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ─── Derivation ─────────────────────────────────────────────────────────

export interface ThemeInput {
	/** A preset name; the explicit colours below override its values. */
	readonly preset?: string | null;
	readonly from?: string | null;
	readonly mid?: string | null;
	readonly to?: string | null;
	readonly background?: string | null;
	/** 'deep' | 'bright' (default: the preset's, else 'deep'). */
	readonly button?: string | null;
}

export interface ContrastCheck {
	readonly what: string;
	readonly fg: string;
	readonly bg: string;
	readonly ratio: number;
	readonly min: number;
}

export interface ThemePalette {
	/** token name → '#rrggbb' for every THEME_TOKENS entry. */
	readonly tokens: Readonly<Record<string, Hex>>;
	readonly gridOpacity: number;
	/** The resolved inputs (mid filled in when derived). */
	readonly inputs: {
		from: Hex;
		mid: Hex;
		to: Hex;
		background: Hex;
		preset: string | null;
		button: ThemeButtonStyle;
	};
	/** True when this is exactly the canonical Morphit look. */
	readonly isDefault: boolean;
	readonly checks: readonly ContrastCheck[];
	/** Tokens a contrast rule had to move away from the transplanted value. */
	readonly adjusted: readonly string[];
}

export type ThemeResult =
	| { readonly ok: true; readonly palette: ThemePalette }
	| { readonly ok: false; readonly problems: readonly string[] };

/** Midpoint of two colours in OKLCH (shorter hue arc; greys take the other's hue). */
function oklchMid(a: Hex, b: Hex): Hex {
	const A = hexToLch(a);
	const B = hexToLch(b);
	let ha = A.h;
	let hb = B.h;
	if (A.C < 1e-4) ha = hb;
	if (B.C < 1e-4) hb = ha;
	let dh = hb - ha;
	if (dh > Math.PI) dh -= 2 * Math.PI;
	if (dh < -Math.PI) dh += 2 * Math.PI;
	return lchToHex({ L: (A.L + B.L) / 2, C: (A.C + B.C) / 2, h: ha + dh / 2 });
}

/** Raise (dir 1) or lower (dir -1) OKLCH lightness in small steps until
 *  `ok(hex)`; null if it never passes. */
function walkLightness(start: LCH, dir: 1 | -1, ok: (hex: Hex) => boolean): Hex | null {
	for (let i = 0; i <= 400; i++) {
		const L = start.L + dir * i * 0.0025;
		if (L < 0 || L > 1) break;
		const hex = lchToHex({ ...start, L });
		if (ok(hex)) return hex;
	}
	return null;
}

/** The neutral tokens for a page background: the reference scale keeps each
 *  step's lightness (shifted by the background's lightness change, fading to
 *  zero at white) and takes the background's chroma (scaled, capped ×1.5) and
 *  hue. The Morphit background reproduces the reference scale exactly. */
function neutralTokens(bg: Hex): Record<string, Hex> {
	const refBg = hexToLch(REF.background);
	const newBg = hexToLch(bg);
	const dL = newBg.L - refBg.L;
	const k = Math.min(1.5, refBg.C > 0 ? newBg.C / refBg.C : 0);
	const dh = newBg.C > 1e-6 ? newBg.h - refBg.h : 0;
	const out: Record<string, Hex> = {};
	for (const t of THEME_TOKENS) {
		if (t.rule.kind !== 'neutral') continue;
		const c = hexToLch(t.ref);
		const w = (1 - c.L) / (1 - refBg.L);
		out[t.name] = lchToHex({ L: c.L + dL * Math.max(0, w), C: c.C * k, h: c.h + dh });
	}
	return out;
}

/** Text on the neutral scale must stay readable. Returns the first failing
 *  check (null when all pass); every check is appended to `into`. */
function neutralChecks(tokens: Record<string, Hex>, into: ContrastCheck[]): ContrastCheck | null {
	const pairs: Array<[string, string, string, number]> = [
		['body text on the page', 'surface-100', 'surface-950', 7],
		['secondary text on the page', 'surface-200', 'surface-950', 7],
		['muted text on a card', 'surface-400', 'surface-900', 4.5],
		['priority-card text on its card', 'slate-300', 'slate-900', 4.5],
		['incoming chat bubble text', 'surface-100', 'surface-800', 4.5]
	];
	let firstFail: ContrastCheck | null = null;
	for (const [what, fg, bg, min] of pairs) {
		const c = { what, fg, bg, ratio: contrastRatio(tokens[fg]!, tokens[bg]!), min };
		into.push(c);
		if (firstFail === null && c.ratio + 1e-9 < min) firstFail = c;
	}
	return firstFail;
}

const fmt = (n: number): string => (Math.floor(n * 100) / 100).toFixed(2);

/**
 * Resolve the inputs (preset + overrides) and derive the whole palette, or
 * explain why it can't be used (with a concrete suggestion).
 */
export function deriveTheme(input: ThemeInput = {}): ThemeResult {
	const problems: string[] = [];
	const presetName = input.preset ?? null;
	const preset = themePreset(presetName);
	if (presetName !== null && preset === null) {
		return {
			ok: false,
			problems: [
				`unknown theme "${presetName}" — use one of: ${Object.keys(THEME_PRESETS).join(', ')}, or give your own colours with --theme-from/--theme-to`
			]
		};
	}
	const pick = (label: string, v: string | null | undefined, fallback: Hex | null): Hex | null => {
		if (v === undefined || v === null || v.trim() === '') return fallback;
		const h = normalizeHex(v);
		if (h === null) problems.push(`${label} "${v}" is not a hex colour — write it like #f3dca0`);
		return h;
	};
	const base = preset ?? null;
	const from = pick('--theme-from', input.from, base?.from ?? null);
	const to = pick('--theme-to', input.to, base?.to ?? null);
	const midIn = pick('--theme-mid', input.mid, base?.mid ?? null);
	const background = pick(
		'--theme-background',
		input.background,
		base?.background ?? REF.background
	);
	if (problems.length > 0) return { ok: false, problems };
	if (from === null || to === null) {
		return {
			ok: false,
			problems: [
				'a colour theme needs at least --theme-from and --theme-to (or a preset: --theme champagne-gold)'
			]
		};
	}
	const buttonIn =
		input.button === undefined || input.button === null ? '' : input.button.trim().toLowerCase();
	if (buttonIn !== '' && !(THEME_BUTTON_STYLES as readonly string[]).includes(buttonIn)) {
		return {
			ok: false,
			problems: [`--theme-button "${input.button}" is not a button style — use deep or bright`]
		};
	}
	const button: ThemeButtonStyle =
		buttonIn !== '' ? (buttonIn as ThemeButtonStyle) : (preset?.button ?? REF.button);
	const mid = midIn ?? oklchMid(from, to);
	const bg = background!;
	const grid = preset?.grid ?? REF.grid;

	// ── Neutrals: re-tint the reference scale from the background. ──
	const tokens: Record<string, Hex> = neutralTokens(bg);
	const checks: ContrastCheck[] = [];
	const failed = neutralChecks(tokens, checks);
	if (failed !== null) {
		const darker = walkLightness(
			hexToLch(bg),
			-1,
			(h) => neutralChecks(neutralTokens(h), []) === null
		);
		problems.push(
			`--theme-background ${bg} is too light for readable text (${failed.what}: ${fmt(failed.ratio)}:1, needs ${failed.min}:1)` +
				(darker
					? ` — try a darker background such as ${darker}`
					: ' — use a dark background, e.g. #121212')
		);
		return { ok: false, problems };
	}

	// ── Brand. ──
	const stops: Record<1 | 2 | 3, Hex> = { 1: from, 2: mid, 3: to };
	const refStops: Record<1 | 2 | 3, Hex> = { 1: REF.from, 2: REF.mid!, 3: REF.to };
	const adjusted: string[] = [];
	// Hero heading gradient text: each stop must read on the page (large text ≥ 3:1).
	for (const s of [1, 2, 3] as const) {
		const r = contrastRatio(stops[s], tokens['surface-950']!);
		if (r + 1e-9 < 3) {
			const lighter = walkLightness(
				hexToLch(stops[s]),
				1,
				(h) => contrastRatio(h, tokens['surface-950']!) >= 3
			);
			const flag =
				s === 1
					? '--theme-from'
					: s === 3
						? '--theme-to'
						: midIn === null
							? 'the middle stop (derived from --theme-from/--theme-to; set --theme-mid)'
							: '--theme-mid';
			problems.push(
				`${flag} ${stops[s]} is too dark to read on the background ${bg} (${fmt(r)}:1, the heading needs 3:1)` +
					(lighter ? ` — try ${lighter}` : '')
			);
		}
	}
	if (problems.length > 0) return { ok: false, problems };

	/** The token's reference offset from its anchor stop, transplanted. */
	const transplant = (ref: Hex, s: 1 | 2 | 3): LCH => {
		const A = hexToLch(refStops[s]);
		const T = hexToLch(ref);
		const B = hexToLch(stops[s]);
		const ratio = A.C > 1e-9 ? T.C / A.C : 1;
		return { L: B.L + (T.L - A.L), C: B.C * ratio, h: B.h + (T.h - A.h) };
	};
	const surfaces = ['surface-950', 'surface-900', 'slate-900', 'surface-800'];
	const need = (hex: Hex, bgs: string[], min: number): boolean =>
		bgs.every((b) => contrastRatio(hex, tokens[b]!) + 1e-9 >= min);

	for (const t of THEME_TOKENS) {
		const r = t.rule;
		switch (r.kind) {
			case 'stop':
				tokens[t.name] = stops[r.stop];
				break;
			case 'offset':
				tokens[t.name] = lchToHex(transplant(t.ref, r.stop));
				break;
			case 'text':
			case 'icon': {
				const min = r.kind === 'text' ? 4.5 : 3;
				const bgs = r.kind === 'text' ? surfaces : ['slate-900', 'surface-900'];
				const start = transplant(t.ref, r.stop);
				const first = lchToHex(start);
				const hex = need(first, bgs, min)
					? first
					: walkLightness(start, 1, (h) => need(h, bgs, min));
				if (hex === null) {
					problems.push(`could not make ${t.name} readable (${min}:1) on this background`);
					break;
				}
				if (hex !== first) adjusted.push(t.name);
				tokens[t.name] = hex;
				for (const b of bgs)
					checks.push({
						what: r.kind === 'text' ? `${t.name} as text` : `${t.name} icon`,
						fg: t.name,
						bg: b,
						ratio: contrastRatio(hex, tokens[b]!),
						min
					});
				break;
			}
			case 'bubble': {
				const start = transplant(t.ref, r.stop);
				const first = lchToHex(start);
				const ok = (h: Hex): boolean => contrastRatio(h, tokens['surface-950']!) + 1e-9 >= 4.5;
				const hex = ok(first) ? first : walkLightness(start, 1, ok);
				if (hex === null) {
					problems.push('could not make the chat bubble readable');
					break;
				}
				if (hex !== first) adjusted.push(t.name);
				tokens[t.name] = hex;
				checks.push({
					what: 'chat bubble text (ink-950) on the bubble',
					fg: 'surface-950',
					bg: t.name,
					ratio: contrastRatio(hex, tokens['surface-950']!),
					min: 4.5
				});
				break;
			}
			case 'btn-face': {
				if (button === 'bright') {
					// The middle stop itself, dark text; lifted until that text reads.
					const dark = tokens['surface-950']!;
					const startB = hexToLch(stops[2]);
					const firstB = lchToHex(startB);
					const okB = (h: Hex): boolean => contrastRatio(h, dark) + 1e-9 >= 4.5;
					const faceB = okB(firstB) ? firstB : walkLightness(startB, 1, okB);
					if (faceB === null) {
						problems.push(
							"--theme-button bright: dark text can't be made readable on the middle colour — use --theme-button deep"
						);
						break;
					}
					if (faceB !== firstB) adjusted.push(t.name);
					tokens[t.name] = faceB;
					tokens['brand-btn-text'] = dark;
					checks.push({
						what: 'button text on the button',
						fg: 'brand-btn-text',
						bg: t.name,
						ratio: contrastRatio(faceB, dark),
						min: 4.5
					});
					break;
				}
				const start = transplant(t.ref, r.stop);
				const first = lchToHex(start);
				const white = '#ffffff';
				const dark = tokens['surface-950']!;
				let face = first;
				let text: Hex;
				if (contrastRatio(face, white) >= 4.5) text = white;
				else if (contrastRatio(face, dark) >= 4.5) text = dark;
				else {
					const deeper = walkLightness(start, -1, (h) => contrastRatio(h, white) >= 4.5);
					if (deeper === null) {
						problems.push('could not find a readable button colour');
						break;
					}
					face = deeper;
					text = white;
					adjusted.push(t.name);
				}
				tokens[t.name] = face;
				tokens['brand-btn-text'] = text;
				checks.push({
					what: 'button text on the button',
					fg: 'brand-btn-text',
					bg: t.name,
					ratio: contrastRatio(face, text),
					min: 4.5
				});
				break;
			}
			case 'btn-text':
			case 'alias':
				break; // filled by btn-face / below
		}
	}
	if (problems.length > 0) return { ok: false, problems };
	for (const t of THEME_TOKENS) {
		if (t.rule.kind === 'alias') tokens[t.name] = tokens[t.rule.of]!;
	}
	const isDefault = THEME_TOKENS.every((t) => tokens[t.name] === t.ref) && grid === REF.grid;
	return {
		ok: true,
		palette: {
			tokens,
			gridOpacity: grid,
			inputs: { from, mid, to, background: bg, preset: presetName, button },
			isDefault,
			checks,
			adjusted
		}
	};
}

/** The reference (Morphit) palette — equal to deriveTheme({preset:'morphit'}). */
export function referenceTokens(): Record<string, Hex> {
	return Object.fromEntries(THEME_TOKENS.map((t) => [t.name, t.ref]));
}

/**
 * CSS declarations that apply a palette: `--brand-1-rgb:243 220 160;…`. Only
 * validated '#rrggbb' values ever reach this (so nothing can break out of the
 * declaration block).
 */
export function themeCssDeclarations(p: Pick<ThemePalette, 'tokens' | 'gridOpacity'>): string {
	const out: string[] = [];
	for (const t of THEME_TOKENS) {
		const hex = normalizeHex(p.tokens[t.name]);
		if (hex === null) throw new Error(`theme token ${t.name} is not a colour`);
		out.push(`--${t.name}-rgb:${hexToRgbTriplet(hex)}`);
	}
	out.push(`--grid-opacity:${gridOpacityValue(p.gridOpacity)}`);
	return out.join(';');
}

/** Clamp + format the grid opacity (0–0.2). */
export function gridOpacityValue(v: unknown): string {
	const n = typeof v === 'number' && Number.isFinite(v) ? Math.min(0.2, Math.max(0, v)) : REF.grid;
	return String(Math.round(n * 1000) / 1000);
}

/** The <style> block branding puts into every prerendered page's <head>. */
export const THEME_STYLE_ID = 'morphit-theme';
export function themeStyleElement(p: Pick<ThemePalette, 'tokens' | 'gridOpacity'>): string {
	return `<style id="${THEME_STYLE_ID}">html:root{${themeCssDeclarations(p)}}</style>`;
}

/**
 * Parse the `theme` block of /brand/brand.json (untrusted input: the file is
 * served by the operator's box and the browser applies it) into validated
 * tokens, or null. Unknown names are ignored; a missing token keeps the
 * compiled default.
 */
export function parseBrandJsonTheme(
	raw: unknown
): { tokens: Record<string, Hex>; gridOpacity: number; themeColor: Hex | null } | null {
	if (raw === null || typeof raw !== 'object') return null;
	const t = (raw as { tokens?: unknown }).tokens;
	if (t === null || typeof t !== 'object') return null;
	const tokens: Record<string, Hex> = {};
	for (const name of THEME_TOKEN_NAMES) {
		const hex = normalizeHex((t as Record<string, unknown>)[name] as string);
		if (hex !== null) tokens[name] = hex;
	}
	if (Object.keys(tokens).length === 0) return null;
	const g = (raw as { grid_opacity?: unknown }).grid_opacity;
	return {
		tokens,
		gridOpacity:
			typeof g === 'number' && Number.isFinite(g) ? Math.min(0.2, Math.max(0, g)) : REF.grid,
		themeColor: tokens['brand-2'] ?? null
	};
}
