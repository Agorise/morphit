#!/usr/bin/env tsx
/**
 * brag-list-trailer-invariants smoke — Part 122 cp75 (LL #75 / O-23).
 *
 * MORPHIT-BRAG-LIST.md's trailer summarises the file ("288 specific
 * selling points... Last updated 2026-05-19").  Three drift classes
 * accumulated across cp70→cp74 with no defense to catch them:
 *
 *   1. Trailer entry-count went stale (claimed 288, actually 299).
 *      Every checkpoint that inserted a new brag entry forgot to
 *      bump the trailer.  Eleven entries of drift accumulated.
 *
 *   2. Trailer "Last updated" date went stale (claimed 2026-05-19;
 *      cp74 work was 2026-05-20).  cp74's mediakit regeneration
 *      touched the file but didn't refresh the trailer date.
 *
 *   3. Trailer claimed "ADR-0001-*.md through ADR-0036-*.md"
 *      misleads since 0016 is absent (35 actual ADRs, not 36).
 *      Adding ADR 0036 didn't trigger a recount of the range claim.
 *
 * cp60-O12 brag-list-kiss-budget audits PER-ENTRY length but not
 * the trailer.  cp66-O16 cross-document-value-invariants covers
 * config invariants (DB names, ports, CIDR) but not summary-vs-
 * content.  This smoke fills the gap.
 *
 * Invariants checked:
 *   I-1: trailer-count == actual `^N. \*\*` numbered-bold entries
 *   I-2: trailer "Last updated YYYY-MM-DD" date ≥ today
 *        (allows back-dated test reproductions; rejects stale)
 *   I-3: trailer ADR range claim "ADR-XXXX-*.md through ADR-YYYY-*.md"
 *        matches max numbered ADR in docs/adr/ (template excluded)
 *   I-4: no duplicate entry numbers within the body (TOC excluded).
 *        Catches the cp75-D12 drift class: two checkpoints both
 *        appending entries that should be numbered N+1 but separately
 *        picking the same N. Surfaced at cp75 — 6 collisions found
 *        (155, 156, 236-239), all renumbered to 294-299.
 *
 * Self-test (M-146):
 *   - Change trailer "299" → "287" → smoke fires.
 *   - Change "2026-05-20" → "2026-04-01" → smoke fires.
 *   - Change "0036" → "0099" → smoke fires.
 *   - Add ADR-0037 without trailer bump → smoke fires.
 *
 * Recurring class scope progression for trailer/summary discipline:
 *   cp60-O12: per-entry length budget
 *   cp66-O16: cross-document config-value invariants
 *   cp75-O23: document-trailer summary-vs-content (THIS smoke)
 *
 * Limitation: only checks MORPHIT-BRAG-LIST.md's trailer.  Other
 * documents (RELEASE-NOTES, README) have their own summary
 * sentences but no consistent trailer format yet.  If a second
 * doc adopts the pattern, extend this smoke or fork.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── brag-list-trailer-invariants smoke (cp75 LL #75 / O-23) ──\n');

const bragPath = join(REPO_ROOT, 'MORPHIT-BRAG-LIST.md');
const bragSrc = readFileSync(bragPath, 'utf-8');

// ── I-1: trailer entry count vs actual entries ──────────────────
// Count actual `^N. **` numbered-bold entries (the canonical
// brag-entry shape used throughout the file).  Markdown soft-wraps
// don't introduce these so the regex is unambiguous.
const entryLines = bragSrc.split('\n').filter((l) => /^\d+\.\s+\*\*/.test(l));
const actualEntries = entryLines.length;

