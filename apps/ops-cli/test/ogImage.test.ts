/**
 * The social-preview image (og:image, /og-image.png) of a branded instance
 * (docs/BRANDING.md): `branding apply` draws it from the operator's own logo
 * and site name, on the server, and every upgrade re-applies it.
 *
 * Read the way a link unfurler sees it: the PNG bytes are decoded and the
 * pixels of the logo, name and address areas are compared with the shipped
 * Morphit image (whose layout these areas come from: the mark at x 124–362,
 * the wordmark at x 433–1072, both y 55–219; the address pill at y 465–525).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
	applyBranding,
	brandingPaths,
	pngSize,
	type BrandingSettings
} from '../src/lib/branding.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const CANONICAL_OG = readFileSync(join(REPO, 'apps', 'web', 'static', 'og-image.png'));
const SLOT_BUILDER = join(REPO, 'scripts', 'build-brand-slots.mjs');
const ORIGIN_SCRIPT = join(REPO, 'apps', 'web', 'scripts', 'origin-slots.mjs');
const M = '\u2060';

/** A test logo in a colour no Morphit image uses (magenta), so its pixels are countable. */
const ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
	'<circle cx="50" cy="50" r="46" fill="#ff00aa"/><rect x="30" y="30" width="40" height="40" fill="#ffffff"/></svg>';

let root = '';
let installDir = '';
let buildDir = '';
let brandDir = '';
let etcDir = '';
const savedEnv = { ...process.env };

// ─── PNG decoding (8-bit RGB, RGBA or palette, non-interlaced: what resvg and the shipped image use) ──

interface Img {
	width: number;
	height: number;
	px: (x: number, y: number) => [number, number, number];
}

function pngChunks(buf: Buffer): Array<{ type: string; data: Buffer }> {
	const out: Array<{ type: string; data: Buffer }> = [];
	let off = 8;
	while (off + 8 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.subarray(off + 4, off + 8).toString('latin1');
		out.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
		off += 12 + len;
	}
	return out;
}

function decodePng(buf: Buffer): Img {
	const chunks = pngChunks(buf);
	const ihdr = chunks.find((c) => c.type === 'IHDR')!.data;
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const depth = ihdr[8]!;
	const colour = ihdr[9]!;
	const interlace = ihdr[12]!;
	if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 3 && colour !== 6))
		throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
	const bpp = colour === 6 ? 4 : colour === 3 ? 1 : 3;
	const plte = chunks.find((c) => c.type === 'PLTE')?.data;
	const raw = inflateSync(
		Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
	);
	const stride = width * bpp;
	const pix = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)]!;
		for (let i = 0; i < stride; i++) {
			const x = raw[y * (stride + 1) + 1 + i]!;
			const a = i >= bpp ? pix[y * stride + i - bpp]! : 0;
			const b = y > 0 ? pix[(y - 1) * stride + i]! : 0;
			const c = i >= bpp && y > 0 ? pix[(y - 1) * stride + i - bpp]! : 0;
			let v: number;
			if (f === 0) v = x;
			else if (f === 1) v = x + a;
			else if (f === 2) v = x + b;
			else if (f === 3) v = x + ((a + b) >> 1);
			else {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
			}
			pix[y * stride + i] = v & 0xff;
		}
	}
	return {
		width,
		height,
		px: (x, y) => {
			const o = y * stride + x * bpp;
			if (colour === 3) {
				const i = pix[o]! * 3;
				return [plte![i]!, plte![i + 1]!, plte![i + 2]!];
			}
			return [pix[o]!, pix[o + 1]!, pix[o + 2]!];
		}
	};
}

