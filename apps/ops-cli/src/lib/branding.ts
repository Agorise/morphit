/**
 * Per-instance BRANDING for the served frontend (docs/BRANDING.md).
 *
 * THE CONSTRAINT. Every federated operator serves the release's canonical,
 * prebuilt frontend byte-for-byte — that is what lets visitors' browsers verify
 * it against the on-chain release manifest (a local rebuild is not
 * byte-reproducible and trips the red tamper banner). So an operator can never
 * "rebuild with their own logo". Instead, the canonical build is designed to be
 * re-branded IN PLACE, touching only files the on-chain check does not cover:
 *
 *   /brand/site-logo.svg, /brand/site-logo-footer.svg   header+hero / footer logo
 *   /favicon.svg, /app-icon*.svg|png, /apple-touch-icon.png   icons
 *   /manifest.webmanifest                                     PWA name
 *   /brand/brand.json                                         brand for the SPA shell
 *   every prerendered page (.html)                            brand-name text slots
 *   anything under <branding dir>/static/                     free-form overlay
 *
 * NEVER touched (asserted on every write): index.html, service-worker*,
 * _app/**, verify.json's hashed bootstrap entries — i.e. everything on the
 * on-chain tamper manifest — plus the build markers.
 *
 * WHERE THE OPERATOR'S INPUT LIVES (survives upgrades — outside the install):
 *   /etc/morphit/branding/            (MORPHIT_BRANDING_DIR, or MORPHIT_ETC_DIR/branding)
 *     logo.svg          header + homepage hero
 *     logo-footer.svg   footer (defaults to logo.svg)
 *     icon.svg          favicon + app icons
 *     app-icon-192.png, app-icon-512.png, app-icon-maskable-512.png,
 *     apple-touch-icon.png   (optional — generated from icon.svg when the box
 *                             has rsvg-convert or ImageMagick)
 *     static/…          optional: any other static file, same relative path
 *   morphit.config.env
 *     MORPHIT_INSTANCE_BRAND_NAME, MORPHIT_INSTANCE_BRAND_SHORT_NAME,
 *     MORPHIT_INSTANCE_BETA_BADGE,
 *     MORPHIT_INSTANCE_THEME (preset) + MORPHIT_INSTANCE_THEME_FROM / _MID /
 *     _TO / _BACKGROUND (colour theme — every brand/surface colour is derived
 *     from these by @morphit/operator-config/theme)
 *
 * HOW. `applyBranding` computes the desired bytes of every overridable file from
 * the CANONICAL bytes (kept in <apps/web>/.brand-pristine the first time a file
 * is changed), writes only what differs, restores anything no longer branded,
 * regenerates the precompressed .gz/.br siblings nginx prefers, and updates the
 * served verify.json so its full-file manifest honestly describes what is
 * served (plus an `operator_branding` disclosure). Idempotent and reversible;
 * a fresh build (new release) simply starts from its own canonical files.
 *
 * Brand-name TEXT uses build/.brand-slots.json (written by
 * scripts/build-brand-slots.mjs): the exact offset of every place a prerendered
 * page names the SITE — software mentions of Morphit are never touched.
 *
 * COLOUR THEME: the compiled CSS (under _app/, integrity-covered) only ever
 * reads colours from CSS custom properties (apps/web/src/theme.css). A theme is
 * applied by (a) an `<style id="morphit-theme">html:root{--brand-1-rgb:…}</style>`
 * inserted at each prerendered page's 'theme-style' slot (just before </head>)
 * plus its 'theme-color' meta slot — right on first paint, with no JavaScript,
 * in Tor Browser; (b) a `theme` block in brand.json, which the SPA shell applies
 * at runtime; (c) the manifest's theme_color / background_color; and (d) the
 * canvas colour of icons/launch screens generated from the operator's SVGs.
 */

import {
	lchownSync,
	closeSync,
	constants as fsc,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import {
	DEFAULT_BRAND_NAME,
	brandForCompound,
	continuesAsCompound,
	sanitizeBrandName,
	INSTANCE_ENV
} from '@morphit/operator-config';
import {
	deriveTheme,
	themeStyleElement,
	themePreset,
	DEFAULT_THEME_PRESET,
	type ThemeInput,
	type ThemePalette
} from '@morphit/operator-config/theme';
import { impersonatesReservedOperatorName } from '../../../indexer/src/indexer/confusables.ts';
import { sanitizeSvg, HostileSvgError } from './svgSanitize.ts';

// ─── Constants ──────────────────────────────────────────────────────────

/** Written by scripts/build-brand-slots.mjs — keep in sync. */
export const BRAND_SLOTS_FILE = '.brand-slots.json';
/** The attributes build-brand-slots.mjs stamps on every prerendered <html>. */
export const CANONICAL_HTML_ATTRS = 'data-brand-name="Morphit" data-brand-beta="on"';

/** The app icons' / launch screens' canvas, as in the canonical icons (the
 *  theme token surface-page; a colour theme supplies its own). */
const ICON_BACKGROUND = '#0a0e16';

/** Files the operator may replace in place. Keep in sync with
 *  BRAND_OVERRIDABLE_PATHS in apps/web/src/lib/net/dynamicPaths.ts (served
 *  stale-while-revalidate by the service worker). */
export const BRAND_TARGETS = {
	siteLogo: 'brand/site-logo.svg',
	siteLogoFooter: 'brand/site-logo-footer.svg',
	brandJson: 'brand/brand.json',
	favicon: 'favicon.svg',
	appIconSvg: 'app-icon.svg',
	appIconMaskableSvg: 'app-icon-maskable.svg',
	manifest: 'manifest.webmanifest'
} as const;

/** PNG icons: [served path, pixel size, share of the canvas the icon fills]. */
export const PNG_ICONS: ReadonlyArray<readonly [string, number, number]> = [
	['app-icon-192.png', 192, 0.64],
	['app-icon-512.png', 512, 0.64],
	['app-icon-maskable-512.png', 512, 0.49],
	['apple-touch-icon.png', 180, 0.64]
];

/** iOS launch screens (build/splash/*.png): the logo is contain-fitted into
 *  the same centred box the Morphit wordmark occupies on the canonical images
 *  — 67.86% of the image width wide, 11.54% of the width tall — on the page
 *  background. Same height rule as the site: never stretched. */
export const SPLASH_DIR = 'splash';
export const SPLASH_LOGO_BOX = { width: 0.6786, height: 0.1154 } as const;

/** Extensions adapter-static precompresses (@sveltejs/kit builder). */
const COMPRESSIBLE = /\.(html|js|mjs|json|css|svg|xml|wasm|txt)$/;
/** What the static/ overlay may replace or add: images only. Anything that
 *  can carry script or styling (HTML/XHTML/XML/JS/CSS), fonts (a font can
 *  redraw digits, so amounts could display wrongly), text files (canary,
 *  PGP keys, robots, llms) and the generated brand.json / manifest are NOT
 *  overridable. SVGs pass through the same sanitizer as the logos. */
const STATIC_OVERLAY_EXT = /\.(png|jpe?g|webp|gif|ico|svg)$/i;
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_STATIC_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Paths branding must NEVER write — the on-chain tamper manifest covers
 * index.html, service-worker* and _app/immutable/entry/*; the rest of _app is
 * content-addressed code; verify.json and the markers are build metadata.
 */
export function isProtectedPath(rel: string): boolean {
	const r = rel.replace(/^\/+/, '');
	return (
		r === '' ||
		r.startsWith('index.html') ||
		r.startsWith('service-worker') ||
		r === '_app' ||
		r.startsWith('_app/') ||
		r.startsWith('verify.json') ||
		r === '.shipped' ||
		r === BRAND_SLOTS_FILE ||
		// The warrant canary and its signing keys are refreshed by their own
		// job (and restored on upgrade): branding must never shadow them.
		r.startsWith('canary.txt') ||
		r.startsWith('pgp_keys.asc') ||
		r.startsWith('fonts/') ||
		r.split('/').some((seg) => seg === '..' || seg === '.' || seg.startsWith('.'))
	);
}

// ─── Settings ───────────────────────────────────────────────────────────

export interface BrandingSettings {
	/** Sanitized brand name, or null for "Morphit" (unset or invalid). */
	readonly brandName: string | null;
	/** The raw value when it was set but rejected by sanitizeBrandName. */
	readonly invalidBrandName: string | null;
	readonly shortName: string | null;
	/** Explicit on/off, or null = automatic (off when a custom logo exists). */
	readonly betaBadge: 'on' | 'off' | null;
	/** Directory holding the operator's logo/icon files. */
	readonly dir: string;
	/** Colour-theme inputs, or null/absent for the Morphit colours. Validated
	 *  (derived) at apply time; an unusable one keeps the Morphit colours with
	 *  a warning, like an unusable name. */
	readonly theme?: ThemeInput | null;
}

/** /etc/morphit/branding, relocatable like the rest of /etc/morphit. */
export function brandingDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.MORPHIT_BRANDING_DIR) return env.MORPHIT_BRANDING_DIR;
	return join(env.MORPHIT_ETC_DIR ?? '/etc/morphit', 'branding');
}

