/**
 * Morphit indexer — fee-and-reward copy consistency smoke.
 *
 * Guards against the bug class we discovered 2026-05-02: the
 * welcome-bonus FAQ said "10 BLURT + 10 BP delegation" while the
 * actual handler did `transfer_to_vesting` (= 10 BLURT power-up,
 * which is user-OWNED vested BLURT, not a delegation).
 *
 * The mismatch lived in 13+ files across 10 locales for months
 * before being noticed.  This smoke makes a similar drift hard to
 * reintroduce.
 *
 * Strategy:
 * - Read the canonical truth from the source code (handler line
 *   that emits the queue rows, plus the loyalty milestone array)
 * - Read user-facing copy (FAQ entries, ADRs)
 * - Assert that copy uses the precise terminology, not the
 *   misleading shorthand
 *
 * If you are intentionally CHANGING the welcome-bonus or loyalty
 * mechanics:
 * 1. Update apps/indexer/src/indexer/handlers/feedback.ts
 * 2. Update apps/indexer/src/indexer/loyalty.ts
 * 3. Update docs/FEES-AND-REWARDS.md (the canonical reference)
 * 4. Update this smoke's expected strings
 * 5. Update i18n FAQ entries to match
 * The fact that all five must change in one commit is the point.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

let scenarios = 0;
let failures = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  ✗ ${name}: ${msg}`);
	}
}

function readFile(path: string): string {
	return readFileSync(join(REPO_ROOT, path), 'utf-8');
}

console.log('Fee/reward copy consistency smoke');
console.log('─────────────────────────────────────');

// ─── Source-of-truth assertions ──────────────────────────────────

scenario('handler queues 10 BLURT liquid + 10 BLURT vesting (NOT delegation)', () => {
	const src = readFile('apps/indexer/src/indexer/handlers/feedback.ts');
	if (!src.includes("'liquid',  10, 'welcome_bonus_liquid'")) {
		throw new Error("handler doesn't queue 10 BLURT liquid — drift");
	}
	if (!src.includes("'vesting', 10, 'welcome_bonus_vesting'")) {
		throw new Error("handler doesn't queue 10 BLURT vesting — drift");
	}
});

scenario(
	'drainer dispatches "vesting" via transfer_to_vesting (not delegate_vesting_shares)',
	() => {
		const src = readFile('apps/relay/src/queue/drainer.ts');
		// The 'vesting' kind must dispatch to broadcastTransferToVesting,
		// NOT broadcastDelegateVestingShares.  The two are different ops:
		//   transfer_to_vesting → user OWNS the vested BLURT
		//   delegate_vesting_shares → user BORROWS, can be revoked
		if (!src.includes("row.kind === 'vesting'")) {
			throw new Error('drainer no longer handles vesting kind');
		}
		if (!src.includes('broadcastTransferToVesting')) {
			throw new Error('drainer no longer uses transfer_to_vesting');
		}
	}
);

scenario('loyalty milestones match documented thresholds (100/500/2000/10000 BLURT)', () => {
	const src = readFile('apps/indexer/src/indexer/loyalty.ts');
	const expected = [
		'thresholdBlurt: 100, bpReward: 10',
		'thresholdBlurt: 500, bpReward: 50',
		'thresholdBlurt: 2_000, bpReward: 200',
		'thresholdBlurt: 10_000, bpReward: 1_000'
	];
	for (const e of expected) {
		if (!src.includes(e)) {
			throw new Error(`loyalty milestone drift: missing "${e}"`);
		}
	}
});

scenario('first-fee welcome BP = 1', () => {
	const src = readFile('apps/indexer/src/indexer/loyalty.ts');
	if (!src.includes('FIRST_FEE_WELCOME_BP = 1')) {
		throw new Error('first-fee welcome BP no longer 1');
	}
});

// ─── Misleading-shorthand check ──────────────────────────────────

scenario('no FAQ uses "10 BLURT + 10 BP" shorthand (misleading)', () => {
	const localeDir = join(REPO_ROOT, 'apps/web/src/lib/i18n/locales');
	const files = readdirSync(localeDir).filter((f) => f.endsWith('.json'));
	const offenders: string[] = [];
	// Check both Latin and Persian-numeral forms
	const PATTERNS = [
		/10 BLURT \+ 10 BP/, // English/most-locales numerics
		/۱۰ BLURT \+ ۱۰ BP/, // Persian numerals
		/10 BLURT and 10 BP/,
		/10 BLURT plus.*10 BP delegation/
	];
	for (const f of files) {
		const text = readFileSync(join(localeDir, f), 'utf-8');
		for (const p of PATTERNS) {
			if (p.test(text)) {
				offenders.push(`${f} matches /${p.source}/`);
				break;
			}
		}
	}
	if (offenders.length > 0) {
		throw new Error('misleading shorthand reintroduced:\n  ' + offenders.join('\n  '));
	}
});

scenario('no docs use the misleading shorthand either', () => {
	const docs = [
		'docs/AUDIT-2026-05.md',
		'docs/REVISIT-LIST.md',
		'docs/adr/0011-dynamic-fee-model.md',
		'docs/adr/0013-operator-incentives.md',
		'docs/FEES-AND-REWARDS.md'
	];
	const offenders: string[] = [];
	for (const d of docs) {
		const text = readFile(d);
		// Walk line-by-line; skip lines where the shorthand appears
		// only inside backticks (i.e. discussing the historical bug
		// or the smoke itself, not perpetuating the bug).
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (!/10 BLURT \+ 10 BP\b/.test(line)) continue;
			// Strip backtick-quoted strings — anything inside `...`
			// is allowed (it's quoted, not stating).
			const stripped = line.replace(/`[^`]*`/g, '');
			// Strip double-quoted strings too — same rationale.
			const fullyStripped = stripped.replace(/"[^"]*"/g, '');
			if (/10 BLURT \+ 10 BP\b/.test(fullyStripped)) {
				offenders.push(`${d}:${i + 1}`);
			}
		}
	}
	if (offenders.length > 0) {
		throw new Error('misleading shorthand in docs:\n  ' + offenders.join('\n  '));
	}
});

// ─── Canonical-reference doc must exist + match handler ──────────

scenario('FEES-AND-REWARDS.md exists and references handler line', () => {
	const text = readFile('docs/FEES-AND-REWARDS.md');
	// Sanity checks: the doc must mention the handler file path,
	// the welcome-bonus mechanic, and the milestone tier list.
	const expected = [
		'apps/indexer/src/indexer/handlers/feedback.ts',
		'apps/indexer/src/indexer/loyalty.ts',
		'10 BLURT liquid',
		'10 BLURT vesting',
		'100 BLURT',
		'1,260 BP'
	];
	for (const e of expected) {
		if (!text.includes(e)) {
			throw new Error(`FEES-AND-REWARDS.md missing reference to "${e}"`);
		}
	}
});

// ─── Final report ────────────────────────────────────────────────

console.log();
console.log('────────────────────────────────────────────────────────────');
if (failures > 0) {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} scenarios passed`);