/** The iTXt/tEXt text chunks of a PNG, keyword → text. */
function pngText(buf: Buffer): Record<string, string> {
	const out: Record<string, string> = {};
	for (const c of pngChunks(buf)) {
		if (c.type === 'tEXt') {
			const z = c.data.indexOf(0);
			out[c.data.subarray(0, z).toString('latin1')] = c.data.subarray(z + 1).toString('latin1');
		} else if (c.type === 'iTXt') {
			const z = c.data.indexOf(0);
			const key = c.data.subarray(0, z).toString('latin1');
			let p = z + 3; // compression flag + method
			p = c.data.indexOf(0, p) + 1; // language tag
			p = c.data.indexOf(0, p) + 1; // translated keyword
			out[key] = c.data.subarray(p).toString('utf8');
		}
	}
	return out;
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const count = (img: Img, b: Box, pred: (p: [number, number, number]) => boolean): number => {
	let n = 0;
	for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) if (pred(img.px(x, y))) n++;
	return n;
};
const meanAbsDiff = (a: Img, b: Img, box: Box): number => {
	let s = 0;
	let n = 0;
	for (let y = box.y0; y < box.y1; y++)
		for (let x = box.x0; x < box.x1; x++) {
			const p = a.px(x, y);
			const q = b.px(x, y);
			s += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
			n++;
		}
	return s / n / 3;
};

const MARK: Box = { x0: 110, y0: 45, x1: 380, y1: 230 };
const BAND: Box = { x0: 0, y0: 30, x1: 1200, y1: 240 };
const PILL: Box = { x0: 440, y0: 450, x1: 760, y1: 540 };
const magenta = (p: [number, number, number]): boolean =>
	p[0] > 200 && p[1] < 70 && p[2] > 120 && p[2] < 220;
/** The Morphit mark's and the wordmark's "it!" bright green. */
const morphitGreen = (p: [number, number, number]): boolean =>
	p[1] > 170 && p[0] < 160 && p[2] < 150 && p[1] - p[0] > 60;
const white = (p: [number, number, number]): boolean => Math.min(...p) > 200;

// ─── Fixture: a build as `npm run build` leaves it ──────────────────────

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? walk(p) : [relative(buildDir, p).split(sep).join('/')];
	});
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const og = (): Buffer => readFileSync(join(buildDir, 'og-image.png'));

function writeVerifyJson(): void {
	const hm: Record<string, string> = {};
	for (const rel of walk(buildDir)) {
		if (rel !== 'verify.json') hm[rel] = sha(readFileSync(join(buildDir, rel)));
	}
	writeFileSync(
		join(buildDir, 'verify.json'),
		JSON.stringify({ schema_version: 1, hash_manifest: hm }, null, 2) + '\n'
	);
}

/** verify.json entries whose file is missing or hashes differently. */
function verifyMismatches(dir = buildDir): string[] {
	const hm = (
		JSON.parse(readFileSync(join(dir, 'verify.json'), 'utf8')) as {
			hash_manifest: Record<string, string>;
		}
	).hash_manifest;
	return Object.entries(hm)
		.filter(([rel, h]) => !existsSync(join(dir, rel)) || sha(readFileSync(join(dir, rel))) !== h)
		.map(([rel]) => rel);
}

function settings(over: Partial<BrandingSettings> = {}): BrandingSettings {
	return {
		brandName: null,
		invalidBrandName: null,
		shortName: null,
		betaBadge: null,
		dir: brandDir,
		...over
	};
}

function origin(applied: string): void {
	writeFileSync(
		join(buildDir, '.origin-slots.json'),
		JSON.stringify({
			schema: 1,
			build_origin: 'https://morphit.io',
			applied_origin: applied,
			files: {}
		})
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-og-'));
	installDir = join(root, 'opt', 'morphit');
	buildDir = join(installDir, 'apps', 'web', 'build');
	etcDir = join(root, 'etc', 'morphit');
	brandDir = join(etcDir, 'branding');
	mkdirSync(join(buildDir, '_app'), { recursive: true });
	mkdirSync(brandDir, { recursive: true });
	writeFileSync(
		join(buildDir, 'index.html'),
		`<!doctype html><html lang="en"><head><title>${M}Morphit${M}</title></head><body></body></html>`
	);
	writeFileSync(
		join(buildDir, 'en.html'),
		`<!doctype html><html lang="en"><head><title>${M}Morphit${M}</title>` +
			`<meta property="og:image" content="/og-image.png"></head><body><h1>${M}Morphit${M}</h1></body></html>`
	);
	writeFileSync(join(buildDir, '_app', 'entry.js'), 'export {};');
	mkdirSync(join(buildDir, 'brand'), { recursive: true });
	writeFileSync(
		join(buildDir, 'brand', 'brand.json'),
		'{\n\t"schema": 1,\n\t"name": "Morphit",\n\t"beta_badge": true\n}\n'
	);
	writeFileSync(join(buildDir, 'og-image.png'), CANONICAL_OG);
	const r = spawnSync(process.execPath, [SLOT_BUILDER, buildDir], { encoding: 'utf8' });
	expect(r.status, r.stderr).toBe(0);
	writeVerifyJson();
});

