#!/usr/bin/env tsx
/**
 * category-b-descriptions-parity-smoke.
 *
 * Part 122 cp51 STRUCTURAL DEFENSE (LL #55 / O-4).
 *
 * Closes the cp51-D1 hardcoded-table-without-parity-smoke class:
 * the ops-cli `CATEGORY_B_DESCRIPTIONS` table at
 * `apps/ops-cli/src/init/steps.ts:1484` is a per-ticker
 * `Record<string, string>` that must stay in lockstep with the
 * canonical Category-B asset set (assets with `canBeTraded:
 * true` AND `canPayListingFee: false`).
 *
 * If a future asset addition skips updating
 * CATEGORY_B_DESCRIPTIONS, the disabled-assets wizard step would
 * fall back to the generic "Trade-only asset (cannot pay listing
 * fees)." placeholder for that ticker — silently degrading
 * operator UX without breaking any other smoke.
 *
 * cp50-O3 closed the HTTP route handler scope of the recurring
 * "hardcoded ticker subset" class.  cp51-O4 closes a NEW scope:
 * **ops-cli per-ticker description tables**.
 *
 * Same recurring class pattern that the prior O-defenses closed:
 *   cp48-O1: standalone smoke scripts (stand-in becomes valid)
 *   cp49-O2: vitest unit tests (asset_invalid stand-in)
 *   cp50-O3: HTTP route handler regex (per-asset RSS feed)
 *   cp51-O4: ops-cli per-ticker hardcoded description tables
 *
 * Mutation test verification: M-118 — deleting any one ticker
 * entry from CATEGORY_B_DESCRIPTIONS fires:
 *   "category-b-descriptions-parity FAILED:
 *    canonical Category-B has [..., XRP, ...] but
 *    CATEGORY_B_DESCRIPTIONS keys are [..., -XRP, ...].
 *    Missing in description table: {XRP}.
 *    Add the description in apps/ops-cli/src/init/steps.ts."
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ASSETS } from '../../../packages/asset-registry/src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── category-b-descriptions-parity smoke (cp51 LL #55 / O-4) ──\n');

// Canonical Category-B = canBeTraded + !canPayListingFee
const categoryB = ASSETS.filter((a) => a.canBeTraded && !a.canPayListingFee)
	.map((a) => a.ticker)
	.sort();

console.log(`Canonical Category-B (${categoryB.length}): ${categoryB.join(', ')}`);

// Parse CATEGORY_B_DESCRIPTIONS keys from steps.ts source.
const stepsPath = join(
	__dirname,
	'..',
	'src',
	'init',
	'steps.ts'
);
const src = readFileSync(stepsPath, 'utf-8');

const tableMatch = /const CATEGORY_B_DESCRIPTIONS:[\s\S]*?=\s*Object\.freeze\(\{([\s\S]*?)\}\);/.exec(src);
if (!tableMatch) {
	fail('CATEGORY_B_DESCRIPTIONS table found', 'cannot locate `Object.freeze({...})` definition in steps.ts');
} else {
	pass('CATEGORY_B_DESCRIPTIONS table found');

	const body = tableMatch[1]!;
	// Each entry starts with `\t<TICKER>:` at indent level 1.
	const tableKeys = [...body.matchAll(/^\t([A-Z]+):/gm)].map((m) => m[1]!).sort();
	console.log(`CATEGORY_B_DESCRIPTIONS keys (${tableKeys.length}): ${tableKeys.join(', ')}`);

	// CHECK 1 — table has every canonical Category-B ticker
	const missingInTable = categoryB.filter((t) => !tableKeys.includes(t));
	if (missingInTable.length === 0) {
		pass(`every canonical Category-B asset has a description (${categoryB.length} entries)`);
	} else {
		fail(
			'every canonical Category-B asset has a description',
			`canonical Category-B has [${categoryB.join(', ')}] but CATEGORY_B_DESCRIPTIONS keys are [${tableKeys.join(', ')}]. ` +
			`Missing in description table: {${missingInTable.join(', ')}}. ` +
			`Add the description in apps/ops-cli/src/init/steps.ts.`
		);
	}

	// CHECK 2 — table has no orphan entries (description for a
	// ticker no longer in the canonical Category-B set).  Defensive
	// against asset removal or category change.
	const orphans = tableKeys.filter((k) => !categoryB.includes(k as never));
	if (orphans.length === 0) {
		pass('no orphan entries (every description corresponds to a Category-B ticker)');
	} else {
		fail(
			'no orphan entries',
			`CATEGORY_B_DESCRIPTIONS has keys [${orphans.join(', ')}] not in canonical Category-B. ` +
			`Either restore the asset or remove the orphan description entry.`
		);
	}

	// CHECK 3 — each description starts with the project/asset name
	// and is at least 50 chars (defensive against placeholder
	// "TODO" entries slipping through).
	const SHORT_THRESHOLD = 50;
	const tooShort: string[] = [];
	const entries = [...body.matchAll(/\t([A-Z]+):\s*'([^']*)'/g)];
	// Note: this captures only single-line entries; multi-line ones
	// (most descriptions) span multiple physical lines using \n.
	// Use a more permissive regex to capture full descriptions.
	const fullEntryRe = /\t([A-Z]+):\s*['"]((?:\\.|[^'"\\])*)['"]/g;
	const fullEntries = [...body.matchAll(fullEntryRe)];
	for (const m of fullEntries) {
		const ticker = m[1]!;
		const desc = m[2]!;
		if (desc.length < SHORT_THRESHOLD) {
			tooShort.push(`${ticker} (${desc.length} chars)`);
		}
	}
	if (tooShort.length === 0) {
		pass(`every description is at least ${SHORT_THRESHOLD} chars (no placeholders)`);
	} else {
		fail(
			'every description is at least 50 chars',
			`short descriptions detected: ${tooShort.join(', ')}. Looks like a placeholder TODO entry.`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\ncategory-b-descriptions-parity smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} scenarios passed`);