/** The env files the services source, in their order (ops/systemd/
 *  morphit-indexer.service: morphit.env, morphit.config.env, then
 *  /etc/morphit/indexer.env — last one wins). Reading the same files in the same
 *  order keeps `branding apply` and the running indexer (RSS titles) agreeing
 *  on the name. */
export function brandConfigFiles(
	installDir: string,
	env: NodeJS.ProcessEnv = process.env
): string[] {
	const etc = env.MORPHIT_ETC_DIR ?? '/etc/morphit';
	return [
		join(installDir, 'morphit.env'),
		join(installDir, 'morphit.config.env'),
		join(etc, 'indexer.env')
	];
}

/** One value from an env-file line: `KEY=value`, `export KEY=value`, quoted or
 *  not; an unquoted value ends at ` #` (a trailing comment), as in bash. */
function parseEnvLineValue(raw: string): string {
	const v = raw.trim();
	const q = v[0];
	if ((q === '"' || q === "'") && v.length > 1) {
		const end = v.indexOf(q, 1);
		return end > 0 ? v.slice(1, end) : v.slice(1);
	}
	return v.replace(/\s+#.*$/, '').trim();
}

/** Read KEY from the on-disk config files; the OS environment wins; within the
 *  files the last non-empty value wins (same order the services source them). */
function readConfigValue(installDir: string, key: string, env: NodeJS.ProcessEnv): string | null {
	const fromEnv = env[key];
	if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
	let found: string | null = null;
	for (const f of brandConfigFiles(installDir, env)) {
		try {
			if (!existsSync(f)) continue;
			const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=(.*)$`, 'gm');
			const txt = readFileSync(f, 'utf8');
			let m: RegExpExecArray | null;
			while ((m = re.exec(txt)) !== null) {
				const v = parseEnvLineValue(m[1] ?? '');
				if (v !== '') found = v;
			}
		} catch {
			/* unreadable — skip */
		}
	}
	return found;
}

/**
 * Why a brand / short name cannot be used, or null if it can. Beyond the
 * character rules (sanitizeBrandName), a name must not impersonate the
 * project or its infrastructure accounts — the same confusable-aware rule the
 * federation directory applies to instance names ("Мorphit" with a Cyrillic
 * М, "morphit-fees", …). The plain default "Morphit" is not an impersonation:
 * it simply means "unbranded".
 */
export function brandNameProblem(raw: string): string | null {
	const clean = sanitizeBrandName(raw);
	if (clean === null) {
		return 'up to 48 visible characters, without { } # | < > " \\ * [ ] or backtick, "__", or invisible direction-control characters';
	}
	if (clean !== DEFAULT_BRAND_NAME && impersonatesReservedOperatorName(clean)) {
		return 'it imitates the Morphit project or one of its accounts';
	}
	return null;
}

/** A configured name as the build should use it: null for unset, invalid or
 *  plain "Morphit" (which is the unbranded default). */
function effectiveName(raw: string | null): { name: string | null; invalid: string | null } {
	if (raw === null) return { name: null, invalid: null };
	if (brandNameProblem(raw) !== null) return { name: null, invalid: raw };
	const clean = sanitizeBrandName(raw)!;
	return { name: clean === DEFAULT_BRAND_NAME ? null : clean, invalid: null };
}

export function readBrandingSettings(
	installDir: string,
	env: NodeJS.ProcessEnv = process.env
): BrandingSettings {
	const name = effectiveName(readConfigValue(installDir, INSTANCE_ENV.BRAND_NAME, env));
	const short = effectiveName(readConfigValue(installDir, INSTANCE_ENV.BRAND_SHORT_NAME, env));
	const beta = (readConfigValue(installDir, INSTANCE_ENV.BETA_BADGE, env) ?? '').toLowerCase();
	const themeIn: ThemeInput = {
		preset: readConfigValue(installDir, INSTANCE_ENV.THEME, env),
		from: readConfigValue(installDir, INSTANCE_ENV.THEME_FROM, env),
		mid: readConfigValue(installDir, INSTANCE_ENV.THEME_MID, env),
		to: readConfigValue(installDir, INSTANCE_ENV.THEME_TO, env),
		background: readConfigValue(installDir, INSTANCE_ENV.THEME_BACKGROUND, env),
		button: readConfigValue(installDir, INSTANCE_ENV.THEME_BUTTON, env)
	};
	return {
		brandName: name.name,
		invalidBrandName: name.invalid ?? short.invalid,
		shortName: short.name,
		betaBadge: ['on', 'true', '1', 'yes'].includes(beta)
			? 'on'
			: ['off', 'false', '0', 'no'].includes(beta)
				? 'off'
				: null,
		dir: brandingDir(env),
		theme: themeSettingOf(themeIn)
	};
}

/** Null when nothing is configured, or when it is exactly the default preset
 *  with no colour overrides ("morphit" means "not themed"). */
export function themeSettingOf(t: ThemeInput): ThemeInput | null {
	const set = (v: string | null | undefined): boolean =>
		v !== undefined && v !== null && v.trim() !== '';
	const colours = set(t.from) || set(t.mid) || set(t.to) || set(t.background) || set(t.button);
	const preset = set(t.preset) ? t.preset!.trim().toLowerCase() : null;
	if (!colours && (preset === null || preset === DEFAULT_THEME_PRESET)) return null;
	return {
		preset,
		from: set(t.from) ? t.from!.trim() : null,
		mid: set(t.mid) ? t.mid!.trim() : null,
		to: set(t.to) ? t.to!.trim() : null,
		background: set(t.background) ? t.background!.trim() : null,
		button: set(t.button) ? t.button!.trim().toLowerCase() : null
	};
}

/** The palette a theme setting yields: the palette, the problems that make it
 *  unusable, or null for "Morphit colours" (unset or the default). */
export function resolveTheme(theme: ThemeInput | null | undefined): {
	palette: ThemePalette | null;
	problems: readonly string[];
} {
	if (theme === null || theme === undefined) return { palette: null, problems: [] };
	// Colours without a preset build on the default preset's background.
	const r = deriveTheme(theme);
	if (!r.ok) return { palette: null, problems: r.problems };
	return { palette: r.palette.isDefault ? null : r.palette, problems: [] };
}

/** Short human description of a theme setting (status / notes). */
export function describeTheme(
	theme: ThemeInput | null | undefined,
	palette: ThemePalette | null
): string {
	if (theme === null || theme === undefined || palette === null) return 'Morphit colours (default)';
	const i = palette.inputs;
	const name = i.preset !== null && themePreset(i.preset) !== null ? `${i.preset}: ` : 'custom: ';
	return `${name}${i.from} → ${i.mid} → ${i.to} on ${i.background}, ${i.button} buttons`;
}

/** The operator files `morphit-ops branding apply --logo/--logo-footer/--icon`
 *  can install, by flag. */
export const BRANDING_FILE_FLAGS = {
	logo: 'logo.svg',
	'logo-footer': 'logo-footer.svg',
	icon: 'icon.svg'
} as const;

/**
 * Copy an operator's SVG into the branding directory under its fixed name,
 * after validating it exactly as `apply` will (so a bad file is refused here,
 * with the reason, not half-way through an apply). The original bytes are
 * kept; `apply` adds the viewBox etc. to the served copy. Returns the path.
 */
export function installBrandingFile(dir: string, name: string, source: string): string {
	if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`${source}: no such file`);
	const buf = readFileSync(source);
	normalizeSvg(buf, source);
	mkdirSync(dir, { recursive: true, mode: 0o755 });
	if (lstatSync(dir).isSymbolicLink())
		throw new Error(`${dir} is a symbolic link — refusing to write into it`);
	const dest = join(dir, name);
	atomicWrite(dest, buf, 0o644);
	return dest;
}

/**
 * Write `data` to `dest` without ever following a link planted at `dest`: a
 * fresh temporary file in the same directory (created with O_EXCL, so it
 * cannot pre-exist as a link), fsync'd, then renamed over `dest` — rename
 * replaces a link itself, never its target, and nginx never serves a
 * half-written file.
 */
export function atomicWrite(dest: string, data: Buffer | string, mode = 0o644): void {
	const tmp = join(dirname(dest), `.${randomBytes(6).toString('hex')}.brand-tmp`);
	const fd = openSync(tmp, 'wx', mode);
	try {
		const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
		let off = 0;
		while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
		fsyncSync(fd);
	} catch (err) {
		closeSync(fd);
		rmSync(tmp, { force: true });
		throw err;
	}
	closeSync(fd);
	renameSync(tmp, dest);
}

/** True when the operator configured ANY branding (so callers can announce the
 *  apply step, which recompresses every page and takes a little while). */
export function brandingConfigured(s: BrandingSettings): boolean {
	if (s.brandName !== null || s.invalidBrandName !== null || s.betaBadge !== null) return true;
	if (s.theme !== null && s.theme !== undefined) return true;
	try {
		return existsSync(s.dir) && readdirSync(s.dir).some((n) => !n.startsWith('.'));
	} catch {
		return false;
	}
}

// ─── SVG handling ───────────────────────────────────────────────────────

export interface NormalizedSvg {
	readonly svg: string;
	readonly width: number;
	readonly height: number;
	readonly viewBox: string;
	/** Harmless content the sanitizer dropped (reported to the operator). */
	readonly removed: readonly string[];
}

function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
	return m ? (m[2] ?? m[3] ?? '') : null;
}

function setAttr(tag: string, name: string, value: string): string {
	const re = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`, 'i');
	if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
	return tag.replace(/^<svg\b/i, `<svg ${name}="${value}"`);
}

function removeAttr(tag: string, name: string): string {
	return tag.replace(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'gi'), '');
}

/** "357", "357px" → 357; any other unit → null. */
function pxLength(v: string | null): number | null {
	if (v === null) return null;
	const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(v);
	return m ? Number(m[1]) : null;
}

/**
 * Validate an operator-supplied SVG and make it safe + well-formed for every
 * placement. The file is served on the site's own origin — opened directly it
 * is a document — so it goes through an allowlist sanitizer (./svgSanitize.ts):
 * hostile content (script in any spelling, embedded HTML, animation, event
 * handlers, references to other files or sites, CSS escapes/@import) refuses
 * the file; editor metadata is dropped. Then: a viewBox so it SCALES in <img>
 * and CSS masks in every engine, and pixel width/height so `naturalWidth`
 * works (the favicon notification badge fits the icon by it). The drawing
 * itself is kept exactly.
 */
export function normalizeSvg(source: string | Buffer, label: string): NormalizedSvg {
	const buf = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
	if (buf.length > MAX_SVG_BYTES)
		throw new Error(`${label}: larger than ${MAX_SVG_BYTES / 1024 / 1024} MB`);
	const raw = buf.toString('utf8');
	if (!Buffer.from(raw, 'utf8').equals(buf)) {
		throw new Error(`${label}: not UTF-8 text — save it as a plain (UTF-8) SVG file`);
	}
	let san;
	try {
		san = sanitizeSvg(raw, label);
	} catch (err) {
		if (err instanceof HostileSvgError) throw new Error(err.message);
		throw err;
	}
	let text = san.svg;
	const open = /^<svg\b[^>]*>/.exec(text);
	if (!open || open[0].endsWith('/>') || text.lastIndexOf('</svg>') < open.index)
		throw new Error(`${label}: not an SVG drawing (empty or not an <svg> document)`);
	let tag = open[0];
	let viewBox = attr(tag, 'viewBox');
	let w = pxLength(attr(tag, 'width'));
	let h = pxLength(attr(tag, 'height'));
	const vb =
		viewBox === null
			? null
			: viewBox
					.trim()
					.split(/[\s,]+/)
					.map(Number);
	if (
		vb !== null &&
		(vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2]! <= 0 || vb[3]! <= 0)
	) {
		throw new Error(`${label}: malformed viewBox "${viewBox}"`);
	}
	if (vb === null) {
		if (w === null || h === null || w <= 0 || h <= 0) {
			throw new Error(`${label}: needs a viewBox, or width/height in pixels, so it can be scaled`);
		}
		viewBox = `0 0 ${w} ${h}`;
		tag = setAttr(tag, 'viewBox', viewBox);
	}
	if (w === null || h === null) {
		// Non-pixel or missing size → take the viewBox's (keeps the aspect ratio).
		w = vb ? vb[2]! : w!;
		h = vb ? vb[3]! : h!;
		tag = setAttr(setAttr(tag, 'width', String(w)), 'height', String(h));
	}
	text = text.slice(0, open.index) + tag + text.slice(open.index + open[0].length);
	return { svg: text, width: w, height: h, viewBox: viewBox!, removed: san.removed };
}