afterEach(() => {
	process.env = { ...savedEnv };
	rmSync(root, { recursive: true, force: true });
});

// ─── The guards ─────────────────────────────────────────────────────────

describe('the social-preview image of a branded instance', () => {
	it('shows the instance’s own logo and name, not the Morphit mark and wordmark', () => {
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		const r = applyBranding({
			buildDir,
			settings: settings({ brandName: 'Vigilante Trading' })
		});
		expect(r.touched).toContain('og-image.png');
		const png = og();
		expect(png.equals(CANONICAL_OG)).toBe(false);
		expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
		const img = decodePng(png);
		const canon = decodePng(CANONICAL_OG);
		expect(img.width).toBe(1200);
		expect(img.height).toBe(630);
		// The logo area: the operator's (magenta) logo, not the Morphit mark.
		expect(count(img, MARK, magenta)).toBeGreaterThan(3000);
		expect(count(canon, MARK, magenta)).toBe(0);
		expect(meanAbsDiff(img, canon, MARK)).toBeGreaterThan(20);
		// No Morphit green left anywhere in the logo + wordmark band.
		expect(count(canon, BAND, morphitGreen)).toBeGreaterThan(5000);
		expect(count(img, BAND, morphitGreen)).toBeLessThan(50);
		// The name is drawn (white text right of the logo) and named in the file.
		expect(count(img, { x0: 380, y0: 40, x1: 1150, y1: 235 }, white)).toBeGreaterThan(2000);
		expect(pngText(png).Title).toBe('Vigilante Trading');
		// The same input draws the same bytes: a second apply (every upgrade) changes nothing.
		const again = applyBranding({
			buildDir,
			settings: settings({ brandName: 'Vigilante Trading' })
		});
		expect(again.touched).toEqual([]);
		expect(og().equals(png)).toBe(true);
	});

	it('draws the name it is given (the name area changes with the name, the logo area does not)', () => {
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		const a = decodePng(og());
		applyBranding({ buildDir, settings: settings({ brandName: 'Lima Exchange' }) });
		const bPng = og();
		const b = decodePng(bPng);
		expect(pngText(bPng).Title).toBe('Lima Exchange');
		expect(meanAbsDiff(a, b, { x0: 380, y0: 40, x1: 1150, y1: 235 })).toBeGreaterThan(3);
	});

	it('keeps verify.json matching every served file, and reset restores the shipped bytes', () => {
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		expect(og().equals(CANONICAL_OG)).toBe(false);
		expect(verifyMismatches()).toEqual([]);
		const v = JSON.parse(readFileSync(join(buildDir, 'verify.json'), 'utf8')) as {
			operator_branding: { files: string[] };
		};
		expect(v.operator_branding.files).toContain('og-image.png');
		applyBranding({ buildDir, settings: settings(), reset: true });
		expect(og().equals(CANONICAL_OG)).toBe(true);
		expect(verifyMismatches()).toEqual([]);
		expect(existsSync(brandingPaths(buildDir).pristineDir)).toBe(false);
	});

	it('an unbranded instance (or one with only colours) keeps the shipped image', () => {
		applyBranding({ buildDir, settings: settings() });
		expect(og().equals(CANONICAL_OG)).toBe(true);
		applyBranding({
			buildDir,
			settings: settings({ theme: { preset: 'champagne-gold' } })
		});
		expect(og().equals(CANONICAL_OG)).toBe(true);
	});

	it('a name alone (no logo files) replaces the Morphit mark and wordmark too', () => {
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		const png = og();
		const img = decodePng(png);
		expect(png.equals(CANONICAL_OG)).toBe(false);
		expect(count(img, BAND, morphitGreen)).toBeLessThan(50);
		expect(count(img, BAND, white)).toBeGreaterThan(3000);
		expect(pngText(png).Title).toBe('Vigilante Trading');
	});

	it('the address pill names the instance’s own clearnet origin, and none on a hidden or unset one', () => {
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		const pillInk = (): number =>
			count(decodePng(og()), PILL, (p) => Math.max(...p) > 150 && !white(p));
		origin('https://vigilante.trading');
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		const withPill = decodePng(og());
		expect(pillInk()).toBeGreaterThan(5000);
		origin(`http://${'a'.repeat(56)}.onion`);
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		expect(pillInk()).toBeLessThan(200);
		expect(meanAbsDiff(withPill, decodePng(og()), PILL)).toBeGreaterThan(10);
		origin('');
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		expect(pillInk()).toBeLessThan(200);
		// The build origin itself (morphit.io) is never shown on a branded image.
		origin('https://morphit.io');
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		expect(pillInk()).toBeLessThan(200);
	});

	it('a long name shrinks and wraps to at most two lines inside the band', () => {
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		const name = 'The Very Long Name Of A Community Swap Market 42';
		expect(name.length).toBe(48);
		applyBranding({ buildDir, settings: settings({ brandName: name }) });
		const img = decodePng(og());
		// No name ink outside the band, nor over the tagline.
		expect(count(img, { x0: 0, y0: 0, x1: 1200, y1: 30 }, white)).toBe(0);
		expect(count(img, { x0: 0, y0: 240, x1: 1200, y1: 262 }, white)).toBe(0);
		expect(count(img, { x0: 1130, y0: 30, x1: 1200, y1: 240 }, white)).toBe(0);
		// Rows of name ink right of the logo form one or two runs (lines), never three.
		const rows: boolean[] = [];
		for (let y = 30; y < 240; y++) {
			let ink = 0;
			for (let x = 400; x < 1130; x++) if (white(img.px(x, y))) ink++;
			rows.push(ink > 2);
		}
		const runs = rows.filter((v, i) => v && !rows[i - 1]).length;
		expect(runs).toBeGreaterThanOrEqual(1);
		expect(runs).toBeLessThanOrEqual(2);
		expect(count(img, { x0: 400, y0: 30, x1: 1130, y1: 240 }, white)).toBeGreaterThan(3000);
		expect(pngText(og()).Title).toBe(name);
	});

	it('a Persian name renders in a font that has its letters — no empty boxes (tofu)', async () => {
		const og2 = await import('../src/lib/ogImage.ts');
		const name = 'بازار آزاد ویژه';
		const report = og2.glyphReport(name);
		expect(report.missing).toEqual([]);
		for (const g of report.glyphs) {
			if (/\s/.test(g.char)) continue;
			expect(g.font, `U+${g.char.codePointAt(0)!.toString(16)}`).toMatch(/Vazirmatn/);
			expect(g.glyphId, g.char).toBeGreaterThan(0);
			expect(g.outlineBytes, g.char).toBeGreaterThan(0);
		}
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		applyBranding({ buildDir, settings: settings({ brandName: name }) });
		const png = og();
		expect(pngText(png).Title).toBe(name);
		const img = decodePng(png);
		// Right-to-left: the logo moves to the right, the name is on its left.
		expect(count(img, { x0: 820, y0: 45, x1: 1100, y1: 230 }, magenta)).toBeGreaterThan(3000);
		expect(count(img, { x0: 100, y0: 40, x1: 820, y1: 235 }, white)).toBeGreaterThan(2000);
	});

	it('letters no bundled font has are never drawn as empty boxes', async () => {
		const og2 = await import('../src/lib/ogImage.ts');
		// Ethiopic: in neither bundled font; no system fonts are offered here.
		const name = 'ሰላም ገበያ';
		const report = og2.glyphReport(name, { systemFontDirs: [] });
		expect(report.missing.length).toBeGreaterThan(0);
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		process.env.MORPHIT_OG_FONT_DIRS = '';
		const r = applyBranding({ buildDir, settings: settings({ brandName: name }) });
		const png = og();
		expect(png.equals(CANONICAL_OG)).toBe(false);
		const img = decodePng(png);
		// The logo is there (alone, centred); nothing else bright in the band: no
		// empty boxes where the name would be.
		let x0 = 1200;
		let x1 = 0;
		let y0 = 630;
		let y1 = 0;
		for (let y = BAND.y0; y < BAND.y1; y++)
			for (let x = 0; x < 1200; x++)
				if (magenta(img.px(x, y))) {
					x0 = Math.min(x0, x);
					x1 = Math.max(x1, x);
					y0 = Math.min(y0, y);
					y1 = Math.max(y1, y);
				}
		expect(count(img, BAND, magenta)).toBeGreaterThan(3000);
		const outsideLogo =
			count(img, BAND, (p) => Math.max(...p) > 160) -
			count(img, { x0: x0 - 3, y0: y0 - 3, x1: x1 + 4, y1: y1 + 4 }, (p) => Math.max(...p) > 160);
		expect(outsideLogo).toBe(0);
		expect(r.warnings.join(' ')).toMatch(/og-image/);
	});
});

