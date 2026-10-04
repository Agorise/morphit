/**
 * The social-preview image (og:image, /og-image.png) of a BRANDED instance
 * (docs/BRANDING.md). The shipped image shows the Morphit mark, the "morphit!"
 * wordmark and a "morphit.io" pill; a link to a branded instance must preview
 * with that instance's own logo, name and address instead. `branding apply`
 * (and every upgrade, which re-applies the branding) draws it here, on the
 * server, in the shipped image's layout:
 *
 *   1200 × 630, dark page background with two soft glows in the theme colours;
 *   logo + name in the band where the mark + wordmark sit (x 124–1072,
 *   y 55–219); the tagline below it; the instance's clearnet address in a pill
 *   at y 465–525 (no pill on a Tor/I2P-only or unset origin).
 *
 * RENDERER: @resvg/resvg-js (prebuilt, works offline), loaded lazily so a box
 * without it keeps the shipped image and says so instead of failing.
 *
 * FONTS: the TTFs in apps/ops-cli/assets/og (Comfortaa, the site's font, then
 * Vazirmatn for Arabic-script names), not the system's, so every server draws
 * the same pixels. Only letters neither has are looked up in installed fonts
 * (MORPHIT_OG_FONT_DIRS); a letter no font has is never drawn as an empty box:
 * the name is left out and the operator is told.
 *
 * The operator's logo has already passed the SVG sanitizer (normalizeSvg) and
 * is rasterized ON ITS OWN before it is placed, so nothing in it (a <style>,
 * an id) can restyle the rest of the image.
 */
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio, deriveTheme, type ThemePalette } from '@morphit/operator-config/theme';
import type { NormalizedSvg } from './branding.ts';

export const OG_IMAGE_REL = 'og-image.png';
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** The bundled fonts, in fallback order (assets/og/README.md). */
export const OG_FONTS: ReadonlyArray<{ readonly file: string; readonly family: string }> = [
	{ file: 'Comfortaa-Bold.ttf', family: 'Comfortaa' },
	{ file: 'Vazirmatn-NL-Bold.ttf', family: 'Vazirmatn NL' }
];

/** Where installed fonts are looked for when the bundled ones lack a letter. */
const DEFAULT_SYSTEM_FONT_DIRS = ['/usr/share/fonts', '/usr/local/share/fonts'];

/** The shipped image's layout (measured on apps/web/static/og-image.png). */
const BAND = { x: 124, y: 55, w: 948, h: 164 } as const;
const MARK_MAX = { w: 240, h: 160 } as const;
const MARK_GAP = 64;
const TAGLINE = ['Anonymously trade crypto,', 'fiat, goods and services'] as const;
const TAGLINE_BOX = { cx: 600, cy: 341, w: 800, h: 130 } as const;
const PILL = { cx: 600, y: 465, h: 60, padX: 40, text: 32, maxW: 1000 } as const;
/** Line pitch of a two-line name, in em. */
const LINE_PITCH = 1.12;
/** Outline added to every glyph, in % of the font size. */
const TEXT_WEIGHT = 3.2;
/** A logo.svg wider than this (and no icon.svg) is a wordmark: it fills the band alone. */
export const WORDMARK_ASPECT = 2.2;

export type OgMark =
	| {
			readonly kind: 'svg';
			readonly svg: NormalizedSvg;
			readonly label: string;
			readonly wide: boolean;
	  }
	| { readonly kind: 'png'; readonly png: Buffer; readonly label: string };

export interface OgImageInput {
	/** The site name to draw. */
	readonly name: string;
	readonly mark: OgMark | null;
	/** The instance's clearnet host for the pill, or null for none. */
	readonly host: string | null;
	/** The colour theme, or null for the Morphit colours. */
	readonly palette: ThemePalette | null;
}

export interface OgImageResult {
	/** The image, or null when it cannot be drawn here (keep the shipped one). */
	readonly png: Buffer | null;
	/** What was drawn: logo+name, name, logo, wordmark-logo, tagline-only; or
	 *  renderer-missing / fonts-missing / failed when nothing was. */
	readonly strategy: string;
	readonly notes: string[];
	readonly warnings: string[];
}