/**
 * A square app icon: the operator's icon centred on the dark page background,
 * filling `fill` (0–1) of the canvas — the same proportions as Morphit's own
 * icons (64% for "any", 49% inside the maskable safe zone). The icon is nested
 * as an <svg> with its own viewBox, so its drawing is never distorted.
 */
export function composeAppIconSvg(
	icon: NormalizedSvg,
	size: number,
	fill: number,
	background: string = ICON_BACKGROUND
): string {
	const open = /<svg\b[^>]*>/i.exec(icon.svg)!;
	const inner = icon.svg.slice(open.index + open[0].length, icon.svg.lastIndexOf('</svg>'));
	let tag = open[0];
	// Namespace declarations move to the outer root; sizing is ours.
	const nsDecls = [...tag.matchAll(/\sxmlns:[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*')/gi)]
		.map((m) => m[0])
		.join('');
	for (const a of [
		'xmlns',
		'width',
		'height',
		'x',
		'y',
		'viewBox',
		'preserveAspectRatio',
		'version'
	])
		tag = removeAttr(tag, a);
	tag = tag.replace(/\sxmlns:[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
	const box = Math.round(size * fill * 100) / 100;
	const off = Math.round(((size - box) / 2) * 100) / 100;
	const nested = tag.replace(
		/^<svg\b/i,
		`<svg x="${off}" y="${off}" width="${box}" height="${box}" viewBox="${icon.viewBox}" preserveAspectRatio="xMidYMid meet"`
	);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg"${nsDecls} width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
		`<rect width="${size}" height="${size}" fill="${background}"/>` +
		nested +
		inner +
		'</svg></svg>\n'
	);
}

/**
 * An iOS launch screen: the operator's logo, contain-fitted (never distorted)
 * into SPLASH_LOGO_BOX, centred on the dark page background, width×height.
 */
export function composeSplashSvg(
	logo: NormalizedSvg,
	width: number,
	height: number,
	background: string = ICON_BACKGROUND
): string {
	const open = /<svg\b[^>]*>/i.exec(logo.svg)!;
	const inner = logo.svg.slice(open.index + open[0].length, logo.svg.lastIndexOf('</svg>'));
	const nsDecls = [...open[0].matchAll(/\sxmlns:[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*')/gi)]
		.map((m) => m[0])
		.join('');
	const round = (n: number): number => Math.round(n * 100) / 100;
	const bw = round(width * SPLASH_LOGO_BOX.width);
	const bh = round(width * SPLASH_LOGO_BOX.height);
	const x = round((width - bw) / 2);
	const y = round((height - bh) / 2);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg"${nsDecls} width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
		`<rect width="${width}" height="${height}" fill="${background}"/>` +
		`<svg x="${x}" y="${y}" width="${bw}" height="${bh}" viewBox="${logo.viewBox}" preserveAspectRatio="xMidYMid meet">` +
		inner +
		'</svg></svg>\n'
	);
}

/** PNG pixel size from the IHDR chunk, or null if not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Rasterize an SVG to a width×height PNG (square when height is omitted) with
 *  whatever the box has (rsvg-convert preferred, then ImageMagick). Null when
 *  neither works. */
export function rasterizeSvg(svg: string, size: number, height: number = size): Buffer | null {
	const geometry = `${size}x${height}!`;
	const attempts: Array<[string, string[]]> = [
		['rsvg-convert', ['-w', String(size), '-h', String(height), '-f', 'png']],
		// -strip + no date/time chunks: ImageMagick otherwise stamps every PNG
		// with the time, so the same input never produced the same bytes and
		// every status/apply/upgrade saw "changes" and rewrote the icons.
		[
			'magick',
			[
				'-background',
				'none',
				'-density',
				'300',
				'svg:-',
				'-resize',
				geometry,
				'-strip',
				'-define',
				'png:exclude-chunks=date,time',
				'png:-'
			]
		],
		[
			'convert',
			[
				'-background',
				'none',
				'-density',
				'300',
				'svg:-',
				'-resize',
				geometry,
				'-strip',
				'-define',
				'png:exclude-chunks=date,time',
				'png:-'
			]
		]
	];
	for (const [cmd, args] of attempts) {
		try {
			const r = spawnSync(cmd, args, { input: svg, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
			if (r.status !== 0 || !r.stdout || r.stdout.length === 0) continue;
			const dim = pngSize(r.stdout);
			if (dim && dim.width === size && dim.height === height) return r.stdout;
		} catch {
			/* tool missing — try the next */
		}
	}
	return null;
}

// ─── Text helpers ───────────────────────────────────────────────────────

export function htmlEscape(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

type Slot = [
	offset: number,
	length: number,
	form: string,
	ctx: 'html' | 'raw' | 'theme-color' | 'theme-style'
];

/**
 * build/.brand-slots.json. `files`: site-name slots only (the v1.19 shape — an
 * older ops-cli reads it during an upgrade). `theme_files` (schema 2): the
 * colour-theme slots, which only this CLI knows.
 */
export interface SlotMap {
	readonly files: Record<string, Slot[]>;
	readonly theme_files?: Record<string, Slot[]>;
}

/** Every page's name + theme slots, merged in document order. */
export function pageSlots(map: SlotMap): Array<[string, Slot[]]> {
	const out = new Map<string, Slot[]>();
	for (const [rel, slots] of Object.entries(map.files)) out.set(rel, [...slots]);
	for (const [rel, slots] of Object.entries(map.theme_files ?? {})) {
		// A theme slot on a page without a name entry is ignored: the name map
		// is the list of pages branding may rewrite.
		const cur = out.get(rel);
		if (cur !== undefined) cur.push(...slots);
	}
	return [...out].map(([rel, s]) => [rel, s.sort((a, b) => a[0] - b[0])]);
}

/** What a colour theme writes into a prerendered page. */
export interface PageTheme {
	/** The complete `<style id="morphit-theme">…</style>` element. */
	readonly style: string;
	/** '#rrggbb' for the theme-color meta. */
	readonly color: string;
}

/**
 * Brand one prerendered page: every recorded slot → the brand (HTML-escaped in
 * markup, verbatim inside raw <script>/<style> text — the name is sanitized to
 * contain nothing that needs escaping there), and the <html> data attributes.
 * Throws if the page no longer matches its slot map (not the canonical page).
 */
export function brandPage(
	canonical: string,
	slots: readonly Slot[],
	brandName: string | null,
	beta: boolean,
	theme: PageTheme | null = null
): string {
	let out = canonical;
	// Last slot first, so earlier offsets stay valid.
	for (let i = slots.length - 1; i >= 0; i--) {
		const [off, len, form, ctx] = slots[i]!;
		if (ctx === 'theme-style') {
			if (theme === null) continue;
			if (!/^<\/head\s*>/i.test(out.slice(off, off + 7)))
				throw new Error(`slot ${i} (theme style) is not at </head>`);
			out = out.slice(0, off) + theme.style + out.slice(off);
			continue;
		}
		// Only slots that change are verified (an unbranded name slot is left
		// alone, as before colour themes existed).
		const want = ctx === 'theme-color' ? (theme?.color ?? null) : brandName;
		if (want === null) continue;
		if (out.slice(off, off + len) !== form) {
			throw new Error(`slot ${i} is "${out.slice(off, off + len)}", expected "${form}"`);
		}
		if (ctx === 'theme-color' || brandName === null) {
			out = out.slice(0, off) + want + out.slice(off + len);
			continue;
		}
		// A compound word ("{brand}-Passwort") gets the name hyphenated
		// throughout — exactly what the browser's applyBrandToString writes.
		const text = continuesAsCompound(out, off + len) ? brandForCompound(brandName) : brandName;
		out = out.slice(0, off) + (ctx === 'raw' ? text : htmlEscape(text)) + out.slice(off + len);
	}
	const attrs = `data-brand-name="${htmlEscape(brandName ?? DEFAULT_BRAND_NAME)}" data-brand-beta="${beta ? 'on' : 'off'}"`;
	if (attrs !== CANONICAL_HTML_ATTRS) {
		const at = out.indexOf(CANONICAL_HTML_ATTRS);
		const htmlTag = /<html\b[^>]*>/i.exec(out);
		if (at < 0 || !htmlTag || at < htmlTag.index || at > htmlTag.index + htmlTag[0].length) {
			throw new Error('the <html> tag does not carry the canonical brand attributes');
		}
		out = out.slice(0, at) + attrs + out.slice(at + CANONICAL_HTML_ATTRS.length);
	}
	return out;
}

function sha256Hex(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}

/** Same parameters as adapter-static (so nginx's gzip_static/brotli_static
 *  never serve a stale pre-compressed copy of a re-branded file). */
function compressed(buf: Buffer): { gz: Buffer; br: Buffer } {
	return {
		gz: gzipSync(buf, { level: zc.Z_BEST_COMPRESSION }),
		br: brotliCompressSync(buf, {
			params: {
				[zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT,
				[zc.BROTLI_PARAM_QUALITY]: zc.BROTLI_MAX_QUALITY,
				[zc.BROTLI_PARAM_SIZE_HINT]: buf.length
			}
		})
	};
}

// ─── Safe file access under a root we write as root ──────────────────────
//
// The build directory is handed to a non-root owner during upgrades (the
// warrant-canary upload target), and a web root may belong to the web server.
// Branding runs as root, so nothing it reads or writes may be reached through
// a symbolic link planted inside those trees: every path component below the
// root is lstat'ed, and writes go through atomicWrite (O_EXCL temp + rename).

/** Throw unless every existing component of root/rel is a real directory (or,
 *  for the last, a regular file) — no symbolic links anywhere. */
function assertNoLinks(root: string, rel: string): void {
	const parts = rel.split('/').filter((p) => p.length > 0);
	if (parts.some((p) => p === '..' || p === '.')) throw new Error(`unsafe path ${rel}`);
	let cur = root;
	for (let i = 0; i < parts.length; i++) {
		cur = join(cur, parts[i]!);
		let st;
		try {
			st = lstatSync(cur);
		} catch {
			return; // does not exist yet — nothing below can be a link either
		}
		if (st.isSymbolicLink()) throw new Error(`${cur} is a symbolic link — refusing to follow it`);
		if (i < parts.length - 1 && !st.isDirectory()) throw new Error(`${cur} is not a directory`);
	}
}

function safeRead(root: string, rel: string, maxBytes = Infinity): Buffer | null {
	assertNoLinks(root, rel);
	const p = join(root, rel);
	// O_NOFOLLOW: a link swapped in after the check above is refused by the
	// kernel instead of followed (root must never publish, say, /etc/shadow).
	let fd: number;
	try {
		fd = openSync(p, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return null;
		if (st.size > maxBytes) throw new RangeError(`${p}: larger than ${maxBytes} bytes`);
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

function safeMkdirs(root: string, relDir: string): void {
	let cur = root;
	for (const part of relDir.split('/').filter((x) => x.length > 0)) {
		cur = join(cur, part);
		if (!existsSync(cur)) mkdirSync(cur, { mode: 0o755 });
		const st = lstatSync(cur);
		if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} is not a real directory`);
	}
}

/** Write root/rel safely. `inheritOwner`: give the file its directory's owner
 *  (the build dir may belong to the canary-upload account). */
function safeWrite(root: string, rel: string, data: Buffer, inheritOwner = false): void {
	assertNoLinks(root, rel);
	safeMkdirs(root, posix.dirname(rel) === '.' ? '' : posix.dirname(rel));
	const dest = join(root, rel);
	atomicWrite(dest, data);
	if (inheritOwner) matchOwner(dest, dirname(dest));
}

function safeUnlink(root: string, rel: string): boolean {
	assertNoLinks(root, posix.dirname(rel) === '.' ? '' : posix.dirname(rel));
	const p = join(root, rel);
	try {
		lstatSync(p);
	} catch {
		return false;
	}
	unlinkSync(p); // removes a link itself, never its target
	return true;
}

function walkFiles(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = lstatSync(full);
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) out.push(...walkFiles(full, base));
		else if (st.isFile()) out.push(relative(base, full).split(sep).join('/'));
	}
	return out;
}

// ─── Plan ───────────────────────────────────────────────────────────────

export interface BrandingPlan {
	/** rel path → desired bytes (only files that differ from canonical). */
	readonly files: Map<string, Buffer>;
	readonly brandName: string | null;
	readonly beta: boolean;
	readonly active: boolean;
	readonly warnings: string[];
	readonly notes: string[];
	/** Some PNGs could not be made: no rsvg-convert / ImageMagick on this box. */
	readonly rasterizerMissing: boolean;
	/** The applied colour theme, or null for the Morphit colours. */
	readonly theme: ThemePalette | null;
}

export interface BrandingState {
	schema: 1;
	/** Identifies the canonical build these originals belong to. */
	build_id: string;
	/** Build files branding changed; their canonical bytes are in files/. */
	modified: string[];
	/** Build files branding added (no canonical version). */
	added: string[];
}

export interface BrandingPaths {
	readonly buildDir: string;
	readonly pristineDir: string;
	readonly lockFile: string;
}

export function brandingPaths(buildDir: string): BrandingPaths {
	return {
		buildDir,
		pristineDir: join(dirname(buildDir), '.brand-pristine'),
		lockFile: join(dirname(buildDir), '.branding.lock')
	};
}

/** A canonical build's identity: its slot map plus its SPA shell (which
 *  branding never touches and which changes with every build). */
function buildIdOf(paths: BrandingPaths): string {
	const h = createHash('sha256');
	h.update(safeRead(paths.buildDir, BRAND_SLOTS_FILE) ?? Buffer.alloc(0));
	h.update(safeRead(paths.buildDir, 'index.html') ?? Buffer.alloc(0));
	return h.digest('hex');
}

function listPristine(paths: BrandingPaths): string[] {
	const dir = join(paths.pristineDir, 'files');
	if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return [];
	return walkFiles(dir).filter(
		(r) => !/\.(gz|br)$/.test(r) || !existsSync(join(dir, r.replace(/\.(gz|br)$/, '')))
	);
}

/**
 * The saved state, or a fresh one. Recovery: originals are saved (and
 * state.json written) BEFORE any build file changes, so an apply interrupted
 * at any point leaves either (a) state.json listing everything it may have
 * touched, or (b) no state.json and only untouched originals in files/ — which
 * are rebuilt into the list here. Originals of a DIFFERENT build (the build
 * was replaced in place) are discarded — but never by a dry run.
 */
function loadState(paths: BrandingPaths, buildId: string, dryRun: boolean): BrandingState {
	const empty: BrandingState = { schema: 1, build_id: buildId, modified: [], added: [] };
	if (!existsSync(paths.pristineDir)) return empty;
	if (lstatSync(paths.pristineDir).isSymbolicLink()) {
		throw new Error(`${paths.pristineDir} is a symbolic link — refusing to use it`);
	}
	const stateBuf = safeRead(paths.pristineDir, 'state.json');
	let parsed: Partial<BrandingState> | null = null;
	try {
		parsed =
			stateBuf === null ? null : (JSON.parse(stateBuf.toString('utf8')) as Partial<BrandingState>);
	} catch {
		parsed = null;
	}
	if (
		parsed !== null &&
		parsed.schema === 1 &&
		parsed.build_id !== undefined &&
		parsed.build_id !== buildId
	) {
		if (!dryRun) rmSync(paths.pristineDir, { recursive: true, force: true });
		return empty;
	}
	const saved = listPristine(paths);
	const modified = new Set<string>([...(parsed?.modified ?? []), ...saved]);
	for (const rel of [...modified]) {
		if (isProtectedPath(rel)) modified.delete(rel);
	}
	const added = (parsed?.added ?? []).filter((r) => !isProtectedPath(r) && !modified.has(r));
	return { ...empty, modified: [...modified].sort(), added: added.sort() };
}

function saveState(paths: BrandingPaths, state: BrandingState): void {
	safeMkdirs(dirname(paths.pristineDir), posix.basename(paths.pristineDir));
	atomicWrite(join(paths.pristineDir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 0o600);
}

/** The canonical (as-shipped) bytes of a build file, or null if the canonical
 *  build does not have it. */
function canonicalBytes(paths: BrandingPaths, state: BrandingState, rel: string): Buffer | null {
	if (state.added.includes(rel)) return null;
	if (state.modified.includes(rel)) return safeRead(join(paths.pristineDir, 'files'), rel);
	return safeRead(paths.buildDir, rel);
}

/** Everything the operator configured, turned into desired file bytes. */
export function planBranding(
	paths: BrandingPaths,
	settings: BrandingSettings,
	state: BrandingState,
	slotMap: SlotMap
): BrandingPlan {
	const files = new Map<string, Buffer>();
	const warnings: string[] = [];
	const notes: string[] = [];
	const dir = settings.dir;
	// Operator inputs: regular files only, never reached through a link.
	const has = (name: string): boolean => {
		try {
			assertNoLinks(dir, name);
			return lstatSync(join(dir, name)).isFile();
		} catch {
			return false;
		}
	};
	const readInput = (name: string): Buffer => {
		const b = existsSync(dir) ? safeRead(dir, name) : null;
		if (b === null) throw new Error(`${join(dir, name)}: not a regular file`);
		return b;
	};
	const svgInput = (name: string, label = name): NormalizedSvg => {
		const n = normalizeSvg(readInput(name), label);
		if (n.removed.length > 0) {
			notes.push(`${label}: left out ${n.removed.join(', ')} (not part of a logo drawing)`);
		}
		return n;
	};
	const canon = (rel: string): Buffer | null => canonicalBytes(paths, state, rel);
	const put = (rel: string, buf: Buffer): void => {
		if (isProtectedPath(rel)) throw new Error(`refusing to write protected path ${rel}`);
		files.set(rel, buf);
	};

	if (settings.invalidBrandName !== null) {
		warnings.push(
			`The site name "${settings.invalidBrandName}" is not usable: ${brandNameProblem(settings.invalidBrandName) ?? 'invalid'}. ` +
				'Keeping "Morphit". Fix it and re-run: sudo morphit-ops branding apply --name "…"'
		);
	}

	// Colour theme.
	const themeRes = resolveTheme(settings.theme);
	const palette = themeRes.palette;
	if (themeRes.problems.length > 0) {
		warnings.push(
			`The colour theme is not usable: ${themeRes.problems.join('; ')}. Keeping the Morphit colours. ` +
				"Fix it and re-run: sudo morphit-ops branding apply --theme-from '#…' --theme-to '#…'"
		);
	}
	const canvas = palette !== null ? palette.tokens['surface-page']! : ICON_BACKGROUND;
	const pageTheme: PageTheme | null =
		palette === null
			? null
			: { style: themeStyleElement(palette), color: palette.tokens['brand-2']! };

	// PNGs this box could not rasterize (no rsvg-convert / ImageMagick).
	const missingPngs: string[] = [];

	// Logos.
	const customLogo = has('logo.svg');
	if (customLogo) {
		const logo = svgInput('logo.svg');
		put(BRAND_TARGETS.siteLogo, Buffer.from(logo.svg));
		const footer = has('logo-footer.svg') ? svgInput('logo-footer.svg') : logo;
		put(BRAND_TARGETS.siteLogoFooter, Buffer.from(footer.svg));
		notes.push(
			`logo: header + homepage hero ← logo.svg; footer ← ${has('logo-footer.svg') ? 'logo-footer.svg' : 'logo.svg'}`
		);
		// iOS launch screens, at the canonical images' own pixel sizes.
		const splashMissing: string[] = [];
		let splashDone = 0;
		const splashAbs = join(paths.buildDir, SPLASH_DIR);
		assertNoLinks(paths.buildDir, SPLASH_DIR);
		const splashRels = existsSync(splashAbs)
			? readdirSync(splashAbs)
					.filter((n) => n.endsWith('.png'))
					.sort()
					.map((n) => `${SPLASH_DIR}/${n}`)
			: [];
		let rasterizerMissing = false;
		for (const rel of splashRels) {
			if (has(`static/${rel}`)) continue; // the operator's own image wins (static/ overlay)
			const c = canon(rel);
			const dim = c === null ? null : pngSize(c);
			if (dim === null) continue;
			const png = rasterizerMissing
				? null
				: rasterizeSvg(
						composeSplashSvg(logo, dim.width, dim.height, canvas),
						dim.width,
						dim.height
					);
			if (png) {
				put(rel, png);
				splashDone++;
			} else {
				rasterizerMissing = true;
				splashMissing.push(rel);
			}
		}
		if (splashDone > 0) notes.push(`launch screens: ${splashDone} iPhone/iPad images ← logo.svg`);
		if (splashMissing.length > 0)
			missingPngs.push(`the ${splashMissing.length} iPhone/iPad launch screens`);
	} else if (has('logo-footer.svg')) {
		const footer = svgInput('logo-footer.svg');
		put(BRAND_TARGETS.siteLogoFooter, Buffer.from(footer.svg));
		notes.push(
			'logo: footer ← logo-footer.svg (header + hero keep the Morphit logo — add logo.svg)'
		);
	}

	// Icons.
	if (has('icon.svg')) {
		const icon = svgInput('icon.svg');
		put(BRAND_TARGETS.favicon, Buffer.from(icon.svg));
		put(BRAND_TARGETS.appIconSvg, Buffer.from(composeAppIconSvg(icon, 512, 0.64, canvas)));
		put(BRAND_TARGETS.appIconMaskableSvg, Buffer.from(composeAppIconSvg(icon, 512, 0.49, canvas)));
		const missing: string[] = [];
		for (const [rel, size, fill] of PNG_ICONS) {
			if (has(rel)) {
				const buf = readInput(rel);
				const dim = pngSize(buf);
				if (!dim) throw new Error(`${rel}: not a PNG file`);
				if (dim.width !== size || dim.height !== size) {
					warnings.push(
						`${rel} is ${dim.width}×${dim.height}; it should be ${size}×${size} (used anyway)`
					);
				}
				put(rel, buf);
				continue;
			}
			const png = rasterizeSvg(composeAppIconSvg(icon, size, fill, canvas), size);
			if (png) put(rel, png);
			else missing.push(rel);
		}
		notes.push('icons: favicon + app icons ← icon.svg');
		if (missing.length > 0) missingPngs.unshift(missing.join(', '));
	} else {
		for (const [rel] of PNG_ICONS) {
			if (has(rel)) {
				const buf = readInput(rel);
				if (!pngSize(buf)) throw new Error(`${rel}: not a PNG file`);
				put(rel, buf);
			}
		}
	}

	if (missingPngs.length > 0) {
		warnings.push(
			`Could not generate ${missingPngs.join(' and ')} (this server has neither rsvg-convert nor ` +
				'ImageMagick), so those still show the Morphit mark. Install one — sudo apt install librsvg2-bin — ' +
				`and run \`sudo morphit-ops branding apply\` again, or put ready-made PNGs of the same names and ` +
				`sizes in ${dir} (launch screens under ${dir}/static/splash/).`
		);
	}

	// Image overlay (applied last: wins over the generated images). Images
	// only — see STATIC_OVERLAY_EXT for why nothing else may be replaced.
	const staticDir = join(dir, 'static');
	const staticOk = ((): boolean => {
		try {
			assertNoLinks(dir, 'static');
			return lstatSync(staticDir).isDirectory();
		} catch {
			return false;
		}
	})();
	if (staticOk) {
		for (const rel of walkFiles(staticDir)) {
			if (isProtectedPath(rel) || !STATIC_OVERLAY_EXT.test(rel)) {
				warnings.push(
					`static/${rel}: only images (.png .jpg .webp .gif .ico .svg) can be replaced, and not the build's own protected files — skipped`
				);
				continue;
			}
			let buf: Buffer | null;
			try {
				buf = safeRead(staticDir, rel, MAX_STATIC_BYTES);
			} catch (e) {
				if (!(e instanceof RangeError)) throw e;
				warnings.push(`static/${rel}: larger than 10 MB — skipped`);
				continue;
			}
			if (buf === null) {
				warnings.push(`static/${rel}: not a regular file — skipped`);
				continue;
			}
			if (rel.endsWith('.svg')) {
				put(rel, Buffer.from(svgInput(`static/${rel}`).svg));
			} else {
				put(rel, buf);
			}
			notes.push(`static: ${rel}`);
		}
	}

	// Brand name + BETA marker.
	const brandName = settings.brandName;
	const beta = settings.betaBadge === null ? !customLogo : settings.betaBadge === 'on';
	const brandDoc: Record<string, unknown> = {
		schema: 1,
		name: brandName ?? DEFAULT_BRAND_NAME,
		beta_badge: beta
	};
	if (palette !== null) {
		// Applied by the SPA shell (apps/web/src/lib/brand/brand.ts applyTheme);
		// prerendered pages carry the same values in their theme <style> slot.
		brandDoc.theme = {
			preset: palette.inputs.preset,
			inputs: {
				from: palette.inputs.from,
				mid: palette.inputs.mid,
				to: palette.inputs.to,
				background: palette.inputs.background,
				button: palette.inputs.button
			},
			tokens: palette.tokens,
			grid_opacity: palette.gridOpacity
		};
		notes.push(`colour theme: ${describeTheme(settings.theme, palette)}`);
		if (palette.adjusted.length > 0) {
			notes.push(
				`  (lifted for readable contrast on your background: ${palette.adjusted.join(', ')})`
			);
		}
	}
	const brandJson = JSON.stringify(brandDoc, null, '\t') + '\n';
	put(BRAND_TARGETS.brandJson, Buffer.from(brandJson));
	if (brandName !== null)
		notes.push(`brand name: "${brandName}" (every place the UI names the site)`);
	notes.push(
		`BETA marker: ${beta ? 'on' : 'off'}${settings.betaBadge === null ? ' (automatic)' : ''}`
	);

	if (brandName !== null || settings.shortName !== null || palette !== null) {
		const m = canon(BRAND_TARGETS.manifest);
		if (m !== null) {
			const manifest = JSON.parse(m.toString('utf8')) as Record<string, unknown>;
			if (brandName !== null) manifest.name = brandName;
			manifest.short_name = settings.shortName ?? brandName ?? manifest.short_name;
			if (palette !== null) {
				// Android's splash + title bar colours (the manifest is not on the
				// on-chain tamper manifest — branding already rewrites it).
				manifest.theme_color = palette.tokens['brand-2'];
				manifest.background_color = palette.tokens['surface-page'];
			}
			const nl = m.toString('utf8').endsWith('\n') ? '\n' : '';
			put(BRAND_TARGETS.manifest, Buffer.from(JSON.stringify(manifest, null, '\t') + nl));
		}
	}

	// Prerendered pages.
	if (
		palette !== null &&
		!Object.values(slotMap.theme_files ?? {}).some((sl) => sl.some((x) => x[3] === 'theme-style'))
	) {
		warnings.push(
			'This frontend build has no colour-theme slots (it predates colour themes), so only the pages the app ' +
				'draws in the browser get your colours. Upgrade Morphit (sudo morphit-ops upgrade) — the upgrade ' +
				're-applies your branding.'
		);
	}
	for (const [rel, slots] of pageSlots(slotMap)) {
		if (isProtectedPath(rel)) continue;
		const c = canon(rel);
		if (c === null) continue;
		try {
			put(
				rel,
				Buffer.from(brandPage(c.toString('utf8'), slots, brandName, beta, pageTheme), 'utf8')
			);
		} catch (err) {
			throw new Error(
				`${rel}: ${err instanceof Error ? err.message : String(err)} — the build does not match its brand-slot map`
			);
		}
	}

	// Drop anything identical to canonical: an unconfigured instance plans nothing.
	for (const [rel, buf] of [...files]) {
		const c = canon(rel);
		if (c !== null && c.equals(buf)) files.delete(rel);
	}
	return {
		files,
		brandName,
		beta,
		active: files.size > 0,
		warnings,
		notes,
		rasterizerMissing: missingPngs.length > 0,
		theme: palette
	};
}

// ─── Apply ──────────────────────────────────────────────────────────────

export interface BrandingResult {
	readonly active: boolean;
	readonly brandName: string | null;
	readonly beta: boolean;
	/** Build-relative paths (incl. .gz/.br siblings) whose bytes changed on disk. */
	readonly touched: string[];
	readonly warnings: string[];
	readonly notes: string[];
	/** True when the build predates branding support (no slot map) — nothing done. */
	readonly unsupported: boolean;
	/** Some PNGs could not be made: no rsvg-convert / ImageMagick on this box. */
	readonly rasterizerMissing: boolean;
	/** The applied colour theme, or null for the Morphit colours. */
	readonly theme: ThemePalette | null;
}

export function matchOwner(path: string, ref: string): void {
	try {
		const st = lstatSync(ref);
		// lchownSync, never chownSync: `path` was just renamed into a directory a
		// NON-root account owns (the canary-upload build dir, or the web root), so
		// that account can swap the freshly-written file for a symlink in the
		// window before this chown. chownSync would then dereference it and hand
		// the LINK'S TARGET (any root-owned file) to that account — a root
		// privilege escalation (review B3). lchown affects the link itself, so a
		// planted link is harmless, and a real regular file is chowned identically.
		lchownSync(path, st.uid, st.gid);
	} catch {
		/* not root, or same owner — fine */
	}
}

/** One branding run at a time (an upgrade's re-apply and an operator's
 *  `branding apply` must not interleave). A lock left by a dead process is
 *  taken over. */
function acquireLock(paths: BrandingPaths): () => void {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = openSync(paths.lockFile, 'wx', 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return () => rmSync(paths.lockFile, { force: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			let pid = NaN;
			try {
				if (lstatSync(paths.lockFile).isFile())
					pid = Number(readFileSync(paths.lockFile, 'utf8').trim());
			} catch {
				/* vanished — retry */
			}
			let alive = false;
			if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
				try {
					process.kill(pid, 0);
					alive = true;
				} catch (e) {
					alive = (e as NodeJS.ErrnoException).code === 'EPERM';
				}
			}
			if (alive) {
				throw new Error(
					`another branding run (process ${pid}) is in progress — wait for it to finish, then try again`
				);
			}
			rmSync(paths.lockFile, { force: true });
		}
	}
	throw new Error(`could not take the branding lock ${paths.lockFile}`);
}

const SIBLINGS = ['', '.gz', '.br'] as const;
const withSiblings = (rel: string): string[] =>
	COMPRESSIBLE.test(rel) ? [rel, `${rel}.gz`, `${rel}.br`] : [rel];

/**
 * Bring the served build in line with the operator's branding (or back to
 * canonical when nothing is configured). `dryRun` plans without writing.
 *
 * Crash safety: the canonical original of every file about to change is saved,
 * and state.json written, BEFORE the build is touched; each file is replaced
 * atomically (temp + rename), so nginx never serves a half-written page. An
 * apply interrupted at any point is completed by the next `apply` and fully
 * undone by `reset`.
 */
export function applyBranding(opts: {
	buildDir: string;
	settings: BrandingSettings;
	dryRun?: boolean;
	/** Ignore all branding input and restore the canonical build. */
	reset?: boolean;
}): BrandingResult {
	const paths = brandingPaths(opts.buildDir);
	const slotsBuf = safeRead(paths.buildDir, BRAND_SLOTS_FILE);
	if (slotsBuf === null) {
		return {
			active: false,
			brandName: null,
			beta: true,
			touched: [],
			warnings: [],
			notes: [],
			unsupported: true,
			rasterizerMissing: false,
			theme: null
		};
	}
	const release = opts.dryRun ? (): void => {} : acquireLock(paths);
	try {
		return applyLocked(paths, slotsBuf, opts);
	} finally {
		release();
	}
}

function applyLocked(
	paths: BrandingPaths,
	slotsBuf: Buffer,
	opts: { settings: BrandingSettings; dryRun?: boolean; reset?: boolean }
): BrandingResult {
	const dryRun = opts.dryRun === true;
	const slotMap = JSON.parse(slotsBuf.toString('utf8')) as SlotMap;
	const state = loadState(paths, buildIdOf(paths), dryRun);
	const trackedBefore = [...state.modified, ...state.added];

	const settings: BrandingSettings = opts.reset
		? {
				brandName: null,
				invalidBrandName: null,
				shortName: null,
				betaBadge: 'on',
				dir: join(paths.pristineDir, '__none__'),
				theme: null
			}
		: opts.settings;
	const plan = planBranding(paths, settings, state, slotMap);
	const pristineFiles = join(paths.pristineDir, 'files');
	const cur = (rel: string): Buffer | null => safeRead(paths.buildDir, rel);

	// ── Decide. ──
	const tracked = new Set(trackedBefore);
	const writes: Array<[string, Buffer]> = [];
	const restores: string[] = [];
	const removals: string[] = [];
	const touched = new Set<string>();
	for (const rel of [...new Set([...tracked, ...plan.files.keys()])].sort()) {
		if (isProtectedPath(rel)) throw new Error(`refusing to touch protected path ${rel}`);
		const want = plan.files.get(rel) ?? null;
		if (want === null) {
			if (state.modified.includes(rel)) {
				restores.push(rel);
				const orig = safeRead(pristineFiles, rel);
				if (orig === null || !cur(rel)?.equals(orig))
					withSiblings(rel).forEach((r) => touched.add(r));
			} else if (state.added.includes(rel)) {
				removals.push(rel);
				withSiblings(rel).forEach((r) => touched.add(r));
			}
			continue;
		}
		const now = cur(rel);
		if (now !== null && now.equals(want) && tracked.has(rel)) continue; // already applied
		writes.push([rel, want]);
		withSiblings(rel).forEach((r) => touched.add(r));
	}

	const result = (): BrandingResult => ({
		active: state.modified.length + state.added.length > 0 || plan.active,
		brandName: plan.brandName,
		beta: plan.beta,
		touched: [...touched].sort(),
		warnings: plan.warnings,
		notes: plan.notes,
		unsupported: false,
		rasterizerMissing: plan.rasterizerMissing,
		theme: plan.theme
	});
	if (dryRun) return result();

	// ── Phase 1: save originals + state before the build changes at all. ──
	let stateChanged = false;
	for (const [rel] of writes) {
		if (tracked.has(rel)) continue;
		if (cur(rel) !== null) {
			safeMkdirs(dirname(paths.pristineDir), posix.basename(paths.pristineDir));
			safeMkdirs(paths.pristineDir, 'files');
			for (const sfx of SIBLINGS) {
				const b = cur(rel + sfx);
				if (b !== null) safeWrite(pristineFiles, rel + sfx, b);
			}
			state.modified.push(rel);
		} else {
			state.added.push(rel);
		}
		tracked.add(rel);
		stateChanged = true;
	}
	if (stateChanged) saveState(paths, state);

	// ── Phase 2: change the build. ──
	for (const [rel, want] of writes) {
		const hadCanonical = state.modified.includes(rel);
		const hadCompressed =
			safeRead(pristineFiles, `${rel}.gz`) !== null || cur(`${rel}.gz`) !== null;
		safeWrite(paths.buildDir, rel, want, true);
		if (COMPRESSIBLE.test(rel) && (hadCompressed || !hadCanonical)) {
			const c = compressed(want);
			safeWrite(paths.buildDir, `${rel}.gz`, c.gz, true);
			safeWrite(paths.buildDir, `${rel}.br`, c.br, true);
		} else {
			safeUnlink(paths.buildDir, `${rel}.gz`);
			safeUnlink(paths.buildDir, `${rel}.br`);
		}
	}
	for (const rel of restores) {
		for (const sfx of SIBLINGS) {
			const b = safeRead(pristineFiles, rel + sfx);
			if (b !== null) safeWrite(paths.buildDir, rel + sfx, b, true);
			else safeUnlink(paths.buildDir, rel + sfx);
		}
		state.modified = state.modified.filter((r) => r !== rel);
	}
	for (const rel of removals) {
		for (const sfx of SIBLINGS) safeUnlink(paths.buildDir, rel + sfx);
		removeEmptyParents(paths.buildDir, rel);
		state.added = state.added.filter((r) => r !== rel);
	}

	// ── Finish: the served verify.json, then the state. ──
	const rehash = new Set<string>(touched);
	for (const rel of [...trackedBefore, ...state.modified, ...state.added]) {
		withSiblings(rel).forEach((r) => rehash.add(r));
	}
	updateVerifyJson(paths, [...rehash], plan, state);
	if (state.modified.length === 0 && state.added.length === 0) {
		rmSync(paths.pristineDir, { recursive: true, force: true });
	} else {
		saveState(paths, state);
		for (const rel of restores) for (const sfx of SIBLINGS) safeUnlink(pristineFiles, rel + sfx);
	}
	return result();
}

/** After removing an added file, drop the directories branding created for
 *  it (only ones left empty; the build's own directories are never empty). */
function removeEmptyParents(root: string, rel: string): void {
	let dir = posix.dirname(rel);
	while (dir !== '.' && dir !== '') {
		try {
			const p = join(root, dir);
			if (lstatSync(p).isSymbolicLink() || readdirSync(p).length > 0) return;
			rmdirSync(p);
		} catch {
			return;
		}
		dir = posix.dirname(dir);
	}
}

/**
 * Keep the served verify.json honest: its full-file hash manifest is refreshed
 * for every file branding manages (changed, restored, or still overridden),
 * and an `operator_branding` block discloses what this operator overrides. The
 * on-chain release manifest (bootstrap files only) is untouched by
 * construction.
 */
function updateVerifyJson(
	paths: BrandingPaths,
	rels: readonly string[],
	plan: BrandingPlan,
	state: BrandingState
): void {
	const buf = safeRead(paths.buildDir, 'verify.json');
	if (buf === null || rels.length === 0) return;
	const doc = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
	const hm = (doc.hash_manifest ?? {}) as Record<string, string>;
	for (const rel of rels) {
		if (isProtectedPath(rel) && !/\.(gz|br)$/.test(rel)) continue;
		const b = safeRead(paths.buildDir, rel);
		if (b !== null) hm[rel] = sha256Hex(b);
		else delete hm[rel];
	}
	const sorted: Record<string, string> = {};
	for (const k of Object.keys(hm).sort()) sorted[k] = hm[k]!;
	doc.hash_manifest = sorted;
	const overridden = [...state.modified, ...state.added].sort();
	if (overridden.length > 0) {
		doc.operator_branding = {
			brand_name: plan.brandName ?? DEFAULT_BRAND_NAME,
			beta_badge: plan.beta,
			...(plan.theme !== null
				? {
						colour_theme: {
							preset: plan.theme.inputs.preset,
							from: plan.theme.inputs.from,
							mid: plan.theme.inputs.mid,
							to: plan.theme.inputs.to,
							background: plan.theme.inputs.background,
							button: plan.theme.inputs.button
						}
					}
				: {}),
			note: 'Files this operator re-branded in place (docs/BRANDING.md). The on-chain release manifest (index.html, service-worker, _app entry) is never modified.',
			files: overridden
		};
	} else {
		delete doc.operator_branding;
	}
	safeWrite(paths.buildDir, 'verify.json', Buffer.from(JSON.stringify(doc, null, 2) + '\n'), true);
}

/**
 * Mirror a set of changed build files into a bare-metal web root (the
 * containerized frontend bind-mounts the build dir, so it needs nothing).
 * Deleted build files are deleted from the web root too.
 */
export function syncTouchedToWebRoot(
	buildDir: string,
	webRoot: string,
	touched: readonly string[]
): number {
	let n = 0;
	for (const rel of [...touched, 'verify.json']) {
		const b = safeRead(buildDir, rel);
		if (b !== null) {
			safeWrite(webRoot, rel, b);
			matchOwner(join(webRoot, rel), webRoot);
			n++;
		} else if (safeUnlink(webRoot, rel)) {
			n++;
		}
	}
	return n;
}

/** POSIX-join helper for callers that print build-relative paths. */
export function displayPath(...parts: string[]): string {
	return posix.join(...parts.map((p) => p.split(sep).join('/')));
}

/** Absolute build dir of an install. */
export function buildDirOf(installDir: string): string {
	return resolve(installDir, 'apps', 'web', 'build');
}