// v1.21.1 — the pictures in the Blurt posts a user publishes from an instance
// (the first-trade post to the community, the per-order post to their blog)
// follow the instance's branding. brand.json tells the page whether the served
// og-image.png is this instance's own; without that, a branded instance's
// community post showed the Morphit picture.
describe('brand.json says whether the link-preview picture is the instance’s own', () => {
	const brandJson = (): Record<string, unknown> =>
		JSON.parse(readFileSync(join(buildDir, 'brand', 'brand.json'), 'utf8')) as Record<
			string,
			unknown
		>;
	it('drawn for a name or a logo → og_image: "own"', () => {
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		expect(brandJson().og_image).toBe('own');
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		applyBranding({ buildDir, settings: settings() });
		expect(brandJson().og_image).toBe('own');
	});
	it('the operator’s own static/og-image.png → og_image: "own"', () => {
		mkdirSync(join(brandDir, 'static'), { recursive: true });
		const own = Buffer.concat([CANONICAL_OG, Buffer.from([0])]);
		writeFileSync(join(brandDir, 'static', 'og-image.png'), own);
		applyBranding({ buildDir, settings: settings({ theme: { preset: 'champagne-gold' } }) });
		expect(og().equals(own)).toBe(true);
		expect(brandJson().og_image).toBe('own');
	});
	it('an overlay identical to the shipped picture is the shipped picture → no og_image field', () => {
		mkdirSync(join(brandDir, 'static'), { recursive: true });
		writeFileSync(join(brandDir, 'static', 'og-image.png'), CANONICAL_OG);
		applyBranding({ buildDir, settings: settings({ theme: { preset: 'champagne-gold' } }) });
		expect(brandJson().og_image).toBeUndefined();
	});
	it('branded, but the picture could not be drawn → og_image: "shipped" (the page then shows none)', () => {
		// A shipped image that is not 1200 × 630 (its PNG header says 1000 wide):
		// nothing is drawn over it.
		const odd = Buffer.from(CANONICAL_OG);
		odd.writeUInt32BE(1000, 16);
		writeFileSync(join(buildDir, 'og-image.png'), odd);
		writeVerifyJson();
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		expect(brandJson().og_image).toBe('shipped');
	});
	it('the shipped picture (unbranded, or colours only) → no og_image field', () => {
		applyBranding({ buildDir, settings: settings({ theme: { preset: 'champagne-gold' } }) });
		expect(og().equals(CANONICAL_OG)).toBe(true);
		expect(brandJson().og_image).toBeUndefined();
		applyBranding({ buildDir, settings: settings({ brandName: 'Vigilante Trading' }) });
		applyBranding({ buildDir, settings: settings(), reset: true });
		expect(brandJson().og_image).toBeUndefined();
	});
});

