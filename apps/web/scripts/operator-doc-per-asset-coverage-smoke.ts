#!/usr/bin/env tsx
/**
 * operator-doc-per-asset-coverage-smoke.
 *
 * Part 122 cp53 STRUCTURAL DEFENSE (LL #57 / O-7).
 *
 * Closes the cp53-N1 documentation drift class: every Category-B
 * tradable asset (excluding the three Category-A fee-payable
 * assets BTC/XMR/BLURT which appear EVERYWHERE) MUST appear at
 * least once in every operator-facing setup doc.  This catches
 * the "asset added at cp<N>, but the operator guide was never
 * updated" failure mode that cp53 surfaced (BCH/LTC/DASH
 * tooltip-faqKey deep-links wired at cp51 but never reflected
 * in GRANDMA-FRIENDLY-INVESTIGATION; cp33-cp49 assets never got
 * dedicated chat-link explorer subsections in OPERATIONS.md).
 *
 * Recurring class scope progression (7 defenses across 6 checkpoints):
 *   cp48-O1: standalone smoke scripts
 *   cp49-O2: vitest unit tests
 *   cp50-O3: HTTP route handler regex
 *   cp51-O4: ops-cli per-ticker hardcoded tables
 *   cp51-O5: per-asset i18n FAQ key coverage
 *   cp52-O6: Ansible env template required-var parity
 *   cp53-O7: operator doc per-asset coverage (THIS)
 *
 * Scope of operator docs walked:
 *   - docs/PRE-LAUNCH-CHECKLIST.md
 *   - docs/OPERATIONS.md
 *   - docs/RUN-A-MORPHIT-NODE.md
 *
 * NOT walked (intentionally — these are for a different audience):
 *   - SECURITY.md (threat model — asset-agnostic by design)
 *   - LAUNCH-DAY.md / POST-LAUNCH-WEEK-ONE.md (operational rhythm)
 *   - BETA-INCIDENT-RUNBOOK.md (incident triage)
 *   - UPGRADING.md / SWITCHING-NETWORKS.md (workflow guides)
 *   - ADDING-A-COIN.md (developer guide, intentionally enumerates)
 *
 * The smoke verifies that each Category-B asset ticker appears
 * AT LEAST ONCE in each scoped doc.  This is the minimum bar —
 * the doc may discuss the asset in 50 places or just once, but
 * if it never appears, the operator looking at that asset's
 * configuration cannot find ANY information about it in that
 * canonical doc.
 *
 * Mutation test verification: M-121 — deleting all XRP mentions
 * from OPERATIONS.md fires:
 *   "operator-doc-per-asset-coverage FAILED:
 *    docs/OPERATIONS.md never mentions tradable asset XRP."
 *
 * Limitations: case-sensitive match on uppercase ticker
 * (matches /\bXRP\b/), so the smoke ONLY catches "asset is
 * silently unmentioned" — it does NOT detect SHALLOW mentions
 * (e.g. mentioning XRP only in the headline summary while
 * skipping the per-asset config example).  The cp53 inline
 * fixes addressed the shallow cases; this smoke pins the
 * "totally absent" floor.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ASSET_TICKERS } from '../../../packages/asset-registry/src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── operator-doc-per-asset-coverage smoke (cp53 LL #57 / O-7) ──\n');

// Category-B = tradable assets that aren't BTC/XMR/BLURT.
// (BTC/XMR/BLURT are everywhere by virtue of being the
// Category-A fee-payable triad — they don't need pinning.)
const CATEGORY_B = (ASSET_TICKERS as readonly string[]).filter(
	(t) => t !== 'BTC' && t !== 'XMR' && t !== 'BLURT'
);

console.log(`Category-B tickers (${CATEGORY_B.length}): ${CATEGORY_B.join(', ')}\n`);

const SCOPED_DOCS = [
	'docs/PRE-LAUNCH-CHECKLIST.md',
	'docs/OPERATIONS.md',
	'docs/RUN-A-MORPHIT-NODE.md'
];

for (const docPath of SCOPED_DOCS) {
	const fullPath = join(REPO_ROOT, docPath);
	const content = readFileSync(fullPath, 'utf-8');

	const missing: string[] = [];
	for (const ticker of CATEGORY_B) {
		// Word-boundary match so substring matches (e.g. "BCHASH")
		// don't count.  Case-sensitive: operator docs use uppercase
		// tickers per the canonical convention.
		const re = new RegExp(`\\b${ticker}\\b`);
		if (!re.test(content)) {
			missing.push(ticker);
		}
	}

	if (missing.length === 0) {
		pass(`${docPath}: every Category-B ticker (${CATEGORY_B.length}) mentioned at least once`);
	} else {
		fail(
			`${docPath}: every Category-B ticker mentioned at least once`,
			`missing: [${missing.join(', ')}].  Add at least one mention per asset.`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\noperator-doc-per-asset-coverage smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} scenarios passed`);
