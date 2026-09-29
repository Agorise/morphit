#!/usr/bin/env tsx
/**
 * scripts/theme-literal-scan-smoke.ts — per-instance colour theming guard.
 *
 * The frontend's brand and surface colours live in ONE file,
 * apps/web/src/theme.css, as CSS custom properties; `morphit-ops branding apply
 * --theme-from … --theme-to …` re-colours an instance by overriding those
 * properties (docs/BRANDING.md, "Colours"). A colour LITERAL anywhere else —
 * `#00da69`, `rgba(0, 218, 105, .3)`, a navy `rgb(15 23 42)` — would stay
 * Morphit-green / Morphit-navy on a re-themed instance. This smoke scans the
 * whole web source (components, routes, stores, app.css, app.html,
 * tailwind.config.js) and FAILS on any colour literal that is not either
 *   - pure white / black (any alpha) — not a brand or surface colour, or
 *   - listed in ALLOW below with the reason it is genuinely not a brand/surface
 *     colour (error red, coin identity colours, print styles, …).
 * An ALLOW entry that no longer matches anything also fails (so the list can't
 * silently rot into a blanket exemption).
 *
 * Comments are ignored (they document history, e.g. "was #00b85a").
 *
 * Usage: tsx scripts/theme-literal-scan-smoke.ts [<repo root>]   (default: this repo)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const WEB = join(REPO, 'apps', 'web');
/** The one file allowed to define colour values. */
const THEME_FILE = 'apps/web/src/theme.css';

interface Allow {
	readonly file: string;
	/** Normalised literal (lower case, no spaces). */
	readonly literal: string;
	readonly reason: string;
}

const SEMANTIC_RED = 'error / destructive red — semantic, not brand (red stays red on every theme)';
const PRINT = 'print stylesheet — black ink on white paper, never on screen';
const JSON_HL = 'explorer raw-JSON syntax highlighting — code colours, not brand';
const IDENT =
	'deterministic identicon palette — a user identity, must look the same on every instance';
const COIN =
	'coin / token identity colour (asset registry) — the asset’s own brand, not the site’s';

