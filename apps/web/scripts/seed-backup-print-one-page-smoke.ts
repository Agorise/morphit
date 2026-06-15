#!/usr/bin/env tsx
/**
 * Smoke for the "My Morphit backup card" one-page print layout.
 *
 * History:
 *   - cp249 fixed "huge blank bands top and bottom" by isolating the card
 *     for print with `visibility: hidden` everywhere + collapsing the
 *     `#svelte` app subtree to zero height, with the card `position: fixed`
 *     so it escaped the clip.
 *   - cp261: that approach printed a SINGLE BLANK PAGE on print-to-PDF
 *     engines that drop a `position: fixed` element whose entire normal-flow
 *     context is zero-height. Replaced with a robust approach — the card is
 *     PORTALED to be a direct child of <body> (the bodyPortal action) and
 *     printed in NORMAL FLOW, while every OTHER direct child of <body> is
 *     hidden. Nothing left to clip or drop.
 *
 * SvelteKit renders the whole app under `<div id="svelte"
 * style="display: contents">` (app.html), so the card is buried deep in
 * that subtree — which is exactly why it must be portaled out to <body>
 * for the "hide the other body children" isolation to work.
 *
 * Source-level smoke (the fix is CSS + a tiny JS action; no browser in CI).
 * It guards every load-bearing piece so a future refactor can't silently
 * reintroduce the blank page — in particular it FAILS if the card ever goes
 * back to `position: fixed`.
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

// ── Premise: app.html renders the app under #svelte display:contents.
// The card is buried in that subtree, which is WHY it is portaled out to
// <body>.  If this premise changes the portal strategy needs a rethink.
check(
	'app.html renders the app subtree under #svelte (display:contents)',
	/id="svelte"[^>]*display:\s*contents/.test(appHtml),
	'the card is portaled out of this subtree for printing'
);

// ── 1. Trigger <-> stylesheet coupling on the shared html flag ───────
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

// ── 2. The card is portaled to be a direct child of <body> ───────────
check(
	'a bodyPortal action moves the card to document.body',
	/function\s+bodyPortal\s*\(/.test(src) &&
		/document\.body\.appendChild\s*\(\s*node\s*\)/.test(src),
	'the card must live at body level for the body-child isolation to work'
);
check(
	'the printable card uses the bodyPortal action',
	/class="morphit-seed-print-card"[^>]*\buse:bodyPortal\b/.test(src),
	'without use:bodyPortal the card stays buried in #svelte'
);

// ── 3. Print isolation: hide every OTHER direct child of <body> ──────
check(
	'print mode hides every direct body child except the card',
	/body\s*>\s*\*:not\(\.morphit-seed-print-card\)\)\s*\{[^}]*display:\s*none/.test(src),
	'this is what leaves the card alone on the page'
);

// ── 4. Card prints in NORMAL FLOW — NOT position:fixed (the bug) ─────
check(
	'printed card does NOT use position: fixed (cp261 blank-page regression)',
	!/\.morphit-seed-print-card\s*\{[^}]*position:\s*fixed/.test(src),
	'a fixed card in a zero-height flow is dropped by some print-to-PDF engines'
);
check(
	'printed card does NOT use position: absolute either',
	!/\.morphit-seed-print-card\s*\{[^}]*position:\s*absolute/.test(src)
);
check(
	'printed card does NOT use an inset: 0 declaration (full-page stretch)',
	!/inset:\s*0\s*;/.test(src)
);
check(
	'no leftover #svelte zero-height collapse hack',
	!/#svelte\)\s*\{[^}]*height:\s*0/.test(src),
	'the portal approach does not collapse the app subtree'
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
