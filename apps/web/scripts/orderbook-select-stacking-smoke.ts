#!/usr/bin/env tsx
/**
 * orderbook-select-stacking-smoke.ts
 *
 * The orderbook filter bar stacks THREE custom selects on one page —
 * AssetFilterSelect, FiatCurrencySelect, PaymentFilterSelect (rendered in
 * that DOM order inside /[lang]/orderbook). Each opens an absolutely-
 * positioned dropdown over a full-screen blur scrim.
 *
 * cp256 ported the FaqSearch scrim pattern onto all three but gave every
 * root a BARE `relative z-30`. That shipped a stacking bug (first seen live
 * on beta16): each root is its own `relative` stacking context, and sibling
 * contexts at EQUAL z-index paint in DOM ORDER — so an open dropdown was
 * painted UNDER the filter controls that follow it. On mobile the closed
 * Payment field's pills (SPEI / ShebaPay) bled straight through the middle
 * of the OPEN fiat-currency list. A cache clear could not fix it: the bug
 * is in the built component, not a stale asset.
 *
 * The fix (cp260) makes each root z CONDITIONAL on `open`:
 *   • OPEN   → z-30  (ABOVE the z-20 scrim, so the dropdown overlays)
 *   • CLOSED → z-10  (BELOW the z-20 scrim, so an idle sibling can neither
 *                     paint over the active dropdown nor swallow the tap —
 *                     a tap on it hits the scrim and closes the open one)
 *
 * These invariants pin that layering so a future edit can't silently
 * regress to the bare-z-30 pattern. Whether the dropdowns LOOK right is a
 * humans-eyes-on-it task in the persona walk-through / a live deploy; this
 * proves the source carries the structural z-order the fix depends on.
 *
 *   I-1  Each select's root is `relative {open ? 'z-OPEN' : 'z-CLOSED'}`,
 *        with z-OPEN strictly ABOVE the scrim (20) and z-CLOSED strictly
 *        BELOW it. No bare, non-conditional z on the root.
 *   I-2  Each select still renders the full-screen `fixed inset-0 z-20`
 *        blur scrim (the outside-close click-catcher).
 *   I-3  Each select's dropdown panel is `absolute z-20` (positioned
 *        within its own root, so the conditional root z is what lifts it
 *        above sibling selects).
 *   I-4  The exact regressed root — `class="relative z-30" bind:this=
 *        {rootEl}` — appears in NONE of the three.
 *
 * cp282 added a SECOND outside-close mechanism on top of the scrim,
 * because the scrim alone can't catch every outside press: the sticky
 * page header paints at z-40, ABOVE the z-20 scrim, so a press in the
 * header strip never reached the scrim and the menu stayed stuck open
 * (Ken hit this live during login testing). The fix is a document-level
 * `pointerdown` listener (CAPTURE phase), gated on `open`, that closes
 * the menu when the press lands outside `rootEl`. `pointerdown` (not
 * `click`) is deliberate: it fires BEFORE a picked multi-select option
 * runs its handler and detaches its own node — the exact race the scrim
 * was originally working around — so option presses still register as
 * INSIDE rootEl. These invariants pin that handler so a future edit
 * can't silently drop it (regressing to scrim-only) or weaken it to a
 * racing `click`/bubble-phase listener:
 *
 *   I-5  Each select registers a capture-phase `document` `pointerdown`
 *        listener bound to a closer that sets `open = false` when the
 *        press is outside `rootEl`, gated on `open`, with a matching
 *        `removeEventListener` cleanup. (A drop to scrim-only, a switch
 *        to `click`, or losing the capture flag each fail this.)
 *   I-6  No select reintroduces a document-level `click` outside-close
 *        listener — the racing pattern cp282 replaced. (The scrim's own
 *        `onclick=` element attribute is NOT a document listener and is
 *        unaffected.)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const SCRIM_Z = 20; // the fixed inset-0 blur scrim

const SELECTS = ['AssetFilterSelect', 'FiatCurrencySelect', 'PaymentFilterSelect'] as const;

const sources = new Map<string, string>(
	SELECTS.map((name) => [
		name,
		readFileSync(resolve(REPO, `apps/web/src/lib/components/${name}.svelte`), 'utf8')
	])
);

// Matches the root element of a select: a `relative` div carrying the
// conditional z and the `bind:this={rootEl}` handle. Captures the two z
// classes (open branch, closed branch).
const ROOT_RE =
	/<div class="relative \{open \? '(z-\d+)' : '(z-\d+)'\}"\s+bind:this=\{rootEl\}>/;

// The exact bug pattern cp256 shipped.
const REGRESSED_ROOT_RE = /<div class="relative z-30"\s+bind:this=\{rootEl\}>/;

// cp282 capture-phase pointerdown outside-close handler. Whitespace-
// tolerant so a reformat doesn't false-fail; the listener arg name is
// matched as a bare identifier (any name works as long as it's the same
// one passed to add + remove).
const POINTERDOWN_ADD_RE =
	/document\.addEventListener\(\s*['"]pointerdown['"]\s*,\s*(\w+)\s*,\s*true\s*\)/;
const POINTERDOWN_REMOVE_RE =
	/document\.removeEventListener\(\s*['"]pointerdown['"]\s*,\s*(\w+)\s*,\s*true\s*\)/;
// The closer body: closes when the press is outside rootEl.
const OUTSIDE_CLOSE_RE = /!rootEl\.contains\([^)]*\)\)\s*open\s*=\s*false/;
// The open-gate that prevents the listener from being attached while
// the menu is closed (no idle global listener).
const OPEN_GATE_RE = /if\s*\(!open\)\s*return;/;
// The racing pattern cp282 replaced — a DOCUMENT-level click listener.
// Must NOT reappear. (Element `onclick=` attributes like the scrim's are
// not document listeners and don't match.)
const DOC_CLICK_RE = /document\.addEventListener\(\s*['"]click['"]/;

function zNum(cls: string): number {
	const m = cls.match(/z-(\d+)/);
	return m ? Number(m[1]) : NaN;
}

interface Scenario {
	name: string;
	test: () => string | null;
}

const scenarios: Scenario[] = [
	{
		name: 'I-1: each root z is conditional — open ABOVE the scrim, closed BELOW it',
		test: () => {
			for (const name of SELECTS) {
				const src = sources.get(name)!;
				const m = src.match(ROOT_RE);
				if (!m) {
					return `${name}: root is not \`relative {open ? 'z-OPEN' : 'z-CLOSED'}\` with bind:this={rootEl}`;
				}
				const openZ = zNum(m[1]!);
				const closedZ = zNum(m[2]!);
				if (!(openZ > SCRIM_Z)) {
					return `${name}: open-branch z (${m[1]}) must be ABOVE the scrim (z-${SCRIM_Z}) so the dropdown overlays`;
				}
				if (!(closedZ < SCRIM_Z)) {
					return `${name}: closed-branch z (${m[2]}) must be BELOW the scrim (z-${SCRIM_Z}) so an idle sibling can't cover the open dropdown`;
				}
			}
			return null;
		}
	},
	{
		name: 'I-2: each select keeps the full-screen z-20 blur scrim',
		test: () => {
			for (const name of SELECTS) {
				const src = sources.get(name)!;
				if (!/class="fixed inset-0 z-20 [^"]*backdrop-blur-sm"/.test(src)) {
					return `${name}: missing the \`fixed inset-0 z-20 … backdrop-blur-sm\` outside-close scrim`;
				}
			}
			return null;
		}
	},
	{
		name: 'I-3: each dropdown panel is `absolute z-20` (lifted by the root, not its own z)',
		test: () => {
			for (const name of SELECTS) {
				const src = sources.get(name)!;
				if (!/class="absolute z-20 mt-1 max-h-72 w-full/.test(src)) {
					return `${name}: dropdown panel is not the expected \`absolute z-20 mt-1 max-h-72 w-full …\``;
				}
			}
			return null;
		}
	},
	{
		name: 'I-4: the regressed bare `relative z-30` root is gone from all three',
		test: () => {
			const offenders = SELECTS.filter((name) => REGRESSED_ROOT_RE.test(sources.get(name)!));
			if (offenders.length) {
				return `bare non-conditional root z-30 (the cp256 stacking bug) still present in: ${offenders.join(', ')}`;
			}
			return null;
		}
	},
	{
		name: 'I-5: each select keeps the cp282 capture-phase pointerdown outside-close handler (gated + cleaned up)',
		test: () => {
			for (const name of SELECTS) {
				const src = sources.get(name)!;
				const addM = src.match(POINTERDOWN_ADD_RE);
				if (!addM) {
					return `${name}: missing the capture-phase \`document.addEventListener('pointerdown', …, true)\` outside-close listener (a sticky-header press can't reach the scrim, so the scrim alone leaves the menu stuck open)`;
				}
				const removeM = src.match(POINTERDOWN_REMOVE_RE);
				if (!removeM) {
					return `${name}: pointerdown listener is added but never removed — missing the \`removeEventListener('pointerdown', …, true)\` cleanup (leaks a global listener)`;
				}
				if (addM[1] !== removeM[1]) {
					return `${name}: add/remove use different handler references (${addM[1]} vs ${removeM[1]}) — removeEventListener won't detach the listener it added`;
				}
				if (!OUTSIDE_CLOSE_RE.test(src)) {
					return `${name}: the listener doesn't close on an outside-of-rootEl press (\`!rootEl.contains(…)) open = false\`)`;
				}
				if (!OPEN_GATE_RE.test(src)) {
					return `${name}: the outside-close effect isn't gated on \`if (!open) return;\` — would attach a global listener even while closed`;
				}
			}
			return null;
		}
	},
	{
		name: 'I-6: no select reintroduces a racing document-level `click` outside-close listener (cp282 replaced it with pointerdown)',
		test: () => {
			const offenders = SELECTS.filter((name) => DOC_CLICK_RE.test(sources.get(name)!));
			if (offenders.length) {
				return `document-level \`click\` outside-close listener (the option-detach race cp282 fixed) reintroduced in: ${offenders.join(', ')}`;
			}
			return null;
		}
	}
];

console.log(
	'\n── orderbook-select-stacking smoke (cp260 z-order + cp282 outside-close) ──\n'
);

let failed = 0;
let passed = 0;
for (const s of scenarios) {
	const err = s.test();
	if (err === null) {
		console.log(`  ✓ ${s.name}`);
		passed++;
	} else {
		console.log(`  ✗ ${s.name}`);
		console.log(`      ${err}`);
		failed++;
	}
}

console.log('');
console.log('──────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} orderbook-select-stacking scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed}/${passed + failed} scenarios failed`);
process.exit(1);