export interface OgOptions {
	/** The resvg class; null = not available (tests). Default: loaded from node_modules. */
	readonly resvg?: ResvgClass | null;
	/** Directory of the bundled fonts. Default: assets/og of this package. */
	readonly fontsDir?: string | null;
	/** Directories searched for letters the bundled fonts lack. */
	readonly systemFontDirs?: readonly string[];
}

// ─── The renderer ───────────────────────────────────────────────────────

interface ResvgBBox {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface ResvgInstance {
	render(): { asPng(): Buffer; width: number; height: number };
	getBBox(): ResvgBBox | undefined;
}
export type ResvgClass = new (
	svg: string | Buffer,
	opts?: Record<string, unknown>
) => ResvgInstance;

let resvgCache: ResvgClass | null | undefined;

/** @resvg/resvg-js, or null when this install does not have it (or its
 *  prebuilt binary does not run on this machine). */
export function loadResvg(): ResvgClass | null {
	if (resvgCache !== undefined) return resvgCache;
	try {
		const req = createRequire(import.meta.url);
		const mod = req('@resvg/resvg-js') as { Resvg?: ResvgClass };
		resvgCache = typeof mod.Resvg === 'function' ? mod.Resvg : null;
	} catch {
		resvgCache = null;
	}
	return resvgCache;
}

/** assets/og next to this module: src/lib/ogImage.ts (tsx) or dist/main.js (the bundle). */
export function ogFontsDir(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const c of [join(here, '..', '..', 'assets', 'og'), join(here, '..', 'assets', 'og')]) {
		if (OG_FONTS.every((f) => existsSync(join(c, f.file)))) return c;
	}
	return null;
}

/** MORPHIT_OG_FONT_DIRS (colon-separated; empty = none), else the usual font directories. */
export function systemFontDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	const v = env.MORPHIT_OG_FONT_DIRS;
	if (v === undefined) return [...DEFAULT_SYSTEM_FONT_DIRS];
	return v
		.split(':')
		.map((d) => d.trim())
		.filter((d) => d.startsWith('/'));
}

// ─── Fonts: which font draws which letter ──────────────────────────────

interface FontFace {
	readonly path: string;
	readonly family: string;
	/** Glyph id for a code point (0 = not in the font). */
	glyph(cp: number): number;
	/** Bytes of outline data of a glyph (0 = empty: it would draw nothing). */
	outline(gid: number): number;
}

function u16(b: Buffer, o: number): number {
	return b.readUInt16BE(o);
}
function u32(b: Buffer, o: number): number {
	return b.readUInt32BE(o);
}

/** The best Unicode cmap subtable as a lookup (format 12, else format 4). */
function cmapLookup(b: Buffer, off: number): ((cp: number) => number) | null {
	const n = u16(b, off + 2);
	let f12 = -1;
	let f4 = -1;
	for (let i = 0; i < n; i++) {
		const pid = u16(b, off + 4 + 8 * i);
		const eid = u16(b, off + 6 + 8 * i);
		const so = off + u32(b, off + 8 + 8 * i);
		const unicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10));
		if (!unicode || so + 4 > b.length) continue;
		const fmt = u16(b, so);
		if (fmt === 12 && f12 < 0) f12 = so;
		if (fmt === 4 && f4 < 0) f4 = so;
	}
	if (f12 >= 0) {
		const groups = u32(b, f12 + 12);
		return (cp) => {
			let lo = 0;
			let hi = groups - 1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				const g = f12 + 16 + 12 * mid;
				if (cp < u32(b, g)) hi = mid - 1;
				else if (cp > u32(b, g + 4)) lo = mid + 1;
				else return u32(b, g + 8) + (cp - u32(b, g));
			}
			return 0;
		};
	}
	if (f4 >= 0) {
		const segX2 = u16(b, f4 + 6);
		const ends = f4 + 14;
		const starts = ends + segX2 + 2;
		const deltas = starts + segX2;
		const ranges = deltas + segX2;
		return (cp) => {
			if (cp > 0xffff) return 0;
			for (let i = 0; i < segX2 / 2; i++) {
				if (u16(b, ends + 2 * i) < cp) continue;
				const start = u16(b, starts + 2 * i);
				if (start > cp) return 0;
				const delta = u16(b, deltas + 2 * i);
				const ro = u16(b, ranges + 2 * i);
				if (ro === 0) return (cp + delta) & 0xffff;
				const at = ranges + 2 * i + ro + 2 * (cp - start);
				if (at + 2 > b.length) return 0;
				const g = u16(b, at);
				return g === 0 ? 0 : (g + delta) & 0xffff;
			}
			return 0;
		};
	}
	return null;
}

