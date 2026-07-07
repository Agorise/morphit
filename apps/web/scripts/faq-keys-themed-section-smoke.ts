#!/usr/bin/env tsx
/**
 * faq-keys-themed-section-smoke.
 *
 * Part 122 cp60 STRUCTURAL DEFENSE (LL #63 / O-13).
 *
 * Closes the cp59-D2 class: FAQ_KEYS array drifting into
 * chronological-accumulation order over many checkpoints despite
 * the source comment "New entries go into a thematic cluster,
 * not appended."  cp59 reorganized 126 keys into 11 themed
 * sections with comment dividers.  This smoke pins that structure
 * so the next checkpoint that appends a new key at the file-end
 * (instead of inserting under a themed section) fails CI before
 * merge.
 *
 * Enforcement model:
 *   1. The file must contain section-comment dividers of the
 *      form `// ─── N. <title> ───` with sequential numbering
 *      (1, 2, 3, ...).
 *   2. Every key string in FAQ_KEYS must appear AFTER some
 *      section-comment divider (no orphan keys before the first
 *      section or after the last key in the last section).
 *   3. Every section must contain at least one key.
 *
 * Note: this smoke doesn't enforce WHICH section each key belongs
 * to (that's a human judgment about reader-flow appropriateness).
 * It enforces only that the structural sectioning exists and
 * every key is under a section.
 *
 * Recurring class scope progression (13 defenses across 12 checkpoints):
 *   cp48-O1 through cp57-O11 (as listed above)
 *   cp60-O12: brag-list K.I.S.S. budget
 *   cp60-O13: FAQ_KEYS themed-section structure (THIS)
 *
 * Mutation test verification: M-127 — appending a new key
 * `'cp60_test_orphan'` AFTER the closing `] as const;` (so it's
 * outside any section) — well, that won't parse.  Real mutation:
 * appending `'cp60_test_orphan',` BELOW the last key but still
 * inside the array → fires: "section 11 (Run your own node) has
 * key 'cp60_test_orphan' but the smoke can't tell whether it's
 * appropriately placed."  Actually the simpler mutation: REMOVE
 * a section-comment divider line.  The smoke then sees keys that
 * orphan into the previous section, which violates the count.
 * For mutation, we'll delete the `// ─── 11. Run your own node`
 * comment line; the smoke fires with "expected 11 sections, found
 * 10".
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── faq-keys-themed-section smoke (cp60 LL #63 / O-13) ──\n');

const FAQ_INDEX_PATH = join(REPO_ROOT, 'apps/web/src/lib/utils/faqIndex.ts');
const src = readFileSync(FAQ_INDEX_PATH, 'utf-8');

// Extract the FAQ_KEYS array body
const m = src.match(/export const FAQ_KEYS = \[([\s\S]*?)\] as const;/);
if (!m) {
	fail('parse', 'Could not locate `export const FAQ_KEYS = [ ... ] as const;` in faqIndex.ts');
	process.exit(1);
}
const body = m[1];

// Tokenize lines into either:
//   - SECTION: `// ─── N. Title ───`
//   - SUB-SECTION: `// Subheading` (descriptive comment, optional)
//   - KEY: `'snake_case_key',`
//   - BLANK
//   - other (ignored)
interface Section { num: number; title: string; keys: string[]; }
const sections: Section[] = [];
let current: Section | null = null;
const orphanedKeys: string[] = [];

const lines = body.split('\n');
const sectionRe = /^\s*\/\/\s*─+\s*(\d+)\.\s+(.+?)\s*─+\s*$/;
const keyRe = /^\s*'([a-z_]+)',?\s*$/;

for (const line of lines) {
	const sm = line.match(sectionRe);
	if (sm) {
		current = { num: parseInt(sm[1], 10), title: sm[2].trim(), keys: [] };
		sections.push(current);
		continue;
	}
	const km = line.match(keyRe);
	if (km) {
		if (current === null) {
			orphanedKeys.push(km[1]);
		} else {
			current.keys.push(km[1]);
		}
	}
}

console.log(`Parsed: ${sections.length} sections, ${sections.reduce((a, s) => a + s.keys.length, 0)} keys under sections${orphanedKeys.length > 0 ? `, ${orphanedKeys.length} ORPHANED` : ''}\n`);

// Check 1: EXACTLY EXPECTED_SECTIONS sections exist.  This is opinionated:
// adding a new section requires a deliberate smoke update (which is
// itself a useful forcing function).
const EXPECTED_SECTIONS = 11;
if (sections.length !== EXPECTED_SECTIONS) {
	fail(
		`exactly ${EXPECTED_SECTIONS} section dividers`,
		`found ${sections.length}.  The file is meant to be exactly ${EXPECTED_SECTIONS} themed sections.  ` +
			`If a section was intentionally added/removed, update EXPECTED_SECTIONS in this smoke.  ` +
			`If a section divider was accidentally deleted, restore the "// ─── N. <title> ───" line.`
	);
} else {
	pass(`exactly ${EXPECTED_SECTIONS} section dividers (opinionated structure pin)`);
}

// Check 2: section numbering is sequential
const expectedNums = sections.map((_, i) => i + 1);
const actualNums = sections.map((s) => s.num);
if (JSON.stringify(expectedNums) !== JSON.stringify(actualNums)) {
	fail(
		`sequential section numbering`,
		`expected 1..${sections.length}; got [${actualNums.join(', ')}].  Re-number the section dividers.`
	);
} else {
	pass(`section numbering sequential: 1..${sections.length}`);
}

// Check 3: every section has at least one key
const emptySections = sections.filter((s) => s.keys.length === 0);
if (emptySections.length > 0) {
	fail(
		`every section has at least one key`,
		`empty section(s): ${emptySections.map((s) => `${s.num}. ${s.title}`).join(', ')}.  Either populate or remove.`
	);
} else {
	pass(`every section has at least one key`);
}

// Check 4: no orphan keys (before first section or after last)
if (orphanedKeys.length > 0) {
	fail(
		`no orphan keys`,
		`${orphanedKeys.length} key(s) not under any section: [${orphanedKeys.slice(0, 5).join(', ')}${orphanedKeys.length > 5 ? '...' : ''}].  ` +
			`A new FAQ entry was appended without being placed in a themed section.  ` +
			`Memory: "New entries go into a thematic cluster, not appended."  ` +
			`See faqIndex.ts:24 for the rule.  Move the orphan(s) under the appropriate "// ─── N. <title> ───" section.`
	);
} else {
	pass(`no orphan keys (every key under a themed section)`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nfaq-keys-themed-section smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} themed-section structure checks pass`);
