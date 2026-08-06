#!/usr/bin/env tsx
/*
 * address-share-modal-ux — v1.5.0 (tt.txt B) guard.
 *
 * Three findings from Ken's mobile testing of "Share crypto address":
 *
 *   B1. It rendered ONE TAB-BUTTON PER ASSET — 16 of them, each `flex-1` —
 *       which wrapped into a wall of blocks. Replaced with a coin SELECT
 *       (AssetChoiceSelect) showing each coin's logo + name.
 *   B2. The card had NO max-height and NO overflow, so on a phone the
 *       content ran past the viewport and could not be scrolled — the Send
 *       button was simply unreachable. Now capped + scrollable, matching the
 *       sibling chat modals (MailingAddressModal / ShipmentModal).
 *   B3. Real-time entry validation (this already existed and MUST stay):
 *       a red border + a per-asset inline error as the user types.
 *
 * This sentinel locks all three so a future edit can't quietly undo them,
 * and pins the coin-name/logo single-source (the asset registry) so the
 * picker can never drift from the orderbook's labels.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');

let pass = 0;
let fail = 0;
function ok(msg: string): void {
	pass++;
	console.log(`  ✓ ${msg}`);
}
function bad(scope: string, msg: string): void {
	fail++;
	console.log(`  ✗ ${scope}: ${msg}`);
}

const modal = readFileSync(resolve(WEB, 'src/lib/components/AddressShareModal.svelte'), 'utf8');
const select = readFileSync(resolve(WEB, 'src/lib/components/AssetChoiceSelect.svelte'), 'utf8');
const flatModal = modal.replace(/\s+/g, ' ');
const flatSelect = select.replace(/\s+/g, ' ');

// ── B1 — coin select, not a wall of per-asset tabs ──────────────────
if (/<AssetChoiceSelect/.test(flatModal)) {
	ok('B1: the asset picker is the coin SELECT (AssetChoiceSelect)');
} else {
	bad('B1', 'AddressShareModal no longer uses AssetChoiceSelect — the per-asset block wall would be back (tt.txt B1).');
}
if (/role="tablist"/.test(flatModal)) {
	bad(
		'B1',
		'a role="tablist" is back in AddressShareModal — that is the 16-tab wall Ken asked to replace with a select (tt.txt B1).'
	);
} else {
	ok('B1: no per-asset tablist remains');
}

// The picker's labels + logos must come from the ONE asset registry, so a
// coin can never read differently here than in the orderbook.
if (/from '\$lib\/assets\/registry'/.test(flatSelect) && /logoSvgPath/.test(flatSelect)) {
	ok('B1: coin names + logos come from the shared asset registry (single source of truth)');
} else {
	bad('B1', 'AssetChoiceSelect no longer sources names/logos from $lib/assets/registry — labels can drift from the orderbook.');
}
// Logos must stay lazy: a user who never opens the menu pays no icon bytes.
if (/loading="lazy"/.test(flatSelect)) {
	ok('B1: option logos stay lazy-loaded (footprint #4)');
} else {
	bad('B1', 'the option logos are no longer loading="lazy" — every render would pay for 16 icons.');
}

// ── B2 — the modal fits a phone and scrolls ─────────────────────────
// v1.7.7 — pins the REQUIREMENT (capped AND scrollable), not the exact class
// string. The original spelled out `class="card max-h-[95vh] w-full max-w-md
// overflow-y-auto"` verbatim, so it failed the moment the cap was corrected from
// `vh` to `dvh` — a change that STRENGTHENS the very property B2 exists to
// protect. (On a phone `vh` counts the space behind the URL bar, so a 95vh card
// can still stand taller than the visible viewport: B2's own bug, in miniature.)
// A guard that fails on a correct fix teaches people to edit the guard, which is
// how it ends up guarding nothing.
const capped = /class="card[^"]*\bmax-h-\[\d+dvh\]/.test(flatModal);
const scrolls = /class="card[^"]*\boverflow-y-auto\b/.test(flatModal);
if (capped && scrolls) {
	ok('B2: the card is height-capped (dvh) and scrollable (fits a phone; Send stays reachable)');
} else {
	bad(
		'B2',
		`the modal card must cap its height in dvh AND scroll, or on a phone the content runs past the viewport with no way to reach Send (tt.txt B2). capped=${capped} scrolls=${scrolls}`
	);
}

// ── B3 — real-time validation stays ─────────────────────────────────
if (/{#if addressErrorKey}/.test(flatModal)) {
	ok('B3: the inline per-asset address error still renders as the user types');
} else {
	bad('B3', 'the inline address error is gone — entries would fail silently at submit instead of validating live.');
}
if (/{addressBorderClass}/.test(flatModal)) {
	ok('B3: the invalid-entry red border still renders');
} else {
	bad('B3', 'the red invalid-address border is gone (tt.txt B3 — verify entries in real time).');
}

// ── Escape must not blow away the whole dialog ──────────────────────
// The select lives INSIDE a modal that closes on Escape; if the listbox
// didn't stop propagation, dismissing the coin menu would nuke the form.
if (/e\.stopPropagation\(\)/.test(flatSelect)) {
	ok('Escape inside the open coin menu closes only the menu, not the whole modal');
} else {
	bad(
		'a11y',
		"AssetChoiceSelect no longer stops Escape from propagating — pressing Escape to dismiss the coin list would close the entire Share-address modal and lose the user's input."
	);
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