function familyName(b: Buffer, off: number | undefined): string {
	if (off === undefined) return '';
	const count = u16(b, off + 2);
	const strings = off + u16(b, off + 4);
	let best = '';
	let bestRank = 99;
	for (let i = 0; i < count; i++) {
		const r = off + 6 + 12 * i;
		const pid = u16(b, r);
		const nameId = u16(b, r + 6);
		if (nameId !== 1 && nameId !== 16) continue;
		const len = u16(b, r + 8);
		const at = strings + u16(b, r + 10);
		let s: string;
		if (pid === 3 || pid === 0) {
			s = '';
			for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(u16(b, at + k));
		} else if (pid === 1) {
			s = b.toString('latin1', at, at + len);
		} else continue;
		const rank = (nameId === 16 ? 0 : 2) + (pid === 3 ? 0 : 1);
		if (rank < bestRank && s.trim() !== '') {
			best = s.trim();
			bestRank = rank;
		}
	}
	return best;
}

function parseFace(b: Buffer, base: number, path: string): FontFace | null {
	const ver = u32(b, base);
	if (ver !== 0x00010000 && ver !== 0x4f54544f && ver !== 0x74727565) return null;
	const n = u16(b, base + 4);
	const t = new Map<string, number>();
	for (let i = 0; i < n; i++) {
		const r = base + 12 + 16 * i;
		t.set(b.toString('latin1', r, r + 4), u32(b, r + 8));
	}
	const cmapOff = t.get('cmap');
	if (cmapOff === undefined) return null;
	const glyph = cmapLookup(b, cmapOff);
	if (glyph === null) return null;
	const head = t.get('head');
	const loca = t.get('loca');
	const glyf = t.get('glyf');
	const maxp = t.get('maxp');
	let outline = (gid: number): number => (gid > 0 ? 1 : 0); // CFF outlines: a mapped glyph draws
	if (head !== undefined && loca !== undefined && glyf !== undefined && maxp !== undefined) {
		const long = b.readInt16BE(head + 50) === 1;
		const numGlyphs = u16(b, maxp + 4);
		const at = (i: number): number => (long ? u32(b, loca + 4 * i) : u16(b, loca + 2 * i) * 2);
		outline = (gid) => (gid <= 0 || gid >= numGlyphs ? 0 : at(gid + 1) - at(gid));
	}
	return { path, family: familyName(b, t.get('name')), glyph, outline };
}

