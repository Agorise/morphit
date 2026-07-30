#!/usr/bin/env tsx
/**
 * operator-doc-per-asset-config-example-coverage-smoke.
 *
 * Part 122 cp56 STRUCTURAL DEFENSE (LL #60 / O-10).
 *
 * Deepens cp53-O7 from "ticker totally absent" to "ticker absent
 * from CONFIG EXAMPLES" — catches the shallow-mention failure mode
 * where an asset is mentioned once in the headline but skipped in
 * the per-asset config example.  That was the exact pattern cp53
 * surfaced manually in OPERATIONS.md (`MORPHIT_INDEXER_DISABLED_ASSETS
 * value listed 7 of 13 Category-B tickers while the comment claimed
 * "everything that isn't BLURT+XMR+BTC"`) — cp53 inline-fixed it,
 * cp56 pins the floor mechanically.
 *
 * Coverage requirement: each Category-B tradable asset MUST appear
 * at least once inside a `MORPHIT_INDEXER_DISABLED_ASSETS=...` env
 * example in EACH of the 3 scoped operator docs:
 *   - docs/PRE-LAUNCH-CHECKLIST.md
 *   - docs/OPERATIONS.md
 *
 * Why DISABLED_ASSETS specifically: it's the most concrete operator-
 * facing config knob.  Every Category-B asset must have an example
 * showing how to disable it, because that's the primary operator
 * stance decision.  An asset NOT appearing in any DISABLED_ASSETS
 * example means the doc treats it as second-class — operators
 * looking at the doc to decide their stance on that asset get
 * no concrete syntax to copy.
 *
 * Recurring class scope progression (10 defenses across 9 checkpoints):
 *   cp48-O1: standalone smoke scripts
 *   cp49-O2: vitest unit tests
 *   cp50-O3: HTTP route handler regex
 *   cp51-O4: ops-cli per-ticker tables
 *   cp51-O5: per-asset i18n FAQ key coverage
 *   cp52-O6: Ansible env-template required-vars
 *   cp53-O7: operator doc per-asset coverage ("totally absent" floor)
 *   cp54-O8: what_is_<asset> FAQ native-locale floor
 *   cp55-O9: multi-family per-asset native-locale floor
 *   cp56-O10: operator doc per-asset CONFIG EXAMPLE coverage (THIS)
 *
 * Mutation test verification: M-124 — stripping all
 * `MORPHIT_INDEXER_DISABLED_ASSETS=...XRP...` examples from
 * OPERATIONS.md fires:
 *   "operator-doc-per-asset-config-example-coverage FAILED:
 *    docs/OPERATIONS.md is missing XRP from every DISABLED_ASSETS
 *    config example."
 *
 * Layered with cp53-O7: cp53-O7 catches "totally absent"; cp56-O10
 * catches "present but only as headline mention".  Together they
 * pin both shallow-and-shallower drift floors.
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

console.log('\n── operator-doc-per-asset-config-example-coverage smoke (cp56 LL #60 / O-10) ──\n');

const CATEGORY_B = (ASSET_TICKERS as readonly string[]).filter(
	(t) => t !== 'BTC' && t !== 'XMR' && t !== 'BLURT'
);

const SCOPED_DOCS = [
	'docs/PRE-LAUNCH-CHECKLIST.md',
	'docs/OPERATIONS.md'
];

console.log(`Category-B tickers (${CATEGORY_B.length}): ${CATEGORY_B.join(', ')}\n`);

for (const docPath of SCOPED_DOCS) {
	const fullPath = join(REPO_ROOT, docPath);
	const content = readFileSync(fullPath, 'utf-8');

	// Extract every MORPHIT_INDEXER_DISABLED_ASSETS=... example.
	// Accept three syntactic shapes that appear in operator docs:
	//   1. Bare in a code block:  MORPHIT_INDEXER_DISABLED_ASSETS="USDT"
	//   2. In markdown inline code: `MORPHIT_INDEXER_DISABLED_ASSETS="USDT"`
	//   3. Bare unquoted:           MORPHIT_INDEXER_DISABLED_ASSETS=USDT,DAI
	// Match the env-var name + `=` + optional quote + value-until-quote-or-EOL/backtick.
	const envExampleRe = /MORPHIT_INDEXER_DISABLED_ASSETS\s*=\s*["']?([^"'`\n]*)["']?/g;
	const exampleValues: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = envExampleRe.exec(content)) !== null) {
		exampleValues.push(m[1] ?? '');
	}

	if (exampleValues.length === 0) {
		fail(
			`${docPath}`,
			`no MORPHIT_INDEXER_DISABLED_ASSETS=... env examples found.  This doc should carry at least one concrete operator-facing config example.`
		);
		continue;
	}

	// For each Category-B ticker, find at least one example value
	// that contains it (word-boundary match, case-sensitive).
	const missingFromExamples: string[] = [];
	for (const ticker of CATEGORY_B) {
		const tickerRe = new RegExp(`\\b${ticker}\\b`);
		const found = exampleValues.some((val) => tickerRe.test(val));
		if (!found) {
			missingFromExamples.push(ticker);
		}
	}

	if (missingFromExamples.length === 0) {
		pass(
			`${docPath}: every Category-B ticker (${CATEGORY_B.length}) appears in at least one MORPHIT_INDEXER_DISABLED_ASSETS=... example (${exampleValues.length} examples scanned)`
		);
	} else {
		fail(
			`${docPath}: shallow-mention coverage`,
			`${missingFromExamples.length} tickers absent from every DISABLED_ASSETS config example: [${missingFromExamples.join(', ')}].  ${exampleValues.length} examples scanned.  Add the missing tickers to at least one Refuse-example.`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\noperator-doc-per-asset-config-example-coverage smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} scenarios passed`);
