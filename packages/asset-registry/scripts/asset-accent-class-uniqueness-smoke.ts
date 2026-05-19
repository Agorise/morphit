#!/usr/bin/env tsx
/**
 * asset-accent-class-uniqueness-smoke.
 *
 * Cp42-H-55 closure: at cp42 the deep-deep surfaced that XMR and
 * DAI both used `text-orange-500` — a pre-existing collision that
 * dated to cp31 (DAI addition).  Fixed inline at cp42 by reassigning
 * DAI to `text-yellow-600` (matches DAI's golden-yellow brand color).
 *
 * This smoke pins the invariant going forward: no two registered
 * assets may share an accentClass.  Accent colors are the primary
 * visual disambiguator between asset tabs in AddressShareModal,
 * FundsSentModal, and ChatMessage pills; a collision causes
 * lookalike asset chips and increases visual-confusion risk
 * (same threat class as LL #50 same-format-different-chain).
 */

import { ASSETS as FRONTEND } from '../../../apps/web/src/lib/assets/registry';

let failed = 0;
let passed = 0;

console.log('\n── asset accent-class uniqueness smoke ───────────────\n');

const seen = new Map<string, string[]>();
for (const a of FRONTEND) {
	const owners = seen.get(a.accentClass) ?? [];
	owners.push(a.ticker);
	seen.set(a.accentClass, owners);
}

let collisions = 0;
for (const [accent, owners] of seen.entries()) {
	if (owners.length > 1) {
		console.error(`  ✗ COLLISION: ${accent} used by ${owners.join(', ')}`);
		collisions++;
		failed++;
	}
}

if (collisions === 0) {
	console.log(`  ✓ all ${FRONTEND.length} assets have unique accent classes`);
	passed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('\nasset-accent-class-uniqueness smoke FAILED');
	process.exit(1);
}
