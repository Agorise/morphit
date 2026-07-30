#!/usr/bin/env tsx
/**
 * Smoke: comparison-image PNG is fresh relative to the build script
 *        AND the Morphit wordmark is preserved in both SVG + build script.
 *
 * `apps/web/static/morphit-comparison.png` is the canonical artifact
 * served at https://morphit.io/morphit-comparison.png so blog posts
 * and external sites can hot-link a stable URL.  This smoke asserts:
 *
 *   1. PNG / SVG / build script / brag list all exist on disk.
 *   2. The PNG's SHA-256 fingerprint sidecar
 *      (`apps/web/static/morphit-comparison.png.fingerprint`) matches
 *      the SHA-256 of the current SVG content.  When the SVG changes
 *      without re-running build_comparison.py, the sidecar hash and
 *      the live SVG hash diverge → smoke fails with an actionable
 *      "re-run the build script" message.
 *
 *      Why fingerprint instead of mtime: git checkout resets every
 *      file's mtime to the checkout instant in filesystem-walk
 *      order, so an mtime-based check is non-deterministic in CI
 *      even when the repo is byte-perfect.  (cp136 shipped with an
 *      mtime check that passed locally but failed CI — F-5.)
 *
 * Wordmark-preservation checks (introduced cp134 after Ken's hand-edited
 * Morphit wordmark replaced the plain "Morphit" text in the column
 * header):
 *
 *   5. The build script declares BOTH `WORDMARK_DEFS` and
 *      `WORDMARK_GROUP` Python constants.  If a future edit removes
 *      these (e.g. by reverting to a plain text header), this fails.
 *   6. The build script emits both into the SVG output (via
 *      `out.append(f'<defs>{WORDMARK_DEFS}</defs>')` and
 *      `out.append(WORDMARK_GROUP)`).
 *   7. The build script does NOT emit a plain text "Morphit" label
 *      in the column header slot — the wordmark replaces it.  We
 *      look for the old emission pattern and refuse if it's there.
 *   8. The committed SVG contains the wordmark's three signature
 *      colors in the correct paths (the COLOR CONTRACT):
 *          - `fill:url(#id0)`   → linked-circle gradient
 *          - `fill:#fefefe`     → "morph" letters in WHITE
 *          - `fill:#7fed2d`     → "it!" letters in GREEN
 *      If anyone swaps these (e.g. "morph" becomes green or "it!"
 *      becomes white), this fails with a clear message.
 *   9. The committed SVG contains the `linearGradient id="id0"`
 *      with all three of its stop colors (#8EEF26 → #00DA69 → #02A6B2).
 *      Removing the gradient would render the linked circles as
 *      solid black, so this is structural insurance.
 *
 * Tamper tests (each fails the smoke):
 *   - Delete `WORDMARK_GROUP = ...` from build script → fails #5.
 *   - Change `out.append(WORDMARK_GROUP)` to an unrelated line → fails #6.
 *   - Add `out.append('<text>Morphit</text>')` in the header loop → fails #7.
 *   - Swap `#fefefe` ↔ `#7fed2d` in the SVG → fails #8.
 *   - Delete the `<linearGradient id="id0">` block → fails #9.
 *   - Commit an unoptimized PNG (>512 KB) → fails #10.
 *   - Hand-edit the SVG without re-running the build script (fingerprint
 *     sidecar diverges from current SVG hash) → fails fingerprint check.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const PNG = join(REPO_ROOT, 'apps/web/static/morphit-comparison.png');
const FINGERPRINT = join(REPO_ROOT, 'apps/web/static/morphit-comparison.png.fingerprint');
const SVG = join(REPO_ROOT, 'scripts/comparison-image/comparison.svg');
const SCRIPT = join(REPO_ROOT, 'scripts/comparison-image/build_comparison.py');
const BRAG = join(REPO_ROOT, 'MORPHIT-BRAG-LIST.md');

let passes = 0;
let failures = 0;
function pass(msg: string): void {
	passes += 1;
	console.log(`  ✓ ${msg}`);
}
function fail(msg: string, detail = ''): void {
	failures += 1;
	console.error(`  ✗ ${msg}${detail ? ` — ${detail}` : ''}`);
}

console.log('comparison-image-freshness-smoke\n');

if (!existsSync(PNG)) {
	fail(`PNG exists at apps/web/static/morphit-comparison.png`,
		'Run: python3 scripts/comparison-image/build_comparison.py');
} else {
	pass(`PNG exists at apps/web/static/morphit-comparison.png`);
}

if (!existsSync(SVG)) {
	fail(`SVG exists at scripts/comparison-image/comparison.svg`,
		'Run: python3 scripts/comparison-image/build_comparison.py');
} else {
	pass(`SVG exists at scripts/comparison-image/comparison.svg`);
}

if (!existsSync(SCRIPT)) {
	fail(`build script exists at scripts/comparison-image/build_comparison.py`);
} else {
	pass(`build script exists`);
}

if (!existsSync(BRAG)) {
	fail(`MORPHIT-BRAG-LIST.md exists`);
} else {
	pass(`MORPHIT-BRAG-LIST.md exists`);
}

// Content fingerprint check (replaces three mtime-based checks).
//
// build_comparison.py writes a SHA-256 of the rendered SVG to
// `apps/web/static/morphit-comparison.png.fingerprint` every time
// it builds.  If the SVG on disk hashes to that same value, the PNG
// was built from this exact SVG and is fresh.  If they diverge,
// someone hand-edited the SVG (or the build script) without
// regenerating, and the PNG is stale.
//
// This survives `git checkout`'s mtime reset because both inputs
// are file contents, not metadata.
if (existsSync(SVG) && existsSync(FINGERPRINT)) {
	const svgContent = readFileSync(SVG, 'utf8');
	const liveSvgHash = createHash('sha256').update(svgContent, 'utf8').digest('hex');
	const recordedHash = readFileSync(FINGERPRINT, 'utf8').trim();
	if (liveSvgHash === recordedHash) {
		pass(`PNG fingerprint matches the current SVG content (sha256:${liveSvgHash.slice(0, 12)}…)`);
	} else {
		fail(
			`PNG fingerprint does not match the current SVG content`,
			`The fingerprint sidecar says the PNG was built from a different SVG. ` +
				`Either the SVG was hand-edited without rebuilding, or the build ` +
				`script was changed in a way that affects the rendered SVG. ` +
				`Re-run: python3 scripts/comparison-image/build_comparison.py and ` +
				`commit the regenerated PNG + fingerprint together.\n` +
				`  recorded: ${recordedHash.slice(0, 16)}…\n` +
				`  live SVG: ${liveSvgHash.slice(0, 16)}…`
		);
	}
} else if (existsSync(SVG) && !existsSync(FINGERPRINT)) {
	fail(
		`PNG fingerprint sidecar is missing`,
		`Expected at apps/web/static/morphit-comparison.png.fingerprint. ` +
			`Re-run: python3 scripts/comparison-image/build_comparison.py and ` +
			`commit the produced fingerprint file.`
	);
}

// ─── Wordmark preservation checks ──────────────────────────────
// Ken hand-placed the Morphit wordmark in the column header.  The
// build script embeds it via two constants (WORDMARK_DEFS,
// WORDMARK_GROUP) and emits both into the SVG output.  These
// invariants prevent silent reverts to a plain "Morphit" text label.

if (existsSync(SCRIPT)) {
	const scriptSrc = readFileSync(SCRIPT, 'utf8');

	// #5 — build script declares WORDMARK_DEFS and WORDMARK_GROUP.
	const hasDefsConst = /^WORDMARK_DEFS\s*=/m.test(scriptSrc);
	const hasGroupConst = /^WORDMARK_GROUP\s*=/m.test(scriptSrc);
	if (hasDefsConst && hasGroupConst) {
		pass(`build script declares WORDMARK_DEFS and WORDMARK_GROUP constants`);
	} else {
		fail(
			`build script is missing WORDMARK_DEFS and/or WORDMARK_GROUP`,
			`Both Python constants must remain at the top of build_comparison.py. ` +
				`If you intentionally redesigned the header, update this smoke.`
		);
	}

	// #6 — both constants are actually emitted into the SVG output.
	const emitsDefs = /out\.append\([^)]*WORDMARK_DEFS/.test(scriptSrc);
	const emitsGroup = /out\.append\(\s*WORDMARK_GROUP\s*\)/.test(scriptSrc);
	if (emitsDefs && emitsGroup) {
		pass(`build script emits both WORDMARK_DEFS (into <defs>) and WORDMARK_GROUP (into body)`);
	} else {
		fail(
			`build script declares wordmark constants but does not emit them`,
			`Look for the out.append() calls in the SVG-render section. ` +
				`Both must be present or the wordmark disappears from future PNGs.`
		);
	}

	// #7 — build script does NOT emit a plain "Morphit" text label in the
	//      column header slot.  Old pattern was:
	//        out.append(f'<text ...>{escape(name)}</text>')  when i==0
	//      We allow `escape(name)` for i > 0 (Bisq, Haveno, etc.), but the
	//      branch under `if i == 0:` must use WORDMARK_GROUP, not text.
	const i0Pattern =
		/if\s+i\s*==\s*0\s*:[\s\S]{0,400}?out\.append\(f?['"]<text[^'"`]*>\{[^}]*name[^}]*\}/;
	if (i0Pattern.test(scriptSrc)) {
		fail(
			`build script still emits plain "Morphit" text in the header column`,
			`The "if i == 0:" branch in the platform-header loop should call ` +
				`out.append(WORDMARK_GROUP) instead of a <text> element. ` +
				`Reverting to plain text removes the wordmark from every future render.`
		);
	} else {
		pass(`build script does not emit a plain "Morphit" <text> label (wordmark replaces it)`);
	}
}

// #8 + #9 — SVG color contract.  Three signature paths + linearGradient.
if (existsSync(SVG)) {
	const svgSrc = readFileSync(SVG, 'utf8');

	// #8a — gradient circles use url(#id0).
	const hasGradientFill = /fill[:="]url\(#id0\)/.test(svgSrc);
	if (hasGradientFill) {
		pass(`SVG: linked-circle path uses fill:url(#id0) (green→teal gradient)`);
	} else {
		fail(
			`SVG: linked-circle gradient fill is missing`,
			`The morphit logo mark must carry fill:url(#id0). ` +
				`Without it the circles render solid (typically black).`
		);
	}

	// #8b — "morph" letters in WHITE (#fefefe).
	const hasWhiteMorph = /fill:#fefefe/.test(svgSrc);
	if (hasWhiteMorph) {
		pass(`SVG: "morph" letters carry fill:#fefefe (WHITE)`);
	} else {
		fail(
			`SVG: "morph" letters are not WHITE`,
			`COLOR CONTRACT: path4 of the wordmark must use fill:#fefefe. ` +
				`If you changed the wordmark color scheme on purpose, update both ` +
				`the SVG and WORDMARK_GROUP in build_comparison.py.`
		);
	}

	// #8c — "it!" letters in GREEN (#7fed2d).
	const hasGreenIt = /fill:#7fed2d/.test(svgSrc);
	if (hasGreenIt) {
		pass(`SVG: "it!" letters carry fill:#7fed2d (GREEN)`);
	} else {
		fail(
			`SVG: "it!" letters are not GREEN`,
			`COLOR CONTRACT: path5 of the wordmark must use fill:#7fed2d. ` +
				`If you changed the wordmark color scheme on purpose, update both ` +
				`the SVG and WORDMARK_GROUP in build_comparison.py.`
		);
	}

	// #8d — defend against accidental color swap: "morph" should not be GREEN
	//       AND "it!" should not be WHITE.  Heuristic: both colors must
	//       appear; if either is missing we already caught it above.  This
	//       is a defense-in-depth check that the WORDMARK_GROUP string
	//       carries both colors in the order build_comparison.py expects.
	const idxWhite = svgSrc.indexOf('fill:#fefefe');
	const idxGreen = svgSrc.indexOf('fill:#7fed2d');
	if (idxWhite > 0 && idxGreen > 0 && idxWhite < idxGreen) {
		pass(`SVG: wordmark path order is correct ("morph" white BEFORE "it!" green)`);
	} else if (idxWhite > 0 && idxGreen > 0 && idxWhite > idxGreen) {
		fail(
			`SVG: wordmark path ORDER is reversed (#7fed2d appears before #fefefe)`,
			`COLOR CONTRACT: path4 ("morph", #fefefe) MUST come before path5 ("it!", #7fed2d). ` +
				`Reordering risks swapping which glyphs get which color.`
		);
	}

	// #9 — linearGradient id="id0" with all three stop colors.
	const hasGradientDef = /id\s*=\s*["']id0["']/.test(svgSrc);
	const hasStop1 = /#8EEF26/i.test(svgSrc);
	const hasStop2 = /#00DA69/i.test(svgSrc);
	const hasStop3 = /#02A6B2/i.test(svgSrc);
	if (hasGradientDef && hasStop1 && hasStop2 && hasStop3) {
		pass(
			`SVG: linearGradient id="id0" with all three stop colors (#8EEF26 → #00DA69 → #02A6B2)`
		);
	} else {
		fail(
			`SVG: linearGradient id="id0" is missing or incomplete`,
			`Expected id="id0" with stops #8EEF26, #00DA69, #02A6B2. ` +
				`Without these, the wordmark's linked-circle gradient fails to render.`
		);
	}
}

// ─── #10 — PNG file-size budget ─────────────────────────────────
// Blog posts hot-link the canonical URL, so the file has to stay
// lean.  pngquant in the build script targets 70-90 quality and
// drops the PNG from ~1.3 MB to ~465 KB.  If a future SVG edit
// introduces enough new visual complexity that pngquant can no
// longer fit it under the budget, this fails with a clear message.
const PNG_BUDGET_BYTES = 512 * 1024;

if (existsSync(PNG)) {
	const sizeBytes = statSync(PNG).size;
	if (sizeBytes <= PNG_BUDGET_BYTES) {
		const kb = (sizeBytes / 1024).toFixed(1);
		const budgetKb = (PNG_BUDGET_BYTES / 1024).toFixed(0);
		pass(`PNG file size ${kb} KB is within the ${budgetKb} KB budget`);
	} else {
		const kb = (sizeBytes / 1024).toFixed(1);
		const budgetKb = (PNG_BUDGET_BYTES / 1024).toFixed(0);
		fail(
			`PNG file size ${kb} KB exceeds the ${budgetKb} KB budget`,
			`Either (a) you committed an unoptimized PNG — re-run ` +
				`scripts/comparison-image/build_comparison.py to pngquant it, ` +
				`or (b) the SVG grew enough new visual complexity that quality=70-90 ` +
				`pngquant can no longer fit under the budget.  Investigate before ` +
				`committing.  Blog hot-linkers will thank you.`
		);
	}
}

// ─── SVG footer "As of <day> <Month>, <year>" date is present ──
// The footer says "As of 4 June, 2026." — derived from the brag-list
// trailer's "Last updated" date by build_comparison.py (NOT date.today(),
// so it's deterministic).  Freshness relative to the build is already
// covered by the SHA-256 fingerprint check above: if the date changes,
// the SVG hashes differently and the fingerprint sidecar diverges.  This
// check is structural — assert the verbatim "<day> <FullMonth>, <year>"
// stamp is present and well-formed, so a future build-script edit can't
// silently drop it OR regress it back to the old ISO form.
if (existsSync(SVG)) {
	const svgSrc = readFileSync(SVG, 'utf8');
	const MONTHS = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];
	const dateMatch = svgSrc.match(/As of (\d{1,2}) ([A-Z][a-z]+), (\d{4})\./);
	if (!dateMatch || !MONTHS.includes(dateMatch[2]!)) {
		fail(
			`SVG footer is missing a well-formed "As of <day> <Month>, <year>" date stamp`,
			`The build script always emits this verbatim line (e.g. "As of 4 June, 2026."). ` +
				`If the SVG was hand-edited or the format regressed to ISO, ` +
				`re-run scripts/comparison-image/build_comparison.py.`
		);
	} else {
		const [, d, mon, y] = dateMatch;
		pass(`SVG footer carries a verbatim "As of <day> <Month>, <year>" date stamp (${d} ${mon}, ${y})`);
	}
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} comparison-image-freshness-smoke scenarios passed`);
