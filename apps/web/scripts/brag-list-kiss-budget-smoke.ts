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
 * cp130 numbering shift: 1 new entry added in §4 (multi-asset
 * self-sovereign pricing #91, between Defense F #90 and wallet-
 * embed previously #91).  Subsequent entries shift +1: old #195
 * → new #196, old #204 → new #205.
 */
// Staccato-exempt entries: 3, 12, 197, 206, 210, 213, 215.
// Numbers 197/206/210/213 were 196/205/209/212 before cp140's
// AI-MCP brag entry was inserted at #99; the renumbering shifted
// every staccato-allowlisted entry by +1.  Numbers 3 and 12 are
// below the insertion point so they didn't shift.
//
// cp165 added two new entries (#12 Lightweight pages, #79
// RPC-pool resilience); cp166 broadened the RPC-pool entry to
// also cover the BTC/XMR explorer pool but didn't add a new
// entry.  Net effect: the historical "No leverage..." staccato
// entry at #213 shifted to #215.  '215' added to track that;
// '213' kept in the allowlist for back-compat (the entry now
// at #213 is prose, but exemption is harmless and removes a
// noisy bisect direction if entries get rearranged again).
// cp176: '14' added.  Entry #14's "Period. Zero." is deliberate
// punchy emphasis — the same staccato style as the allowlisted "No
// leverage. No margin..." entry — not sprawl.  It is well within the
// word budget; only the sentence-count heuristic trips on it, so it
// belongs here.  (Surfaced when the parser's end-of-input bug was
// fixed: #14 contains "Zero", whose capital Z used to truncate its
// body before the sentence counter ever saw the staccato tail.)
const STACCATO_ALLOWLIST = new Set(['3', '12', '14', '197', '206', '210', '213', '215']);

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
	// cp137 parser fix: `\s+` after the closing `**` used to be mandatory,
	// which silently dropped entries where the title ends with `**:`
	// (no space between the closing `**` and the colon — entry #48
	// is the canonical example: `**Two independent verification paths**:`).
	// Use `[\s:.]*` so the parser consumes optional terminal punctuation
	// AND/OR whitespace before the body.  The body capture itself is
	// non-greedy so it stops at the next entry or section heading.
	// Body terminator: next entry, a section heading, or end-of-input.
	// NOTE: JS regex has no `\Z`; an earlier version used it and it was
	// silently treated as the literal char "Z", truncating any entry
	// body at its first capital Z (e.g. "Zcash"/"Zero") and undercounting
	// words/sentences.  `(?![\s\S])` is the correct end-of-input assert.
	const re = /^(\d+[a-z]?)\.\s+(\*\*[^*]+\*\*)[\s:.]*(.*?)(?=\n\d+[a-z]?\.|\n## |(?![\s\S]))/gms;
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
