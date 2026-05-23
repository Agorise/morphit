#!/usr/bin/env tsx
/**
 * brag-list-kiss-budget-smoke.
 *
 * Part 122 cp60 STRUCTURAL DEFENSE (LL #62 / O-12).
 *
 * Closes the cp59-D1 class: brag-list entries growing long-winded
 * across multiple checkpoints despite the Memory rule "BRAG LIST
 * entries: concise (~2-4 sentences), public-facing wins only,
 * inserted in proper themed section, not appended to end."
 *
 * Drift surfaced at cp59: Ken's "braglist items 274 onward most
 * of them got long-winded again. what did i tell you about that?
 * REMEMBER, STOP DOING THAT!!!"  Initial audit found 36 entries
 * over the ≤4-sentence budget across the file; cp59 rewrote 35.
 * This smoke pins the budget so the next checkpoint that drifts
 * fails CI before merge instead of accumulating over many shipped
 * checkpoints.
 *
 * Budget:
 *   - ≤4 sentences (memory: "concise ~2-4 sentences")
 *   - ≤100 words (chosen as the line where prose becomes essay)
 *
 * STACCATO_ALLOWLIST: a small set of entries use intentional
 * multi-sentence punchy emphasis ("No leverage. No margin. No
 * futures. No options.") — those are K.I.S.S. by design and
 * are exempted from the sentence-count budget but still subject
 * to the word-count budget.
 *
 * Recurring class scope progression (12 defenses across 11 checkpoints):
 *   cp48-O1: standalone smoke scripts
 *   cp49-O2: vitest unit tests
 *   cp50-O3: HTTP route handler regex
 *   cp51-O4: ops-cli per-ticker tables
 *   cp51-O5: per-asset i18n FAQ key coverage
 *   cp52-O6: Ansible env-template required-vars
 *   cp53-O7: operator doc per-asset coverage (totally absent)
 *   cp54-O8: what_is_<asset> FAQ native-locale floor
 *   cp55-O9: multi-family per-asset native-locale floor (registry)
 *   cp56-O10: operator doc per-asset CONFIG EXAMPLE coverage (shallow)
 *   cp57-O11: env-example ↔ schema parity (bidirectional)
 *   cp60-O12: brag-list K.I.S.S. budget (THIS)
 *
 * Mutation test verification: M-126 — appending 200 words of
 * extra prose to entry #5 fires:
 *   "brag-list-kiss-budget FAILED: entry 5 over budget:
 *    Xs / Yw (limit: 4 sentences, 100 words)."
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

console.log('\n── brag-list-kiss-budget smoke (cp60 LL #62 / O-12) ──\n');

const BRAG_PATH = join(REPO_ROOT, 'MORPHIT-BRAG-LIST.md');
const content = readFileSync(BRAG_PATH, 'utf-8');

/**
 * Entries that use intentional multi-sentence staccato punctuation
 * for rhetorical emphasis.  K.I.S.S. by design (short punchy
 * sentences); exempt from sentence-count budget but still subject
 * to word-count budget.
 *
 * cp112 addition: "No leverage. No margin. No futures. No options."
 * (originally #195) is the same "No X. No Y. No Z." rhetorical
 * pattern as #3 and #12.  Adding to allowlist preserves Ken's
 * punchy style (also: shortening it would obscure the four-things-
 * Morphit-isn't claim, which is exactly the claim that needs the
 * visual hammer).
 *
 * cp125 numbering shift: the 4 new reputation-hardening entries
 * (cp123-cp125 H1/H4 in §8 + Signal D in §8 + H5+H6 in §8) shifted
 * subsequent entries by +4 (#186 → #190, #195 → #199).  Entries #3
 * and #12 are in the brag-list preamble (before the reputation-
 * hardening section) so they're unaffected.
 *
 * cp128 numbering shift: 2 new entries added in §4 (denomination
 * config #89, between price-receipt #88 and wallet-embed previously
 * #89) and §17 (BRICS Pay #226, between registry #225 and barter
 * previously #226).  The §4 insert shifted old #193 → new #194 and
 * old #202 → new #203 (both old positions were before the §17
 * insertion point so only the §4 insert applied to them).
 */
const STACCATO_ALLOWLIST = new Set(['3', '12', '194', '203']);

const SENTENCE_LIMIT = 4;
const WORD_LIMIT = 100;

interface Entry {
	num: string;
	title: string;
	body: string;
	full: string;
}

function parseEntries(src: string): Entry[] {
	const entries: Entry[] = [];
	// Match: `^N. **Title.** body...` until next entry or section heading.
	const re = /^(\d+[a-z]?)\.\s+(\*\*[^*]+\*\*)\s+(.*?)(?=\n\d+[a-z]?\.|\n## |\Z)/gms;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		entries.push({
			num: m[1],
			title: m[2],
			body: m[3].trim(),
			full: `${m[2]} ${m[3]}`.trim()
		});
	}
	return entries;
}

function countSentences(text: string): number {
	// Strip markdown formatting that could confuse the regex.
	const plain = text
		.replace(/\*\*|\*|`/g, '')
		.replace(/\[[^\]]*\]\([^)]+\)/g, '') // strip markdown links
		.replace(/\s+/g, ' ');
	// Count terminal punctuation followed by space, EOL, closing bracket,
	// or em-dash (common Morphit prose style).
	return (plain.match(/[.!?](?:\s|$|\)|—)/g) || []).length;
}

function countWords(text: string): number {
	return text
		.replace(/\*\*|\*|`/g, '')
		.replace(/\[[^\]]*\]\([^)]+\)/g, '')
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;
}

const entries = parseEntries(content);
console.log(`Total brag entries: ${entries.length}`);
console.log(`Budget: ≤${SENTENCE_LIMIT} sentences, ≤${WORD_LIMIT} words (staccato allowlist exempt from sentence limit)\n`);

const overSentence: string[] = [];
const overWord: string[] = [];

for (const e of entries) {
	if (!/^\d/.test(e.num)) continue;
	const sentences = countSentences(e.full);
	const words = countWords(e.body);

	if (sentences > SENTENCE_LIMIT && !STACCATO_ALLOWLIST.has(e.num)) {
		overSentence.push(`#${e.num}: ${sentences}s (${e.title.replace(/\*\*/g, '').slice(0, 50)}…)`);
	}
	if (words > WORD_LIMIT) {
		overWord.push(`#${e.num}: ${words}w (${e.title.replace(/\*\*/g, '').slice(0, 50)}…)`);
	}
}

if (overSentence.length === 0) {
	pass(`every entry within ≤${SENTENCE_LIMIT}-sentence budget (excluding ${STACCATO_ALLOWLIST.size} staccato-exempt: ${[...STACCATO_ALLOWLIST].join(', ')})`);
} else {
	fail(
		`every entry within sentence budget`,
		`${overSentence.length} over-budget:\n      ${overSentence.join('\n      ')}`
	);
}

if (overWord.length === 0) {
	pass(`every entry within ≤${WORD_LIMIT}-word budget`);
} else {
	fail(
		`every entry within word budget`,
		`${overWord.length} over-budget:\n      ${overWord.join('\n      ')}`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nbrag-list-kiss-budget smoke FAILED');
	console.error('Memory rule: BRAG LIST entries concise (~2-4 sentences), public-facing wins only, K.I.S.S. for grandma.');
	console.error('Rewrite the over-budget entries to fit the budget.  See cp59 audit log for the template.');
	process.exit(1);
}
console.log(`✓ all ${total} K.I.S.S. budget checks pass`);
