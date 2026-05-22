#!/usr/bin/env tsx
/**
 * logo-bling-invariants-smoke.ts
 *
 * Verifies that MorphitLogoBling.svelte preserves its 5 load-bearing
 * invariants:
 *
 *   I-1  Exactly 3 particles in the simulation (the "3-body chaos"
 *        choice — 2 particles orbit deterministically, 4+ smear into
 *        an indistinct blur).
 *
 *   I-2  `prefers-reduced-motion: reduce` is honored — the component
 *        bails out to a static fallback rather than running the RAF
 *        loop.  Without this, the component fails the vestibular-
 *        disorder accessibility guarantee AND the grandma-friendliness
 *        priority's "no jittery motion on low-end devices" rule.
 *
 *   I-3  IntersectionObserver pauses the RAF loop when the header is
 *        scrolled out of viewport.  Without this, a long page with a
 *        sticky header still pays per-frame CPU for the simulation
 *        that nobody can see.  CPU = battery on mobile (priority #4).
 *
 *   I-4  The canvas is aria-hidden="true".  Decorative motion should
 *        not generate screen-reader noise.  The wordmark <img> retains
 *        its alt so accessibility output is unchanged from the prior
 *        plain-image header.
 *
 *   I-5  Particles are painted BEHIND the wordmark (canvas z-index 0,
 *        wordmark z-index 1).  Reversed stacking would put the
 *        particles on top of the letterforms, breaking legibility.
 *
 * Why grep-of-source rather than DOM-driven test: this component
 * uses canvas + RAF + IntersectionObserver, all of which require a
 * full DOM environment + animation timing to test behaviorally.
 * Pre-launch budget says: structural defenses prove the source has
 * the invariants the design demands; running the actual simulation
 * is a humans-eyes-on-it task during the persona walk-through.
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
		name: 'I-1: initParticles creates exactly 3 particles',
		test: () => {
			// The init loop is `for (let i = 0; i < 3; i++)`.  Anything
			// other than 3 breaks the design rationale.
			const m = src.match(/for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*\{[\s\S]*?PARTICLES\.push/);
			if (!m) {
				return 'could not locate the initParticles for-loop';
			}
			const n = parseInt(m[1] ?? '', 10);
			if (n !== 3) {
				return `expected exactly 3 particles, found ${n}`;
			}
			return null;
		}
	},
	{
		name: 'I-2: prefers-reduced-motion is matched + honored',
		test: () => {
			if (!src.includes("'(prefers-reduced-motion: reduce)'")) {
				return 'matchMedia query for prefers-reduced-motion not found';
			}
			if (!src.includes('drawStaticFallback')) {
				return 'drawStaticFallback function (reduced-motion path) not found';
			}
			// Verify the static fallback is actually called when
			// reducedMotion is true.  Look for the conditional path.
			if (!/reducedMotion\s*\)\s*\{[\s\S]*?drawStaticFallback\(\)/.test(src)) {
				return 'drawStaticFallback is defined but not invoked from the reduced-motion conditional';
			}
			return null;
		}
	},
	{
		name: 'I-3: IntersectionObserver pauses RAF on viewport exit',
		test: () => {
			if (!src.includes('IntersectionObserver(')) {
				return 'IntersectionObserver instantiation not found';
			}
			// The observer's callback should call stopLoop() on isIntersecting=false.
			if (!/isIntersecting[\s\S]{0,200}?stopLoop\(\)/.test(src)) {
				return 'IntersectionObserver callback does not call stopLoop() on viewport exit';
			}
			return null;
		}
	},
	{
		name: 'I-4: canvas carries aria-hidden="true"',
		test: () => {
			if (!/<canvas[\s\S]{0,200}?aria-hidden="true"/.test(src)) {
				return 'canvas element does not have aria-hidden="true"';
			}
			return null;
		}
	},
	{
		name: 'I-5: canvas painted BEHIND wordmark (z-index ordering)',
		test: () => {
			// Both rules must be present in the <style> block:
			//   .morphit-logo-bling-canvas { z-index: 0; }
			//   .morphit-logo-bling-wordmark { z-index: 1; }
			const canvasRule = /\.morphit-logo-bling-canvas\s*\{[\s\S]*?z-index:\s*0/;
			const wordmarkRule = /\.morphit-logo-bling-wordmark\s*\{[\s\S]*?z-index:\s*1/;
			if (!canvasRule.test(src)) {
				return 'canvas z-index: 0 rule missing or has different value';
			}
			if (!wordmarkRule.test(src)) {
				return 'wordmark z-index: 1 rule missing or has different value';
			}
			return null;
		}
	}
];

console.log('\n── logo-bling-invariants smoke (cp115) ──────────────────\n');

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