export const ALLOW: readonly Allow[] = [
	// app.html — the theme-color meta is a SLOT: build-brand-slots.mjs records it and
	// `branding apply` rewrites it with the theme's brand-2.
	{
		file: 'apps/web/src/app.html',
		literal: '#00da69',
		reason: 'theme-color meta — a build-time theme slot rewritten by branding apply'
	},
	// app.css
	{
		file: 'apps/web/src/app.css',
		literal: '#facc15',
		reason: 'attention flash yellow (Terms field) — deliberately NOT the brand colour (cp425)'
	},
	...[
		'#0369a1',
		'#15803d',
		'#b45309',
		'#7c3aed',
		'#6b7280',
		'#7dd3fc',
		'#86efac',
		'#fcd34d',
		'#c4b5fd',
		'#9ca3af'
	].map((literal) => ({ file: 'apps/web/src/app.css', literal, reason: JSON_HL })),
	// Semantic status colours.
	...[
		'#fee2e2',
		'#991b1b',
		'#ef4444',
		'#7f1d1d',
		'#fecaca',
		'#f87171',
		'#b91c1c',
		'#dc2626',
		'#fca5a5'
	].map((literal) => ({
		file: 'apps/web/src/lib/components/ProtectedTextarea.svelte',
		literal,
		reason: SEMANTIC_RED
	})),
	{
		file: 'apps/web/src/lib/components/FeatureBidForm.svelte',
		literal: 'rgb(239 68 68)',
		reason: SEMANTIC_RED
	},
	{
		file: 'apps/web/src/lib/components/FeatureBidForm.svelte',
		literal: 'rgb(239 68 68 / 0.25)',
		reason: SEMANTIC_RED
	},
	{
		file: 'apps/web/src/lib/components/AnimatedNumber.svelte',
		literal: 'rgb(16,185,129)',
		reason:
			'number-went-UP flash green, paired with the went-DOWN red — semantic gain/loss, not brand'
	},
	{
		file: 'apps/web/src/lib/components/AnimatedNumber.svelte',
		literal: 'rgb(220,38,38)',
		reason: SEMANTIC_RED
	},
	{
		file: 'apps/web/src/lib/components/MorphitLogoBling.svelte',
		literal: '#dc2626',
		reason: 'the red BETA marker (light scheme) — a warning, not brand'
	},
	{
		file: 'apps/web/src/lib/components/MorphitLogoBling.svelte',
		literal: '#f87171',
		reason: 'the red BETA marker — a warning, not brand'
	},
	{
		file: 'apps/web/src/routes/[lang]/settings/security/2fa/+page.svelte',
		literal: '#2bb24c',
		reason: 'var(--success) fallback: semantic success green'
	},
	{
		file: 'apps/web/src/routes/[lang]/settings/security/2fa/+page.svelte',
		literal: '#b73030',
		reason: 'var(--danger) fallback: ' + SEMANTIC_RED
	},
	{
		file: 'apps/web/src/routes/[lang]/settings/security/2fa/+page.svelte',
		literal: '#d99000',
		reason: 'var(--warn) fallback: semantic warning amber'
	},
	// Third-party / identity colours.
	{
		file: 'apps/web/src/routes/[lang]/+layout.svelte',
		literal: '#f7df1e',
		reason: 'the JavaScript logo yellow on the footer "No JS" chip — a third-party mark'
	},
	{
		file: 'apps/web/src/routes/[lang]/+layout.svelte',
		literal: '#dc2626',
		reason: 'the "No JS" chip’s red strike-through — semantic "off"'
	},
	{
		file: 'apps/web/src/lib/components/RssFeedPicker.svelte',
		literal: '#f26522',
		reason: 'the RSS feed-icon orange — a third-party mark'
	},
	...[
		'#e94b3c',
		'#f0a93a',
		'#e8b22a',
		'#4fa15e',
		'#2f8f7e',
		'#48b4d4',
		'#3069a8',
		'#2d3e84',
		'#7a5d3f',
		'#6b7b4a',
		'#b8392a',
		'#111'
	].map((literal) => ({ file: 'apps/web/src/lib/crypto/identicon.ts', literal, reason: IDENT })),
	// The Morphit logo artwork: the SOFTWARE's mark (dev/icons page), replaced per
	// instance by the logo branding (logo.svg), not by the colour theme.
	...['#8eef26', '#00da69', '#02a6b2'].map((literal) => ({
		file: 'apps/web/src/lib/components/MorphitMark.svelte',
		literal,
		reason: 'the Morphit logo mark artwork — logo branding (logo.svg), not the colour theme'
	})),
	// Print styles.
	...['#444', '#f6f6f6', '#ccc', '#555', '#999', '#666', '#fffae6'].map((literal) => ({
		file: 'apps/web/src/lib/components/SeedBackupPrint.svelte',
		literal,
		reason: PRINT
	})),
	...['#444', '#ccc', '#eee', '#ddd', '#222', '#999', '#666'].map((literal) => ({
		file: 'apps/web/src/routes/[lang]/cheat-sheet/+page.svelte',
		literal,
		reason: PRINT
	}))
];

const EXTS = /\.(svelte|ts|js|mjs|css|html)$/;
const SKIP = /\.(test|spec)\.ts$/;

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...walk(full));
		else if (EXTS.test(name) && !SKIP.test(name)) out.push(full);
	}
	return out;
}

/** Blank out comments, keeping line numbers. */
export function stripComments(src: string, file: string): string {
	const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
	let s = src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
	if (/\.(ts|js|mjs|svelte)$/.test(file)) {
		// `// …` line comments (not `://` in URLs, not inside a regex like /\/\//).
		s = s.replace(
			/(^|[\s;{}(),])\/\/[^\n]*/g,
			(m, pre: string) => pre + blank(m.slice(pre.length))
		);
	}
	return s;
}

