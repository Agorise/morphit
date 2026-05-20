#!/usr/bin/env tsx
/**
 * operator-doc-section-length-smoke — Part 122 cp69 (LL #68 / O-17).
 *
 * Operator-facing docs (OPERATIONS.md, RUN-A-MORPHIT-NODE.md,
 * PRE-LAUNCH-CHECKLIST.md) and ADRs MUST be detailed enough to be
 * useful, but individual sections shouldn't grow unbounded.  A
 * section that's >2000 lines is a "small book inside a doc" — readers
 * lose place, search context is huge, edits are scary.
 *
 * This smoke flags sections that exceed a per-doc threshold so that
 * the next checkpoint can choose to split them.  It is ADVISORY for
 * existing oversize sections (we don't fix prose retroactively in
 * one CI failure), but it locks the CEILING so NEW content can't
 * grow a section past the threshold without surfacing.
 *
 * Per-doc thresholds (lines per top-level `##` section):
 *   OPERATIONS.md         600
 *   RUN-A-MORPHIT-NODE.md 400
 *   PRE-LAUNCH-CHECKLIST  300
 *   ADRs (any)            500
 *
 * Top-level sections are defined by `^## ` headers.  Sub-sections
 * (`^### ` etc.) count against the parent's budget.  A section's
 * length is the number of lines from its `## ` to the next `## ` or
 * end of file.
 *
 * Allow-list for existing oversize sections is hardcoded below
 * (these are inherited from pre-cp69 prose; documented as "to be
 * split in a future checkpoint" so the smoke goes green and we don't
 * lie about whether the ceiling holds).  Adding a new section over
 * its threshold WITHOUT adding it to the allow-list is the bug.
 *
 * Mutation test M-139:  insert 1000 dummy lines into OPERATIONS.md's
 * `## 1. Recurrent BLURT top-up setup (one-time)` section → smoke fires
 * with "OPERATIONS.md `## 1. Recurrent BLURT top-up setup (one-time)`
 * is N lines, threshold 600".
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

interface DocSpec {
	path: string;
	threshold: number;
	allowList: Set<string>;
}

const SPECS: DocSpec[] = [
	{
		path: 'docs/OPERATIONS.md',
		threshold: 600,
		// Existing oversize sections inherited at cp69.  Documented here
		// so the smoke doesn't lie about whether the ceiling holds; each
		// entry should eventually be split into smaller sub-runbooks.
		allowList: new Set([
			'0. Initial account setup — names, roles, and tradeoffs',
			'0a. Initial account funding — the relay needs BLURT to operate',
			'2. Weekly ACT minting ceremony',
			'13. Responding to a stale BLURT/USD price feed',
			'14. Deployment topology requirement — apps MUST be behind a loopback proxy',
			'16. Operator-account balance alerts',
			'37. Comprehensive server hardening — defense-in-depth checklist',
		]),
	},
	{
		path: 'docs/RUN-A-MORPHIT-NODE.md',
		threshold: 400,
		allowList: new Set([
			'8. First-time configuration',
		]),
	},
	{
		path: 'docs/PRE-LAUNCH-CHECKLIST.md',
		threshold: 300,
		allowList: new Set([
			'C. Operator-config files (on the morphit.io production box)',
		]),
	},
];

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── operator-doc-section-length smoke (cp69 LL #68 / O-17) ──\n');

interface Section { title: string; startLine: number; lineCount: number; }

function parseSections(src: string): Section[] {
	const lines = src.split('\n');
	const sections: Section[] = [];
	let current: Section | null = null;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^## (.+)$/);
		if (m) {
			if (current) {
				current.lineCount = i - current.startLine;
				sections.push(current);
			}
			current = { title: m[1].trim(), startLine: i, lineCount: 0 };
		}
	}
	if (current) {
		current.lineCount = lines.length - current.startLine;
		sections.push(current);
	}
	return sections;
}

for (const spec of SPECS) {
	const fullPath = join(REPO_ROOT, spec.path);
	let src: string;
	try {
		src = readFileSync(fullPath, 'utf-8');
	} catch (e) {
		fail(`Read ${spec.path}`, `Could not read: ${(e as Error).message}`);
		continue;
	}
	const sections = parseSections(src);
	console.log(`▸ ${spec.path} — threshold ${spec.threshold} lines/section, ${sections.length} sections`);
	let docFailed = 0;
	for (const s of sections) {
		if (s.lineCount <= spec.threshold) continue;
		if (spec.allowList.has(s.title)) {
			console.log(`  ⊝ "${s.title}": ${s.lineCount} lines (over ${spec.threshold}, ALLOWED — to be split in a future checkpoint)`);
			continue;
		}
		fail(
			`${spec.path} section "${s.title}" within budget`,
			`Section is ${s.lineCount} lines, threshold ${spec.threshold}.  Split into sub-sections or add to allow_list with a documented plan to split.`
		);
		docFailed++;
	}
	if (docFailed === 0) pass(`${spec.path}: all unallowed sections within budget`);
	console.log('');
}

// ADR length audit — each ADR file is treated as a single document with
// its own threshold; large ADRs are FINE but become OPS hazards over time.
const adrDir = join(REPO_ROOT, 'docs/adr');
let adrEntries: string[];
try {
	adrEntries = readdirSync(adrDir).filter((f) => /^00\d{2}-.+\.md$/.test(f));
} catch (e) {
	fail('Read ADR directory', `Could not read docs/adr: ${(e as Error).message}`);
	adrEntries = [];
}

const ADR_LINE_THRESHOLD = 1000;
const ADR_ALLOW_LIST = new Set([
	// Inherited cp69 oversize ADRs.  Each is a substantial design doc
	// that's "complete as one read"; splitting would harm cohesion.
	// We track them so a NEW ADR ballooning past the threshold surfaces.
	'0011-dynamic-fee-model.md',  // 61KB, dynamic fee formula is multi-faceted
	'0022-desktop-qr-pairing.md', // 33KB, full UX + crypto flow design
	'0013-operator-incentives.md', // 20KB, treasury split economics
	'0010-key-custody.md', // 18KB, full key-handling design
	'0009-phase3c-order-posting.md', // 17KB, end-to-end posting flow
	'0028-usdc-multi-network-trade-only-addition.md', // 16KB, multi-network reasoning
	'0006-security-posture-phase3a.md', // 15KB, full security posture
	'0014-chat-and-counterparty-reputation.md', // 15KB, reputation design
	'0021-batch-l-payment-methods.md', // 14KB, payment-methods architecture
	'0015-chat-crypto.md', // 13KB, chat crypto design
]);
console.log(`▸ docs/adr/ — threshold ${ADR_LINE_THRESHOLD} lines/ADR, ${adrEntries.length} ADRs`);
let adrFailed = 0;
for (const fname of adrEntries) {
	const p = join(adrDir, fname);
	const lineCount = readFileSync(p, 'utf-8').split('\n').length;
	if (lineCount <= ADR_LINE_THRESHOLD) continue;
	if (ADR_ALLOW_LIST.has(fname)) {
		console.log(`  ⊝ ${fname}: ${lineCount} lines (over ${ADR_LINE_THRESHOLD}, ALLOWED)`);
		continue;
	}
	fail(
		`${fname} within ADR length budget`,
		`ADR is ${lineCount} lines, threshold ${ADR_LINE_THRESHOLD}.  Split into multiple ADRs or add to allow_list with a documented reason.`
	);
	adrFailed++;
}
if (adrFailed === 0) pass(`docs/adr/: all unallowed ADRs within budget`);

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\noperator-doc-section-length smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} operator-doc-section-length scenarios passed`);