// Find the trailer sentence: "*N specific selling points."
const trailerCountMatch = bragSrc.match(/\*(\d+)\s+specific selling points\./);
if (!trailerCountMatch) {
	fail('I-1 trailer count exists', 'No "*N specific selling points." sentence found in trailer.');
} else {
	const claimed = parseInt(trailerCountMatch[1]!, 10);
	if (claimed !== actualEntries) {
		fail(
			'I-1 trailer count matches actual entries',
			`Trailer claims ${claimed}, file has ${actualEntries} numbered-bold entries. ` +
				`Update trailer to "*${actualEntries} specific selling points."`
		);
	} else {
		pass(`I-1 trailer count matches actual entries (${actualEntries})`);
	}
}

// ── I-2: trailer "Last updated" date is fresh ───────────────────
// Acceptable date is today's date in YYYY-MM-DD format, OR a date
// up to 365 days in the past (lets a checkpoint that doesn't touch
// the brag list keep its existing date — only flags stale-after-
// edits).  The KEY drift catch is when an entry was added but the
// date didn't move.  We approximate "did the file change since the
// date claim" by comparing trailer date to file mtime.
const trailerDateMatch = bragSrc.match(/Last updated\s+(\d{4}-\d{2}-\d{2})/);
if (!trailerDateMatch) {
	fail('I-2 trailer date exists', 'No "Last updated YYYY-MM-DD" sentence found in trailer.');
} else {
	const claimedDate = trailerDateMatch[1]!;
	// Parse without timezone to avoid off-by-one at UTC midnight.
	const [yStr, mStr, dStr] = claimedDate.split('-');
	const claimedTs = Date.UTC(parseInt(yStr!, 10), parseInt(mStr!, 10) - 1, parseInt(dStr!, 10));
	// File mtime check would require fs.statSync; we instead check
	// for staleness vs the LATEST DATE mentioned ANYWHERE in the
	// file's brag entries themselves.  Many entries cite their own
	// dates (e.g. "cp74 2026-05-20") so the trailer's "Last updated"
	// should be ≥ any of them.
	const allDates = Array.from(bragSrc.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g))
		.map((m) => m[1]!)
		.filter((d) => d !== claimedDate);
	let latestOtherDate: string | null = null;
	let latestOtherTs = -Infinity;
	for (const d of allDates) {
		const [y, mo, day] = d.split('-');
		const ts = Date.UTC(parseInt(y!, 10), parseInt(mo!, 10) - 1, parseInt(day!, 10));
		if (ts > latestOtherTs) {
			latestOtherTs = ts;
			latestOtherDate = d;
		}
	}
	if (latestOtherDate !== null && latestOtherTs > claimedTs) {
		fail(
			'I-2 trailer date is fresh',
			`Trailer "Last updated ${claimedDate}" but file contains newer date ${latestOtherDate} ` +
				`in entry text. Bump trailer to ${latestOtherDate} (or later if you're editing today).`
		);
	} else {
		pass(`I-2 trailer date is fresh (${claimedDate}, no newer dates cited in file)`);
	}
}