const LITERAL_RE =
	/(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(\s*[-\d.][^)]*\)/g;

export function normalise(lit: string): string {
	return lit
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/\(\s+/, '(')
		.replace(/\s*,\s*/g, ',')
		.replace(/\s+\)/, ')');
}

function isWhiteOrBlack(n: string): boolean {
	if (/^#(fff|ffff|ffffff|ffffffff|000|0000|000000|00000000)$/.test(n)) return true;
	const m = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(n);
	if (m) {
		const v = [m[1], m[2], m[3]].map(Number);
		return v.every((x) => x === 255) || v.every((x) => x === 0);
	}
	return false;
}

export interface Finding {
	readonly file: string;
	readonly line: number;
	readonly literal: string;
}

export function scan(repo: string): { findings: Finding[]; used: Set<Allow>; files: number } {
	const web = join(repo, 'apps', 'web');
	const files = [...walk(join(web, 'src')), join(web, 'tailwind.config.js')];
	const findings: Finding[] = [];
	const used = new Set<Allow>();
	for (const abs of files) {
		const rel = relative(repo, abs).split(sep).join('/');
		if (rel === THEME_FILE) continue;
		const text = stripComments(readFileSync(abs, 'utf8'), rel);
		let m: RegExpExecArray | null;
		LITERAL_RE.lastIndex = 0;
		while ((m = LITERAL_RE.exec(text)) !== null) {
			const lit = normalise(m[0]);
			if (isWhiteOrBlack(lit)) continue;
			const allow = ALLOW.find((a) => a.file === rel && normalise(a.literal) === lit);
			if (allow) {
				used.add(allow);
				continue;
			}
			findings.push({ file: rel, line: text.slice(0, m.index).split('\n').length, literal: m[0] });
		}
	}
	return { findings, used, files: files.length };
}

function main(): void {
	console.log('\n── theme literal scan (docs/BRANDING.md, "Colours") ──\n');
	let failed = 0;
	let passed = 0;
	const { findings, used, files } = scan(REPO);
	if (findings.length === 0) {
		console.log(
			`  ✓ no brand/surface colour literal outside ${THEME_FILE} (${files} files scanned)`
		);
		passed++;
	} else {
		console.error(`  ✗ ${findings.length} colour literal(s) outside ${THEME_FILE}:`);
		for (const f of findings) console.error(`      ${f.file}:${f.line}  ${f.literal}`);
		console.error(
			'      → use a theme token: rgb(var(--<token>-rgb) / <alpha>) or a Tailwind morphit-*/ink-* class;\n' +
				'        a genuinely non-brand colour goes in ALLOW (this file) with its reason.'
		);
		failed++;
	}
	const stale = ALLOW.filter((a) => !used.has(a));
	if (stale.length === 0) {
		console.log(`  ✓ every ALLOW entry (${ALLOW.length}) still matches a literal`);
		passed++;
	} else {
		console.error(`  ✗ stale ALLOW entries (nothing matches them any more — remove them):`);
		for (const a of stale) console.error(`      ${a.file}  ${a.literal}`);
		failed++;
	}
	const themePath = join(WEB, 'src', 'theme.css');
	const themeCss = existsSync(themePath) ? readFileSync(themePath, 'utf8') : '';
	const defines = /--brand-1-rgb:/.test(themeCss) && /--surface-950-rgb:/.test(themeCss);
	if (defines) {
		console.log(`  ✓ ${THEME_FILE} defines the brand and surface tokens`);
		passed++;
	} else {
		console.error(`  ✗ ${THEME_FILE} does not define the theme tokens`);
		failed++;
	}
	if (failed > 0) {
		console.error(`\n✗ ${failed} of ${passed + failed} theme-literal checks failed`);
		process.exit(1);
	}
	console.log(`\n✓ all ${passed} theme-literal checks passed`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
