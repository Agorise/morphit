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
	}
];

console.log('\n── orderbook-select-stacking smoke (cp260 — multi-select z-order) ──\n');

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