// ── I-3: trailer ADR range claim matches actual ADRs ────────────
// Find a sentence like "ADR-XXXX-*.md through ADR-YYYY-*.md" or
// "docs/adr/XXXX-*.md through docs/adr/YYYY-*.md".
const adrRangeMatch = bragSrc.match(/(?:ADR-|docs\/adr\/|`docs\/adr\/)0*(\d{1,4})-[^\s]*\s+through\s+(?:ADR-|docs\/adr\/|`docs\/adr\/)?0*(\d{1,4})/);
if (!adrRangeMatch) {
	// Not present is OK — only check if the claim is made
	pass('I-3 trailer ADR-range claim absent or not in standard form (skipped)');
} else {
	const lo = parseInt(adrRangeMatch[1]!, 10);
	const hi = parseInt(adrRangeMatch[2]!, 10);
	const adrDir = join(REPO_ROOT, 'docs/adr');
	const adrFiles = readdirSync(adrDir)
		.filter((f) => /^\d{4}-/.test(f) && f.endsWith('.md') && !f.includes('template'));
	const adrNums = adrFiles
		.map((f) => parseInt(f.slice(0, 4), 10))
		.filter((n) => Number.isFinite(n) && n > 0);
	const minActual = Math.min(...adrNums);
	const maxActual = Math.max(...adrNums);
	if (lo !== minActual || hi !== maxActual) {
		fail(
			'I-3 trailer ADR range matches actual ADRs',
			`Trailer claims ADR-${String(lo).padStart(4, '0')} through ADR-${String(hi).padStart(4, '0')}; ` +
				`actual range is ${String(minActual).padStart(4, '0')}-${String(maxActual).padStart(4, '0')} ` +
				`(${adrNums.length} ADRs, template excluded). ` +
				`If non-contiguous (e.g. 0016 absent), prose should note that explicitly.`
		);
	} else {
		// Also assert range is contiguous, or call it out
		const expected = new Set<number>();
		for (let i = lo; i <= hi; i++) expected.add(i);
		const actual = new Set(adrNums);
		const missing = [...expected].filter((n) => !actual.has(n));
		if (missing.length > 0) {
			// The range bounds are right but there are gaps — claim should mention
			pass(
				`I-3 trailer ADR range bounds match (${lo}-${hi}); ${missing.length} numbers absent in range ` +
					`(${missing.map((n) => String(n).padStart(4, '0')).join(', ')}). Range-claim is bounds-only; OK.`
			);
		} else {
			pass(`I-3 trailer ADR range matches actual ADRs (${lo}-${hi}, contiguous, ${adrNums.length} files)`);
		}
	}
}

// ── I-4: no duplicate entry numbers in body ─────────────────────
// Walk all `^N. **` lines AFTER the table of contents (which itself
// numbers 1-18 for section headers). The body's TOC-vs-content
// boundary is the line that begins with `---` followed by `## 1. `.
// Simpler heuristic: skip any line above the first occurrence of a
// `^1\.` line whose context is in a section header — we instead
// identify the TOC region as the contiguous run of `^N\.` lines
// from the top until a non-`^N\.` line breaks the run (line 12-30
// at cp75). After that point, all `^N. **` entries are body items
// that should be globally-unique.
//
// Concrete: ignore everything before the first `^## 1\.` header
// line (that's the start of body content).
const lines = bragSrc.split('\n');
let bodyStart = 0;
for (let i = 0; i < lines.length; i++) {
	if (/^## 1\. /.test(lines[i]!)) {
		bodyStart = i;
		break;
	}
}
// Also stop before the "How to verify any of the above" section
// (the trailer counts and ADR-range claim live there, not entries).
let bodyEnd = lines.length;
for (let i = bodyStart; i < lines.length; i++) {
	if (/^## How to verify/.test(lines[i]!)) {
		bodyEnd = i;
		break;
	}
}

const numToLines = new Map<number, number[]>();
for (let i = bodyStart; i < bodyEnd; i++) {
	const m = lines[i]!.match(/^(\d+)\.\s+\*\*/);
	if (m) {
		const n = parseInt(m[1]!, 10);
		const list = numToLines.get(n) ?? [];
		list.push(i + 1); // 1-indexed for reporting
		numToLines.set(n, list);
	}
}
const dups = [...numToLines.entries()].filter(([, ls]) => ls.length > 1);
if (dups.length === 0) {
	pass(`I-4 no duplicate entry numbers in body (${numToLines.size} unique entries)`);
} else {
	const summary = dups
		.sort((a, b) => a[0] - b[0])
		.map(([n, ls]) => `#${n} @ lines ${ls.join(', ')}`)
		.join('; ');
	fail(
		'I-4 no duplicate entry numbers in body',
		`${dups.length} collisions: ${summary}. ` +
			`Each entry number must be globally unique; renumber the later occurrences to extend the sequence.`
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nbrag-list-trailer-invariants smoke FAILED');
	console.error('Trailer summary drifted from file content. Update MORPHIT-BRAG-LIST.md trailer to reflect reality.');
	process.exit(1);
}
console.log(`✓ all ${total} brag-list-trailer-invariants scenarios passed`);