describe('names in scripts the bundled fonts lack', () => {
	const NOTO = '/usr/share/fonts/opentype/noto';
	it.skipIf(!existsSync(NOTO))(
		'uses an installed font that has the letters (here: Noto CJK)',
		async () => {
			const og2 = await import('../src/lib/ogImage.ts');
			const name = '自由市场';
			const report = og2.glyphReport(name, { systemFontDirs: [NOTO] });
			expect(report.missing).toEqual([]);
			expect(report.extraFonts.length).toBeGreaterThan(0);
			for (const g of report.glyphs) expect(g.glyphId, g.char).toBeGreaterThan(0);
			writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
			process.env.MORPHIT_OG_FONT_DIRS = NOTO;
			const r = applyBranding({ buildDir, settings: settings({ brandName: name }) });
			expect(r.warnings.filter((w) => /og-image/.test(w))).toEqual([]);
			const img = decodePng(og());
			expect(count(img, { x0: 380, y0: 40, x1: 1150, y1: 235 }, white)).toBeGreaterThan(2000);
		}
	);
});

describe('on upgrade (self-heal) and with the instance origin', () => {
	it('a branded build still serving the shipped image gets its own, and the served bytes match', async () => {
		const { healBranding } = await import('../src/commands/upgrade.ts');
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		writeFileSync(
			join(installDir, 'morphit.config.env'),
			"MORPHIT_INSTANCE_BRAND_NAME='Vigilante Trading'\n"
		);
		// Branded by an older CLI: pages/logos branded, og-image still the shipped one.
		const webRoot = join(root, 'www');
		cpSync(buildDir, webRoot, { recursive: true });
		process.env.MORPHIT_INSTALL_DIR = installDir;
		process.env.MORPHIT_ETC_DIR = etcDir;
		process.env.MORPHIT_WEB_ROOT = webRoot;
		healBranding();
		const served = readFileSync(join(webRoot, 'og-image.png'));
		expect(served.equals(CANONICAL_OG)).toBe(false);
		expect(sha(served)).toBe(sha(og()));
		expect(pngText(served).Title).toBe('Vigilante Trading');
		expect(verifyMismatches(webRoot)).toEqual([]);
		// Stale vs the current branding (the name changed): regenerated on the next heal.
		writeFileSync(
			join(installDir, 'morphit.config.env'),
			"MORPHIT_INSTANCE_BRAND_NAME='Lima Exchange'\n"
		);
		healBranding();
		expect(pngText(readFileSync(join(webRoot, 'og-image.png'))).Title).toBe('Lima Exchange');
		expect(verifyMismatches(webRoot)).toEqual([]);
		// The web root lost its copy (the build is right, so branding changes
		// nothing): the heal reads the served hash and publishes it again.
		writeFileSync(join(webRoot, 'og-image.png'), CANONICAL_OG);
		healBranding();
		expect(sha(readFileSync(join(webRoot, 'og-image.png')))).toBe(sha(og()));
		expect(verifyMismatches(webRoot)).toEqual([]);
	});

	it('checkServedOgImage compares the served bytes with what the branding drew', async () => {
		const { checkServedOgImage } = await import('../src/lib/branding.ts');
		expect(checkServedOgImage(buildDir, null).ok).toBe(true); // shipped image, listed in verify.json
		expect(checkServedOgImage(buildDir, sha(Buffer.from('other'))).ok).toBe(false);
		expect(checkServedOgImage(buildDir, sha(CANONICAL_OG)).ok).toBe(true);
		writeFileSync(join(buildDir, 'og-image.png'), Buffer.from('tampered'));
		expect(checkServedOgImage(buildDir, null).ok).toBe(false);
	});

	it('the origin step (reset → origin → branding) leaves the image with the instance address', async () => {
		const io = await import('../src/lib/instanceOrigin.ts');
		mkdirSync(join(installDir, 'apps', 'web', 'scripts'), { recursive: true });
		cpSync(ORIGIN_SCRIPT, join(installDir, 'apps', 'web', 'scripts', 'origin-slots.mjs'));
		const rec = spawnSync(process.execPath, [ORIGIN_SCRIPT, 'record', buildDir], {
			encoding: 'utf8'
		});
		expect(rec.status, rec.stderr).toBe(0);
		writeVerifyJson();
		writeFileSync(join(brandDir, 'icon.svg'), ICON_SVG);
		writeFileSync(
			join(installDir, 'morphit.config.env'),
			"MORPHIT_INSTANCE_BRAND_NAME='Vigilante Trading'\n"
		);
		process.env.MORPHIT_ETC_DIR = etcDir;
		applyBranding({
			buildDir,
			settings: settings({ brandName: 'Vigilante Trading' })
		});
		const noPill = decodePng(og());
		const r = io.syncInstanceOrigin(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{
				installDir,
				buildDir,
				origin: { origin: 'https://vigilante.trading', why: 'test' },
				webRoot: null
			}
		);
		expect(r.strategy, r.detail).toMatch(/^applied/);
		const png = og();
		expect(pngText(png).Title).toBe('Vigilante Trading');
		expect(meanAbsDiff(noPill, decodePng(png), PILL)).toBeGreaterThan(10);
		expect(verifyMismatches()).toEqual([]);
	});
});
