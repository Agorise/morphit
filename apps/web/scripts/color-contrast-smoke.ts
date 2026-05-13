#!/usr/bin/env tsx
/**
 * Static-source color-contrast smoke.
 *
 * Closes the last Part-100-deferred a11y item: WCAG 2.1
 * AA contrast verification.  Originally framed as needing
 * runtime tooling (axe-core), but the project's Tailwind
 * usage is structured enough that a static-source check
 * catches the dominant class of contrast failure without
 * a browser:
 *
 *   - `tailwind.config.js` declares the custom `ink-*`
 *     palette with explicit hex values.
 *   - The standard Tailwind palette is also well-known
 *     and stable.
 *   - Components use direct `text-X-N` + `bg-Y-N` pairings
 *     in single class lists, OR mirror them with `dark:`
 *     prefixes.
 *
 * This smoke walks every `.svelte` file under
 * `apps/web/src`, extracts class lists, and for each list
 * with a co-located `text-*` + `bg-*` pair (light mode AND
 * dark mode separately), computes the WCAG 2.1 contrast
 * ratio of the resolved hex pair.  It flags any pair that
 * fails AA for normal text (4.5:1).
 *
 * What this does NOT cover (acknowledged limits — the
 * remaining cases are best caught with axe-core at build
 * time, but they're a small fraction of the surface):
 *
 *   - Inheritance: text whose surrounding background is
 *     set by an ancestor element rather than the same
 *     class list.
 *   - State pairs: hover/focus/active state where the
 *     background changes but the text doesn't (or vice
 *     versa).
 *   - Gradients: `bg-morphit-gradient` against any
 *     overlaid text (gradients lack a single hex color).
 *   - SVG fill/stroke contrast against an enclosing
 *     element bg.
 *   - Dynamic colors injected via inline `style="..."`
 *     attributes.
 *
 * False-positive guard: an `ALLOW_LIST` of (file, snippet
 * fragment) tuples can suppress specific known-good pairs
 * that the static check can't reason about.  Any addition
 * to the allow-list MUST include a code-comment
 * justification.
 *
 * AA threshold rationale: 4.5:1 is the WCAG 2.1 AA bar
 * for "normal" text (under 18pt, or under 14pt if bold).
 * Large text qualifies for 3:1 instead.  We use 4.5:1
 * uniformly because the static check can't reliably
 * detect "this is a heading >= 24px" without parsing
 * Tailwind's `text-*` size classes — and erring strict
 * is better than erring lenient for an a11y smoke.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'apps/web/src');
const TAILWIND_CONFIG = join(REPO_ROOT, 'apps/web/tailwind.config.js');

// ─── Color palette ─────────────────────────────────────────────
//
// The custom `ink-*` scale is parsed from
// `apps/web/tailwind.config.js`.  Standard Tailwind v3.4
// palette hex values are hard-coded below — these are
// public, documented at tailwindcss.com, and stable across
// minor versions.  Updating Tailwind to a major version
// that changes hex values will require updating this table.

type ColorScale = Record<string, string>; // shade ('50'..'950') → hex

const PALETTE_DEFAULTS: Record<string, ColorScale> = {
	// Standard Tailwind v3.4 — only the families used in this
	// codebase are needed.  See docs/REVISIT-LIST.md for the
	// list of color families used (amber, blue, emerald, green,
	// orange, red, rose).
	amber: {
		'50': '#fffbeb', '100': '#fef3c7', '200': '#fde68a',
		'300': '#fcd34d', '400': '#fbbf24', '500': '#f59e0b',
		'600': '#d97706', '700': '#b45309', '800': '#92400e',
		'900': '#78350f', '950': '#451a03'
	},
	blue: {
		'50': '#eff6ff', '100': '#dbeafe', '200': '#bfdbfe',
		'300': '#93c5fd', '400': '#60a5fa', '500': '#3b82f6',
		'600': '#2563eb', '700': '#1d4ed8', '800': '#1e40af',
		'900': '#1e3a8a', '950': '#172554'
	},
	emerald: {
		'50': '#ecfdf5', '100': '#d1fae5', '200': '#a7f3d0',
		'300': '#6ee7b7', '400': '#34d399', '500': '#10b981',
		'600': '#059669', '700': '#047857', '800': '#065f46',
		'900': '#064e3b', '950': '#022c22'
	},
	green: {
		'50': '#f0fdf4', '100': '#dcfce7', '200': '#bbf7d0',
		'300': '#86efac', '400': '#4ade80', '500': '#22c55e',
		'600': '#16a34a', '700': '#15803d', '800': '#166534',
		'900': '#14532d', '950': '#052e16'
	},
	orange: {
		'50': '#fff7ed', '100': '#ffedd5', '200': '#fed7aa',
		'300': '#fdba74', '400': '#fb923c', '500': '#f97316',
		'600': '#ea580c', '700': '#c2410c', '800': '#9a3412',
		'900': '#7c2d12', '950': '#431407'
	},
	red: {
		'50': '#fef2f2', '100': '#fee2e2', '200': '#fecaca',
		'300': '#fca5a5', '400': '#f87171', '500': '#ef4444',
		'600': '#dc2626', '700': '#b91c1c', '800': '#991b1b',
		'900': '#7f1d1d', '950': '#450a0a'
	},
	rose: {
		'50': '#fff1f2', '100': '#ffe4e6', '200': '#fecdd3',
		'300': '#fda4af', '400': '#fb7185', '500': '#f43f5e',
		'600': '#e11d48', '700': '#be123c', '800': '#9f1239',
		'900': '#881337', '950': '#4c0519'
	}
};

// ─── Parse custom ink scale from tailwind.config.js ────────────

function parseInkScale(): ColorScale {
	const cfg = readFileSync(TAILWIND_CONFIG, 'utf-8');
	// Look for the `ink: { ... }` object.
	const m = cfg.match(/ink:\s*\{([\s\S]*?)\}/);
	if (!m) {
		throw new Error('Could not find ink scale in tailwind.config.js');
	}
	const body = m[1];
	const scale: ColorScale = {};
	for (const lm of body.matchAll(/(\d+):\s*'(#[0-9a-fA-F]+)'/g)) {
		scale[lm[1]] = lm[2];
	}
	if (Object.keys(scale).length === 0) {
		throw new Error('Parsed ink scale is empty — config format changed?');
	}
	return scale;
}

const PALETTE: Record<string, ColorScale> = {
	...PALETTE_DEFAULTS,
	ink: parseInkScale(),
	// `white` and `black` are single-value pseudo-scales; map
	// them so `text-white` resolves cleanly.
	white: { DEFAULT: '#ffffff' },
	black: { DEFAULT: '#000000' }
};

function resolveColor(family: string, shade: string): string | null {
	const scale = PALETTE[family];
	if (!scale) return null;
	return scale[shade] ?? null;
}

// ─── WCAG 2.1 contrast computation ─────────────────────────────
//
// Per WCAG 2.1 SC 1.4.3:
//   - Compute relative luminance per channel: c <= 0.03928
//     ? c/12.92 : ((c + 0.055)/1.055)^2.4
//   - L = 0.2126*R + 0.7152*G + 0.0722*B
//   - contrast = (Llighter + 0.05) / (Ldarker + 0.05)
//   - AA normal text: ratio >= 4.5
//   - AA large text:  ratio >= 3.0

function hexToRgb(hex: string): [number, number, number] {
	const cleaned = hex.replace(/^#/, '').toLowerCase();
	let h = cleaned;
	if (h.length === 3) {
		h = h.split('').map((c) => c + c).join('');
	}
	if (h.length !== 6) {
		throw new Error(`Bad hex color: ${hex}`);
	}
	return [
		parseInt(h.slice(0, 2), 16) / 255,
		parseInt(h.slice(2, 4), 16) / 255,
		parseInt(h.slice(4, 6), 16) / 255
	];
}

function relLuminance([r, g, b]: [number, number, number]): number {
	const channel = (c: number) =>
		c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(hexA: string, hexB: string): number {
	const la = relLuminance(hexToRgb(hexA));
	const lb = relLuminance(hexToRgb(hexB));
	const lighter = Math.max(la, lb);
	const darker = Math.min(la, lb);
	return (lighter + 0.05) / (darker + 0.05);
}

// ─── Class-list extraction ─────────────────────────────────────
//
// A class list is the value of a `class="..."` or `class:list`
// expression.  We extract the literal-string portion and pull
// out:
//   - light-mode pairs:  text-X-N + bg-Y-N (no `dark:` prefix)
//   - dark-mode pairs:   dark:text-X-N + dark:bg-Y-N
//
// Mixed pairs (e.g. `text-X-N` with `dark:bg-Y-N`) are treated
// as separate light/dark contexts and not cross-paired.

interface ColorClass {
	role: 'text' | 'bg';
	dark: boolean;
	family: string;
	shade: string;
	raw: string;
}

// Match: optional `dark:` prefix, then text/bg-family-shade.
// CRITICAL: anchor with a word-boundary that's NOT colon-following,
// so `hover:text-...`, `focus:bg-...`, `group-hover:text-...`, and
// every other state-variant prefix is excluded.  We only want
// base classes and `dark:`-only classes — hover/focus/active state
// contrast is inherently dynamic and would produce too many false
// positives in a static check (the user only sees that pairing
// while interacting, and it's well-documented that state styling
// doesn't have to meet AA for the resting state to comply).
//
// We also reject opacity-modifier suffixes like `bg-amber-500/10`
// (10% alpha over parent) — these don't have a single resolvable
// hex value.  The actual rendered color depends on the inherited
// background, which the static check can't resolve.  Fail-open
// here: skip the pair rather than report a false positive.
//
// Regex strategy: match a class, then verify its preceding char
// is the start of the class list, whitespace, or the end of a
// `dark:` prefix; AND its following char is whitespace, end of
// string, or NOT a `/` (which would indicate an opacity modifier).
const COLOR_CLASS_RE =
	/(dark:)?(text|bg)-([a-z]+)-(\d+)\b/g;

function extractColorClasses(classList: string): ColorClass[] {
	const out: ColorClass[] = [];
	for (const m of classList.matchAll(COLOR_CLASS_RE)) {
		const start = m.index ?? 0;
		const beforeIdx = start - 1;
		const before = beforeIdx >= 0 ? classList[beforeIdx] : ' ';
		// Reject state variants: anything ending in `:` other
		// than the captured `dark:` prefix.
		if (before === ':') continue;
		// Reject opacity modifiers: `bg-amber-500/10` is the
		// shade followed by `/`.  These resolve to alpha-blended
		// values that depend on the parent bg.
		const after = classList[start + m[0].length];
		if (after === '/') continue;

		const family = m[3];
		// Skip non-color uses: `bg-no-repeat`, `bg-cover`, etc.
		// share the `bg-` prefix but the second segment isn't a
		// known palette family.  Resolve check filters them.
		if (!PALETTE[family]) continue;
		out.push({
			dark: !!m[1],
			role: m[2] as 'text' | 'bg',
			family,
			shade: m[4],
			raw: m[0]
		});
	}
	return out;
}

interface Pair {
	mode: 'light' | 'dark';
	text: ColorClass;
	bg: ColorClass;
	textHex: string;
	bgHex: string;
	ratio: number;
	classList: string;
}

function pairUp(classList: string): Pair[] {
	const all = extractColorClasses(classList);
	const lightText = all.filter((c) => !c.dark && c.role === 'text');
	const lightBg = all.filter((c) => !c.dark && c.role === 'bg');
	const darkText = all.filter((c) => c.dark && c.role === 'text');
	const darkBg = all.filter((c) => c.dark && c.role === 'bg');
	const out: Pair[] = [];
	// Cross-pair within mode: typically each class list has at
	// most ONE text + ONE bg per mode, so this is usually 1×1.
	// But class lists with hover-state classes can have multiple
	// text-* — we pair each text against each bg in the same
	// mode and surface every combination.  This errs on the
	// noisier side, which is fine for a contrast smoke.
	for (const t of lightText) {
		for (const b of lightBg) {
			const tHex = resolveColor(t.family, t.shade);
			const bHex = resolveColor(b.family, b.shade);
			if (!tHex || !bHex) continue;
			out.push({
				mode: 'light',
				text: t, bg: b, textHex: tHex, bgHex: bHex,
				ratio: contrastRatio(tHex, bHex), classList
			});
		}
	}
	for (const t of darkText) {
		for (const b of darkBg) {
			const tHex = resolveColor(t.family, t.shade);
			const bHex = resolveColor(b.family, b.shade);
			if (!tHex || !bHex) continue;
			out.push({
				mode: 'dark',
				text: t, bg: b, textHex: tHex, bgHex: bHex,
				ratio: contrastRatio(tHex, bHex), classList
			});
		}
	}
	return out;
}

// ─── Walk svelte files and collect class lists ─────────────────

function walkSvelte(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === '.svelte-kit') continue;
		const p = join(dir, entry);
		const s = statSync(p);
		if (s.isDirectory()) out.push(...walkSvelte(p));
		else if (s.isFile() && p.endsWith('.svelte')) out.push(p);
	}
	return out;
}

// Match `class="..."` (double-quoted) and `class={'...'}` and
// `class={`...`}` (template literal — captures the literal
// portion ignoring interpolations as best-effort; for the
// contrast scan, missing some interpolated classes is fine —
// we'll catch them on the literal portion).
//
// Svelte's common ternary-class pattern looks like:
//   class="base-classes {cond ? 'A-classes' : 'B-classes'}"
// Branches A and B are mutually exclusive — they never both
// apply to the same element.  If we treat the whole captured
// string as one class list, the smoke cross-pairs `text-X`
// from branch A with `bg-Y` from branch B and reports false
// positives.  Strategy: when we see a `{... ? '...' : '...'}`
// inside the captured class string, split into multiple
// virtual class lists — one per branch, each combined with
// the surrounding base classes.
function expandTernaryBranches(classAttr: string): string[] {
	// Capture {cond ? 'A' : 'B'} (single-quoted branches).
	const ternaryRe = /\{[^{}?]*?\?\s*'([^']*)'\s*:\s*'([^']*)'\s*\}/;
	const m = classAttr.match(ternaryRe);
	if (!m) return [classAttr];
	const branchA = m[1];
	const branchB = m[2];
	const before = classAttr.slice(0, m.index ?? 0);
	const after = classAttr.slice((m.index ?? 0) + m[0].length);
	// Recurse: a class attr can have multiple ternaries.
	const subA = expandTernaryBranches(`${before}${branchA}${after}`);
	const subB = expandTernaryBranches(`${before}${branchB}${after}`);
	return [...subA, ...subB];
}

function extractClassLists(svelteSrc: string): string[] {
	const out: string[] = [];
	for (const m of svelteSrc.matchAll(/class\s*=\s*"([^"]+)"/g)) {
		out.push(...expandTernaryBranches(m[1]));
	}
	for (const m of svelteSrc.matchAll(/class:list=\{?\s*\[([\s\S]*?)\]/g)) {
		// Pull every double- or single-quoted string out of the
		// array literal.
		for (const sm of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
			out.push(sm[1]);
		}
	}
	return out;
}

// ─── Allow-list ────────────────────────────────────────────────
//
// Each entry: { file, classListSubstring, reason } — a
// finding that includes both is suppressed.  Allow-list
// entries should be RARE and each MUST have a justifying
// reason.  Empty by default; populate ONLY if the static
// check produces a false positive that can't be fixed by
// improving the class list itself.

interface AllowEntry { file: string; sub: string; reason: string }
const ALLOW_LIST: AllowEntry[] = [
	// (none yet — Part 103 establishes the smoke; populate
	// as legitimate exceptions are discovered.)
];

function isAllowListed(file: string, classList: string): boolean {
	for (const a of ALLOW_LIST) {
		if (file.endsWith(a.file) && classList.includes(a.sub)) return true;
	}
	return false;
}

// ─── Run the scan ──────────────────────────────────────────────

console.log('');
console.log('── color-contrast (WCAG AA, static-source) smoke ───────');
console.log('');

const AA_NORMAL = 4.5;

interface Finding {
	file: string;
	mode: 'light' | 'dark';
	text: string;
	bg: string;
	ratio: number;
	classList: string;
}
const findings: Finding[] = [];

let filesScanned = 0;
let pairsChecked = 0;
const svelteFiles = walkSvelte(SRC_ROOT);
for (const f of svelteFiles) {
	filesScanned++;
	const src = readFileSync(f, 'utf-8');
	const classLists = extractClassLists(src);
	for (const cl of classLists) {
		const pairs = pairUp(cl);
		for (const p of pairs) {
			pairsChecked++;
			if (p.ratio < AA_NORMAL) {
				if (isAllowListed(f, cl)) continue;
				findings.push({
					file: relative(REPO_ROOT, f),
					mode: p.mode,
					text: p.text.raw,
					bg: p.bg.raw,
					ratio: p.ratio,
					classList: cl
				});
			}
		}
	}
}

// ─── Self-tests of the contrast math ───────────────────────────
//
// Sanity-check the math against well-known fixed values
// (don't trust the implementation just because the scan
// produced a number).

const selfTestPairs: Array<[string, string, number]> = [
	['#ffffff', '#000000', 21], // black-on-white = max ratio
	['#000000', '#ffffff', 21], // symmetric
	['#777777', '#ffffff', 4.48], // borderline AA fail (just under 4.5)
	['#595959', '#ffffff', 7.0], // AAA pass (~7:1)
	['#0B1220', '#FEFEFE', 18.65], // morphit ink vs paper, very high contrast
];
const selfTestErrors: string[] = [];
for (const [a, b, expected] of selfTestPairs) {
	const got = contrastRatio(a, b);
	if (Math.abs(got - expected) > 0.1) {
		selfTestErrors.push(
			`  expected contrast(${a}, ${b}) ≈ ${expected}, got ${got.toFixed(2)}`
		);
	}
}

// Resolution sanity: the ink-900 we resolved must be the
// hex declared in tailwind.config.js.
const resolutionOk = resolveColor('ink', '900') === '#0F141C';

const scenarios = [
	{
		name: 'tailwind.config.js ink scale parsed (10 shades)',
		ok: Object.keys(PALETTE.ink).length === 11 // 50,100,200,...,950
	},
	{
		name: 'ink-900 resolves to the declared hex (#0F141C)',
		ok: resolutionOk
	},
	{
		name: 'WCAG contrast math passes 5 self-test pairs',
		ok: selfTestErrors.length === 0
	},
	{
		name: 'at least 50 class lists with text+bg pairs were checked',
		ok: pairsChecked >= 50
	},
	{
		name: 'every checked text/bg pair meets WCAG AA (4.5:1)',
		ok: findings.length === 0
	}
];

// ─── Reporting ─────────────────────────────────────────────────

if (findings.length > 0) {
	// Group by file for readability.
	const byFile = new Map<string, Finding[]>();
	for (const f of findings) {
		if (!byFile.has(f.file)) byFile.set(f.file, []);
		byFile.get(f.file)!.push(f);
	}
	console.log(
		`  ${findings.length} contrast failure${findings.length === 1 ? '' : 's'} ` +
		`across ${byFile.size} file${byFile.size === 1 ? '' : 's'}:`
	);
	for (const [file, fs] of byFile) {
		console.log(`    ${file}`);
		for (const f of fs) {
			console.log(
				`      [${f.mode}] ${f.text} on ${f.bg}  ratio=${f.ratio.toFixed(2)}:1  (need ≥4.5)`
			);
		}
	}
	console.log('');
}

if (selfTestErrors.length > 0) {
	console.log('  Self-test failures:');
	for (const e of selfTestErrors) console.log(e);
	console.log('');
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const s of scenarios) {
	if (s.ok) {
		passed++;
	} else {
		failed++;
		failures.push(`  ✗ ${s.name}`);
	}
}

if (failures.length > 0) {
	console.log(failures.join('\n'));
	console.log('');
}

console.log(
	`  scanned ${filesScanned} svelte files, ` +
	`${pairsChecked} text/bg pairs checked, ` +
	`${findings.length} below AA`
);
console.log('────────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
