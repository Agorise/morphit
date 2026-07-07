#!/usr/bin/env tsx
/**
 * logo-bling-invariants-smoke.ts
 *
 * MorphitLogoBling was reworked in cp228: the old <canvas> 3-body
 * particle animation was removed entirely.  The component is now a PURE
 * presentational wrapper — a static wordmark <img> plus an OPTIONAL
 * letterform-tracing "shine" (a masked CSS sweep) that only the small
 * header wordmark opts into.  The homepage hero uses the same component
 * WITHOUT the shine, so it is fully static.
 *
 * These invariants pin that new design (rewritten from the cp115
 * canvas-era invariants, the same way asset-select-coverage was
 * rewritten for the cp208 listbox):
 *
 *   I-1  The retired animation is GONE — no canvas element, no
 *        requestAnimationFrame loop, no IntersectionObserver, no
 *        PARTICLES physics.  (A regression that re-introduced the canvas
 *        would reintroduce the per-frame CPU cost priority #4 rejected.)
 *
 *   I-2  The wordmark <img> keeps alt="Morphit" — screen-reader output is
 *        unchanged from every prior header.
 *
 *   I-3  The shine is OPTIONAL: a `shine` prop (default false) gates an
 *        `{#if shine}` block.  This is what lets the hero stay static
 *        while the header glints — without it the effect would be
 *        unconditional.
 *
 *   I-4  The shine layer is decorative (aria-hidden="true") AND MASKED to
 *        the wordmark shape (mask-image / -webkit-mask-image driven by the
 *        wordmark src), so the moving highlight traces the letterforms
 *        rather than sweeping a bare rectangle.
 *
 *   I-5  `prefers-reduced-motion: reduce` removes the shine (a static
 *        wordmark) — vestibular-disorder accessibility + the grandma-
 *        friendliness "no jittery motion on low-end devices" rule.
 *
 * Why grep-of-source rather than DOM-driven test: the shine is a pure CSS
 * animation; whether the glint LOOKS right is a humans-eyes-on-it task in
 * the persona walk-through.  These checks prove the source carries the
 * structural guarantees the design demands.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const COMPONENT = resolve(REPO, 'apps/web/src/lib/components/MorphitLogoBling.svelte');

const src = readFileSync(COMPONENT, 'utf8');

interface Scenario {
	name: string;
	test: () => string | null;
}

const scenarios: Scenario[] = [
	{
		name: 'I-1: retired canvas/RAF/observer/physics animation is gone',
		test: () => {
			const banned: [RegExp, string][] = [
				[/<canvas/, 'a <canvas> element'],
				[/requestAnimationFrame\s*\(/, 'a requestAnimationFrame loop'],
				[/new\s+IntersectionObserver/, 'an IntersectionObserver'],
				[/\bPARTICLES\b/, 'the PARTICLES physics array']
			];
			const found = banned.filter(([re]) => re.test(src)).map(([, label]) => label);
			if (found.length) {
				return `the 3-body animation should be removed, but found: ${found.join(', ')}`;
			}
			return null;
		}
	},
	{
		name: 'I-2: wordmark <img> retains alt="Morphit"',
		test: () => {
			if (!/<img[\s\S]{0,200}?alt="Morphit"/.test(src)) {
				return 'wordmark <img> with alt="Morphit" not found';
			}
			return null;
		}
	},
	{
		name: 'I-3: shine is optional — `shine` prop gates an {#if shine} block',
		test: () => {
			if (!/\bshine\??\s*:\s*boolean/.test(src) && !/\bshine\b[\s\S]{0,40}?\$props/.test(src)) {
				return 'no `shine` prop declared on the component';
			}
			if (!/\{#if\s+shine\s*\}/.test(src)) {
				return 'the shine layer is not gated behind {#if shine} (so the hero could not stay static)';
			}
			return null;
		}
	},
	{
		name: 'I-4: shine layer is aria-hidden AND masked to the wordmark shape',
		test: () => {
			// The shine <span> must be decorative.
			if (!/morphit-logo-bling-shine[\s\S]{0,200}?aria-hidden="true"/.test(src) &&
				!/aria-hidden="true"[\s\S]{0,200}?morphit-logo-bling-shine/.test(src)) {
				return 'shine layer is not aria-hidden="true"';
			}
			// And clipped to the letterforms via a wordmark-driven mask.
			if (!/mask-image:\s*var\(--morphit-wordmark\)/.test(src)) {
				return 'shine is not masked to the wordmark (mask-image: var(--morphit-wordmark) missing)';
			}
			if (!/-webkit-mask-image:\s*var\(--morphit-wordmark\)/.test(src)) {
				return 'shine mask missing the -webkit-mask-image prefix (Safari/WebKit)';
			}
			if (!/--morphit-wordmark:\s*url\(/.test(src)) {
				return 'the --morphit-wordmark mask source url is not set from the wordmark src';
			}
			return null;
		}
	},
	{
		name: 'I-5: prefers-reduced-motion removes the shine',
		test: () => {
			const m = src.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/);
			if (!m) {
				return 'no @media (prefers-reduced-motion: reduce) block found';
			}
			const block = m[1] ?? '';
			if (!/morphit-logo-bling-shine/.test(block)) {
				return 'reduced-motion block does not target the shine layer';
			}
			if (!/(display:\s*none|animation:\s*none)/.test(block)) {
				return 'reduced-motion block does not disable the shine (no display:none / animation:none)';
			}
			return null;
		}
	}
];

console.log('\n── logo-bling-invariants smoke (cp228 — static wordmark + masked shine) ──\n');

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
	console.log(`✓ all ${passed} logo-bling-invariants scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed}/${passed + failed} scenarios failed`);
process.exit(1);
