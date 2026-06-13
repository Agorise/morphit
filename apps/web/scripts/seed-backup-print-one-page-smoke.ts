#!/usr/bin/env tsx
/**
 * Smoke for the "My Morphit backup card" one-page print layout.
 *
 * Background — the "huge blank bands top and bottom" bug (cp249):
 *
 *   SeedBackupPrint.svelte renders a printable seed-phrase card during
 *   /onboarding.  It used to isolate the card for printing with
 *   `visibility: hidden` on every element + the card positioned
 *   `absolute; inset: 0`.  `visibility: hidden` hides PAINT but keeps
 *   LAYOUT boxes, so the (tall) onboarding review page kept generating
 *   page boxes: the card landed inside a multi-page document with blank
 *   bands fore and aft, and `inset: 0` stretched the card itself to a
 *   full page so even its own box was mostly empty.
 *
 *   The fix isolates in two dimensions:
 *     1. PAINT — hide everything, re-show only the card.
 *     2. PAGINATION — collapse the `#svelte` app subtree (which is
 *        `display: contents` in app.html) to a zero-height,
 *        overflow-clipped box so it generates no page boxes.  The card
 *        is `position: fixed`, so its containing block is the page box,
 *        not `#svelte` — it escapes the clip and prints alone on ONE
 *        page sized to its own content (no `inset: 0` stretch).
 *
 * This is a source-level smoke (the fix is CSS + a tiny JS trigger; no
 * browser is available in CI).  It guards every load-bearing piece of
 * the fix so a future refactor can't silently reintroduce the blank
 * bands:
 *   - the `morphit-printing-seed` <html> flag couples the JS trigger to
 *     the print stylesheet (both sides must use the same class);
 *   - the `#svelte` subtree is collapsed (height:0 + overflow:hidden)
 *     — the pagination-isolation half;
 *   - the card is `position: fixed`, NOT `absolute`/`inset: 0`;
 *   - a containing-block guard neutralises transform/filter/contain on
 *     ancestors so the fixed card can't be re-anchored + clipped;
 *   - the card is `display: none` on screen.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const src = readFileSync(
	join(REPO_ROOT, 'apps/web/src/lib/components/SeedBackupPrint.svelte'),
	'utf-8'
);
const appHtml = readFileSync(join(REPO_ROOT, 'apps/web/src/app.html'), 'utf-8');

const failures: string[] = [];
let checks = 0;

function check(label: string, cond: boolean, detail = ''): void {
	checks++;
	if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

// ── Premise: app.html really does render the app under display:contents.
// If this ever changes, the whole "collapse #svelte" strategy needs a
// rethink, so assert the premise the fix is built on.
check(
	'app.html renders the app subtree under #svelte (display:contents)',
	/id="svelte"[^>]*display:\s*contents/.test(appHtml),
	'the collapse-#svelte print strategy depends on this'
);

// ── 1. Trigger ↔ stylesheet coupling on the shared html flag ─────────
check(
	'JS trigger adds the morphit-printing-seed flag',
	src.includes("classList.add('morphit-printing-seed')")
);
check(
	'JS trigger removes the flag on afterprint',
	src.includes("classList.remove('morphit-printing-seed')") && src.includes("'afterprint'"),
	'leaving the flag set would keep the page hidden after printing'
);
check('JS trigger actually calls window.print()', /window\.print\(\)/.test(src));
check(
	'print stylesheet keys off the same morphit-printing-seed flag',
	/@media\s+print/.test(src) && src.includes('html.morphit-printing-seed')
);

// ── 2. Pagination isolation: the #svelte subtree is collapsed ────────
// `#svelte)` (no trailing ` *`) is the collapse rule; `#svelte *)` is
// the guard rule below.  Match the collapse rule specifically.
check(
	'collapses the #svelte subtree to zero height (pagination isolation)',
	/#svelte\)\s*\{[^}]*height:\s*0[^}]*overflow:\s*hidden/.test(src),
	'this is the half that removes the blank bands / extra pages'
);

// ── 3. Card positioning: fixed + content height, NOT absolute/inset ──
const cardRuleHasFixed = /\.morphit-seed-print-card\s*\{[^}]*position:\s*fixed/.test(src);
check('printed card uses position: fixed', cardRuleHasFixed, 'so it escapes the #svelte clip');
check(
	'printed card does NOT use position: absolute (the old approach)',
	!/\.morphit-seed-print-card\s*\{[^}]*position:\s*absolute/.test(src)
);
check(
	'printed card does NOT use an inset: 0 declaration (full-page stretch)',
	!/inset:\s*0\s*;/.test(src),
	'inset: 0 stretches the card to a full page → trailing whitespace'
);

// ── 4. Containing-block guard so the fixed card stays page-anchored ──
check(
	'guard neutralises transform on app descendants',
	/#svelte \*\)\s*\{[^}]*transform:\s*none/.test(src),
	'a transformed ancestor would re-anchor + clip the fixed card'
);
check(
	'guard also neutralises contain (a containing-block trigger)',
	/#svelte \*\)\s*\{[^}]*contain:\s*none/.test(src)
);

// ── 5. Card is hidden on screen (print-only) ─────────────────────────
check(
	'card is display:none on screen',
	/\.morphit-seed-print-card\s*\{\s*display:\s*none/.test(src),
	'the seed is already shown in the review card; this is print-only'
);

// ── Report ───────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(`seed-backup-print-one-page-smoke: FAIL (${failures.length}/${checks})`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log(`✓ all ${checks} seed-backup-print-one-page-smoke scenarios passed`);