/** Every face of a TTF / OTF / TTC file (none when it is not one). */
function loadFaces(path: string): FontFace[] {
	let b: Buffer;
	try {
		const st = statSync(path);
		if (!st.isFile() || st.size > 64 * 1024 * 1024) return [];
		b = readFileSync(path);
	} catch {
		return [];
	}
	try {
		const bases =
			b.toString('latin1', 0, 4) === 'ttcf'
				? Array.from({ length: Math.min(u32(b, 8), 64) }, (_, i) => u32(b, 12 + 4 * i))
				: [0];
		return bases.flatMap((o) => {
			try {
				const f = parseFace(b, o, path);
				return f ? [f] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

/** Font files under `dirs` (sorted, so the choice is the same on every run). */
function fontFilesUnder(dirs: readonly string[]): string[] {
	const out: string[] = [];
	const walk = (d: string, depth: number): void => {
		if (depth > 6 || out.length >= 4000) return;
		let names: string[];
		try {
			names = readdirSync(d).sort();
		} catch {
			return;
		}
		for (const n of names) {
			const p = join(d, n);
			try {
				const st = lstatSync(p).isSymbolicLink() ? statSync(p) : lstatSync(p);
				if (st.isDirectory()) walk(p, depth + 1);
				else if (st.isFile() && /\.(ttf|otf|ttc)$/i.test(n)) out.push(p);
			} catch {
				/* dangling link — skip */
			}
		}
	};
	for (const d of dirs) walk(d, 0);
	return out;
}

/** Characters that draw nothing on their own (spaces, joiners, direction and variation marks). */
const NON_DRAWING =
	/^[\s\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]$/u;

export interface GlyphReport {
	/** Per drawn character: the font that draws it, its glyph id and outline size. */
	readonly glyphs: Array<{ char: string; font: string; glyphId: number; outlineBytes: number }>;
	/** Characters no available font draws. */
	readonly missing: string[];
	/** Installed (non-bundled) font files the name needs. */
	readonly extraFonts: Array<{ path: string; family: string }>;
}

const bundledFaceCache = new Map<string, FontFace[]>();

function bundledFaces(fontsDir: string): FontFace[] {
	let faces = bundledFaceCache.get(fontsDir);
	if (faces === undefined) {
		faces = OG_FONTS.flatMap((f) => loadFaces(join(fontsDir, f.file)));
		bundledFaceCache.set(fontsDir, faces);
	}
	return faces;
}

/** A face's glyph for `cp` when it draws something (0 = missing or empty). */
function drawnGlyph(f: FontFace, cp: number): number {
	const g = f.glyph(cp);
	return g > 0 && f.outline(g) > 0 ? g : 0;
}

type Pick = { path: string; family: string; glyphId: number; outlineBytes: number };
const systemPickCache = new Map<string, Map<number, Pick>>();

/**
 * Installed fonts for the code points the bundled fonts lack: the first face
 * (in sorted path order) that draws ALL of them, else, per code point, the
 * first face that draws it. One font file in memory at a time (a CJK
 * collection is tens of MB).
 */
function systemPicks(cps: readonly number[], dirs: readonly string[]): Map<number, Pick> {
	const key = `${dirs.join(':')}|${cps.join(',')}`;
	const hit = systemPickCache.get(key);
	if (hit !== undefined) return hit;
	const perChar = new Map<number, Pick>();
	let all: Map<number, Pick> | null = null;
	for (const file of fontFilesUnder(dirs)) {
		for (const f of loadFaces(file)) {
			const got = new Map<number, Pick>();
			for (const cp of cps) {
				const g = drawnGlyph(f, cp);
				if (g > 0)
					got.set(cp, { path: f.path, family: f.family, glyphId: g, outlineBytes: f.outline(g) });
			}
			if (got.size === cps.length) {
				all = got;
				break;
			}
			for (const [cp, p] of got) if (!perChar.has(cp)) perChar.set(cp, p);
		}
		if (all !== null) break;
	}
	const out = all ?? perChar;
	systemPickCache.set(key, out);
	return out;
}

/**
 * Which font draws each letter of `text`: the bundled fonts first, then the
 * installed ones (only when needed). A letter counts as drawn only when its
 * glyph exists AND has an outline: an empty glyph would render as nothing,
 * a missing one as an empty box.
 */
export function glyphReport(
	text: string,
	opts: { fontsDir?: string | null; systemFontDirs?: readonly string[] } = {}
): GlyphReport {
	const fontsDir = opts.fontsDir === undefined ? ogFontsDir() : opts.fontsDir;
	const primary = fontsDir === null ? [] : bundledFaces(fontsDir);
	const chars = [...text].filter((ch) => !NON_DRAWING.test(ch));
	const fromBundled = new Map<string, Pick>();
	const lacking: number[] = [];
	for (const ch of chars) {
		const cp = ch.codePointAt(0)!;
		const face = primary.find((f) => drawnGlyph(f, cp) > 0);
		if (face !== undefined) {
			const g = drawnGlyph(face, cp);
			fromBundled.set(ch, {
				path: face.path,
				family: face.family,
				glyphId: g,
				outlineBytes: face.outline(g)
			});
		} else if (!lacking.includes(cp)) lacking.push(cp);
	}
	const fromSystem =
		lacking.length === 0
			? new Map<number, Pick>()
			: systemPicks(lacking, opts.systemFontDirs ?? systemFontDirs());
	const glyphs: GlyphReport['glyphs'] = [];
	const missing: string[] = [];
	const extra = new Map<string, string>();
	for (const ch of chars) {
		const p = fromBundled.get(ch) ?? fromSystem.get(ch.codePointAt(0)!);
		if (p === undefined) {
			if (!missing.includes(ch)) missing.push(ch);
			continue;
		}
		if (!fromBundled.has(ch)) extra.set(p.path, p.family);
		glyphs.push({
			char: ch,
			font: basename(p.path),
			glyphId: p.glyphId,
			outlineBytes: p.outlineBytes
		});
	}
	return {
		glyphs,
		missing,
		extraFonts: [...extra].map(([path, family]) => ({ path, family }))
	};
}

// ─── Drawing ────────────────────────────────────────────────────────────

const xmlEscape = (s: string): string =>
	s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

/** The first strongly-directional letter is right-to-left (Arabic, Hebrew, …). */
export function startsRightToLeft(s: string): boolean {
	for (const ch of s) {
		if (/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u.test(ch)) return true;
		if (/\p{L}/u.test(ch)) return false;
	}
	return false;
}

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

const SVG_OPEN = (w: number, h: number, vb = `0 0 ${w} ${h}`): string =>
	`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="${vb}">`;

class Painter {
	private readonly opts: Record<string, unknown>;
	private readonly measured = new Map<string, Box | null>();
	constructor(
		private readonly R: ResvgClass,
		fontFiles: string[],
		readonly family: string
	) {
		this.opts = {
			font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Comfortaa' },
			fitTo: { mode: 'original' },
			shapeRendering: 2,
			textRendering: 2,
			imageRendering: 0,
			logLevel: 'off'
		};
	}

	/** One line of text. A thin outline in the same colour gives it the
	 *  weight of the shipped image's lettering (Comfortaa tops out at 700). */
	text(s: string, size: number, fill: string, x = 0, y = 0): string {
		return (
			`<text x="${x}" y="${y}" font-family="${xmlEscape(this.family)}" font-weight="700" font-size="${size}" ` +
			`fill="${fill}" stroke="${fill}" stroke-width="${r2((TEXT_WEIGHT * size) / 100)}" stroke-linejoin="round">${xmlEscape(s)}</text>`
		);
	}

	/** Ink box of one line at 100 px, baseline at y=0, starting at x=0. */
	ink(s: string): Box | null {
		const hit = this.measured.get(s);
		if (hit !== undefined) return hit;
		const svg = `${SVG_OPEN(8000, 2000, '-4000 -1000 8000 2000')}${this.text(s, 100, '#fff')}</svg>`;
		const b = new this.R(svg, this.opts).getBBox();
		const o = TEXT_WEIGHT / 2;
		const box =
			b && b.width > 0 && b.height > 0
				? { x: b.x - o, y: b.y - o, w: b.width + 2 * o, h: b.height + 2 * o }
				: null;
		this.measured.set(s, box);
		return box;
	}

	/**
	 * `lines` (one or two), each centred on x=0, line pitch LINE_PITCH em, at
	 * 100 px; scaled to fit `w`×`h` and `maxSize` px. Returns the markup with its
	 * ink box at the origin, and that box's size.
	 */
	block(
		lines: readonly string[],
		w: number,
		h: number,
		maxSize: number,
		fill: string
	): { svg: string; w: number; h: number; size: number } | null {
		let gx0 = Infinity;
		let gy0 = Infinity;
		let gx1 = -Infinity;
		let gy1 = -Infinity;
		const parts: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const b = this.ink(lines[i]!);
			if (b === null) return null;
			const dy = i * LINE_PITCH * 100;
			const dx = -(b.x + b.w / 2);
			parts.push(this.text(lines[i]!, 100, fill, dx, dy));
			gx0 = Math.min(gx0, -b.w / 2);
			gx1 = Math.max(gx1, b.w / 2);
			gy0 = Math.min(gy0, b.y + dy);
			gy1 = Math.max(gy1, b.y + b.h + dy);
		}
		const gw = gx1 - gx0;
		const gh = gy1 - gy0;
		const k = Math.min(maxSize / 100, w / gw, h / gh);
		return {
			svg: `<g transform="scale(${r4(k)}) translate(${r4(-gx0)} ${r4(-gy0)})">${parts.join('')}</g>`,
			w: gw * k,
			h: gh * k,
			size: 100 * k
		};
	}

	/** The name as large as it fits: one line, or two (split at a space) when that is clearly larger. */
	name(
		name: string,
		w: number,
		h: number,
		maxOne: number,
		maxTwo: number
	): { svg: string; w: number; h: number; lines: number } | null {
		const one = this.block([name], w, h, maxOne, '#ffffff');
		let best = one === null ? null : { ...one, lines: 1 };
		const words = name.split(' ');
		for (let i = 1; i < words.length; i++) {
			const a = words.slice(0, i).join(' ').trim();
			const b = words.slice(i).join(' ').trim();
			if (a === '' || b === '') continue;
			const two = this.block([a, b], w, h, maxTwo, '#ffffff');
			if (two === null) continue;
			if (best === null || two.size > best.size * (best.lines === 1 ? 1.12 : 1))
				best = { ...two, lines: 2 };
		}
		return best === null ? null : { svg: best.svg, w: best.w, h: best.h, lines: best.lines };
	}

	/** An SVG drawn on its own (isolated from the rest of the image) as a PNG
	 *  of at most w×h, keeping its proportions. */
	rasterLogo(svg: NormalizedSvg, w: number, h: number): { png: Buffer; w: number; h: number } {
		const aspect = svg.width / svg.height;
		const fit =
			aspect >= w / h
				? { mode: 'width', value: Math.round(w) }
				: { mode: 'height', value: Math.round(h) };
		const img = new this.R(svg.svg, { ...this.opts, fitTo: fit }).render();
		return { png: img.asPng(), w: img.width, h: img.height };
	}

	png(svg: string): Buffer {
		return new this.R(svg, this.opts).render().asPng();
	}
}

const r2 = (n: number): string => String(Math.round(n * 100) / 100);
const r4 = (n: number): string => String(Math.round(n * 10000) / 10000);
const dataPng = (b: Buffer): string => `data:image/png;base64,${b.toString('base64')}`;

function tokensOf(palette: ThemePalette | null): Record<string, string> {
	if (palette !== null) return palette.tokens as Record<string, string>;
	const d = deriveTheme({});
	return d.ok ? (d.palette.tokens as Record<string, string>) : {};
}

/** Draw the image. Never throws: on any problem `png` is null and a warning says why. */
export function renderOgImage(input: OgImageInput, opts: OgOptions = {}): OgImageResult {
	const notes: string[] = [];
	const warnings: string[] = [];
	const R = opts.resvg === undefined ? loadResvg() : opts.resvg;
	if (R === null) {
		return {
			png: null,
			strategy: 'renderer-missing',
			notes,
			warnings: [
				'og-image.png (the link-preview picture) still shows Morphit: its image renderer (@resvg/resvg-js) is not ' +
					'installed here. Run: sudo morphit-ops upgrade — or put your own 1200×630 og-image.png under the ' +
					'branding static/ folder.'
			]
		};
	}
	const fontsDir = opts.fontsDir === undefined ? ogFontsDir() : opts.fontsDir;
	if (fontsDir === null) {
		return {
			png: null,
			strategy: 'fonts-missing',
			notes,
			warnings: [
				'og-image.png (the link-preview picture) still shows Morphit: its fonts (apps/ops-cli/assets/og) are ' +
					'missing from this install. Run: sudo morphit-ops upgrade'
			]
		};
	}
	try {
		return draw(R, fontsDir, input, opts, notes, warnings);
	} catch (err) {
		return {
			png: null,
			strategy: 'failed',
			notes,
			warnings: [
				`og-image.png (the link-preview picture) could not be drawn (${err instanceof Error ? err.message : String(err)}), so it still shows Morphit.`
			]
		};
	}
}

function draw(
	R: ResvgClass,
	fontsDir: string,
	input: OgImageInput,
	opts: OgOptions,
	notes: string[],
	warnings: string[]
): OgImageResult {
	const t = tokensOf(input.palette);
	const page = t['surface-page'] ?? '#0a0e16';
	const c1 = t['brand-1'] ?? '#8eef26';
	const c2 = t['brand-2'] ?? '#00da69';
	const c3 = t['brand-3'] ?? '#02a6b2';
	const body = t['surface-100'] ?? '#eef1f5';

	const name = input.name.trim();
	const report = glyphReport(name, { fontsDir, systemFontDirs: opts.systemFontDirs });
	const drawName = name !== '' && report.missing.length === 0;
	if (!drawName && name !== '') {
		warnings.push(
			`og-image.png (the link-preview picture) shows your logo but not your site name: no font here has ` +
				`${report.missing.map((c) => `"${c}"`).join(' ')}. Install a font that has them (for Chinese, ` +
				'Japanese or Korean: the fonts-noto-cjk package), then run: sudo morphit-ops branding apply'
		);
	}
	const fontFiles = [
		...OG_FONTS.map((f) => join(fontsDir, f.file)),
		...(drawName ? report.extraFonts.map((f) => f.path) : [])
	];
	const families = [
		...OG_FONTS.map((f) => f.family),
		...(drawName ? report.extraFonts.map((f) => f.family).filter((f) => f !== '') : [])
	];
	const family = [...new Set(families)].map((f) => `'${f.replace(/'/g, '')}'`).join(', ');
	const P = new Painter(R, fontFiles, family);
	if (drawName && report.extraFonts.length > 0) {
		notes.push(
			`og-image.png: your name uses ${report.extraFonts.map((f) => basename(f.path)).join(', ')} from this server`
		);
	}

	const parts: string[] = [];
	// Background: the page colour and two soft glows in the theme colours.
	parts.push(
		'<defs>' +
			`<radialGradient id="morphit-og-glow-1" cx="0.1" cy="0.02" r="0.62"><stop offset="0" stop-color="${c1}" stop-opacity="0.26"/><stop offset="1" stop-color="${c1}" stop-opacity="0"/></radialGradient>` +
			`<radialGradient id="morphit-og-glow-2" cx="0.92" cy="1" r="0.62"><stop offset="0" stop-color="${c3}" stop-opacity="0.22"/><stop offset="1" stop-color="${c3}" stop-opacity="0"/></radialGradient>` +
			`<linearGradient id="morphit-og-pill" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>` +
			'<filter id="morphit-og-soft" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="12"/></filter>' +
			'</defs>',
		`<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${page}"/>`,
		`<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#morphit-og-glow-1)"/>`,
		`<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#morphit-og-glow-2)"/>`
	);

	// The band: logo + name where the Morphit mark + wordmark are.
	const cy = BAND.y + BAND.h / 2;
	const mark = input.mark;
	const placeImage = (png: Buffer, x: number, y: number, w: number, h: number): string =>
		`<image x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" preserveAspectRatio="xMidYMid meet" xlink:href="${dataPng(png)}"/>`;
	let strategy: string;
	if (mark !== null && mark.kind === 'svg' && mark.wide) {
		const l = P.rasterLogo(mark.svg, BAND.w, BAND.h);
		parts.push(placeImage(l.png, 600 - l.w / 2, cy - l.h / 2, l.w, l.h));
		strategy = 'wordmark-logo';
		notes.push(
			`social preview (og-image.png) ← ${mark.label} (a wide logo, shown on its own — add icon.svg to show your symbol next to the name)`
		);
	} else {
		let markImg: { png: Buffer; w: number; h: number } | null = null;
		if (mark !== null && mark.kind === 'svg')
			markImg = P.rasterLogo(mark.svg, MARK_MAX.w, MARK_MAX.h);
		if (mark !== null && mark.kind === 'png') {
			const w0 = mark.png.readUInt32BE(16);
			const h0 = mark.png.readUInt32BE(20);
			const k = Math.min(MARK_MAX.w / w0, MARK_MAX.h / h0);
			markImg = { png: mark.png, w: w0 * k, h: h0 * k };
		}
		const nameW = BAND.w - (markImg === null ? 0 : markImg.w + MARK_GAP);
		const nm = drawName
			? markImg === null
				? P.name(name, BAND.w, BAND.h, 150, 80)
				: P.name(name, nameW, BAND.h, 140, 78)
			: null;
		const groupW =
			(markImg?.w ?? 0) + (markImg !== null && nm !== null ? MARK_GAP : 0) + (nm?.w ?? 0);
		const rtl = startsRightToLeft(name);
		let x = 600 - groupW / 2;
		const putMark = (): void => {
			if (markImg === null) return;
			parts.push(placeImage(markImg.png, x, cy - markImg.h / 2, markImg.w, markImg.h));
			x += markImg.w + (nm !== null ? MARK_GAP : 0);
		};
		const putName = (): void => {
			if (nm === null) return;
			parts.push(`<g transform="translate(${r2(x)} ${r2(cy - nm.h / 2)})">${nm.svg}</g>`);
			x += nm.w + (markImg !== null && rtl ? MARK_GAP : 0);
		};
		if (rtl) {
			putName();
			putMark();
		} else {
			putMark();
			putName();
		}
		strategy =
			markImg !== null && nm !== null
				? 'logo+name'
				: nm !== null
					? 'name'
					: markImg !== null
						? 'logo'
						: 'tagline-only';
		const what =
			markImg !== null && nm !== null
				? `${mark!.label} + your name${nm.lines === 2 ? ' (two lines)' : ''}`
				: nm !== null
					? 'your name'
					: markImg !== null
						? mark!.label
						: 'the tagline only';
		notes.push(`social preview (og-image.png) ← ${what}`);
	}

	// The tagline, as on the shipped image.
	const tag = P.block(TAGLINE, TAGLINE_BOX.w, TAGLINE_BOX.h, 60, body);
	if (tag !== null) {
		parts.push(
			`<g transform="translate(${r2(TAGLINE_BOX.cx - tag.w / 2)} ${r2(TAGLINE_BOX.cy - tag.h / 2)})">${tag.svg}</g>`
		);
	}

	// The instance's own address (clearnet only).
	if (input.host !== null) {
		const pillText = contrastRatio(c2, page) >= 4.5 ? page : '#ffffff';
		const label = P.block([input.host], PILL.maxW - 2 * PILL.padX, PILL.h, PILL.text, pillText);
		if (label !== null) {
			const w = label.w + 2 * PILL.padX;
			const x = PILL.cx - w / 2;
			parts.push(
				`<rect x="${r2(x)}" y="${PILL.y}" width="${r2(w)}" height="${PILL.h}" rx="16" fill="${c2}" opacity="0.45" filter="url(#morphit-og-soft)"/>`,
				`<rect x="${r2(x)}" y="${PILL.y}" width="${r2(w)}" height="${PILL.h}" rx="16" fill="url(#morphit-og-pill)"/>`,
				`<g transform="translate(${r2(PILL.cx - label.w / 2)} ${r2(PILL.y + PILL.h / 2 - label.h / 2)})">${label.svg}</g>`
			);
		}
	}

	const svg = `${SVG_OPEN(OG_WIDTH, OG_HEIGHT)}${parts.join('')}</svg>`;
	const png = withText(P.png(svg), [
		['Title', name],
		['Software', 'Morphit (morphit-ops branding)']
	]);
	return { png, strategy, notes, warnings };
}

// ─── PNG text chunks ────────────────────────────────────────────────────

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(b: Buffer): number {
	let c = 0xffffffff;
	for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Insert uncompressed iTXt chunks (UTF-8 text) right after IHDR. */
export function withText(png: Buffer, entries: ReadonlyArray<readonly [string, string]>): Buffer {
	const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
	const chunks = entries.map(([key, text]) => {
		const body = Buffer.concat([
			Buffer.from(key, 'latin1'),
			Buffer.from([0, 0, 0, 0, 0]), // NUL, not compressed, method, empty language, empty translation
			Buffer.from(text, 'utf8')
		]);
		const head = Buffer.alloc(8);
		head.writeUInt32BE(body.length, 0);
		head.write('iTXt', 4, 'latin1');
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
		return Buffer.concat([head, body, crc]);
	});
	return Buffer.concat([png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd)]);
}

/** The instance's clearnet host from build/.origin-slots.json, or null: none
 *  applied, a Tor/I2P origin, or still the build's own (morphit.io). */
export function ogHostFromOriginMap(map: unknown): string | null {
	if (typeof map !== 'object' || map === null) return null;
	const m = map as { applied_origin?: unknown; build_origin?: unknown };
	const applied = m.applied_origin;
	if (typeof applied !== 'string' || applied === m.build_origin) return null;
	const hit =
		/^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)(:\d{1,5})?$/.exec(
			applied
		);
	if (hit === null) return null;
	const host = hit[1]!;
	return /\.(onion|i2p)$/.test(host) ? null : host;
}

/** A PNG mark (the operator's app-icon-512.png) is usable: a PNG of sane size. */
export function usablePngMark(buf: Buffer): boolean {
	if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return false;
	const w = buf.readUInt32BE(16);
	const h = buf.readUInt32BE(20);
	return w > 0 && h > 0 && w <= 4096 && h <= 4096;
}
