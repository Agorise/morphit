#!/usr/bin/env tsx
/**
 * moderation-signal-coverage — v1.8.12 (Ken).
 *
 * THE BUG THIS EXISTS TO PREVENT. The reputation summary in
 * `apps/indexer/src/api/feedback.ts` excludes a review if the pair appears in
 * ANY of FOUR tables:
 *
 *   suspicious_reciprocity  (Signal B)   related_accounts     (Signal A)
 *   one_way_pile_on         (Signal C)   review_concentration (Signal D)
 *
 * Everything built to MANAGE those flags knew about only two. The result was a
 * reputation that could be suppressed permanently with no recourse at all:
 *
 *   • `morphit-ops moderation` queried A and B only, so it reported
 *     "0 flags" while a Signal-D flag sat there suppressing a reputation.
 *   • `clearFlag` mapped to A and B only, so C and D could not be cleared.
 *   • The C and D detectors never consulted `moderation_flag_clearances`, so
 *     deleting a row by hand did nothing — the next pass re-created it.
 *   • The clearance table's CHECK constraint permitted only 'reciprocity' and
 *     'related', so C and D were unclearable at the DATABASE level. That was
 *     the root: no amount of CLI work could have fixed it.
 *
 * Ken lost an afternoon to it. He ran the moderation command, saw zero flags,
 * and had to be walked through raw SQL across all four tables before the cause
 * — two review_concentration rows on his own test accounts — was visible.
 *
 * The invariant: ANY table that can suppress a reputation must be visible in
 * the operator view, clearable, and honoured by its detector. This smoke fails
 * when a fifth signal is added to the suppression query without the other
 * three layers following it.
 *
 * Tamper tests (each must turn this red):
 *   - Drop a table from the CLI's fetchers.
 *   - Remove a signal from SIGNAL_TABLE in clearFlag.
 *   - Remove the clearance check from a detector.
 *   - Narrow the migration-51 CHECK constraint back to two values.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

const feedbackApi = read('apps/indexer/src/api/feedback.ts');
const signals = read('apps/indexer/src/indexer/signals.ts');
const modLib = read('apps/ops-cli/src/lib/moderationSignals.ts');
const modCmd = read('apps/ops-cli/src/commands/moderation.ts');
const migrations = read('apps/indexer/src/db/migrations.ts');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── moderation-signal-coverage (v1.8.12) ──────────────\n');

/** The four tables the reputation summary suppresses on. If a fifth is ever
 *  added to that query, add it here and to all three management layers. */
const SUPPRESSION_TABLES = [
	'suspicious_reciprocity',
	'related_accounts',
	'one_way_pile_on',
	'review_concentration'
] as const;

// ─── 1. every listed table really does suppress ──────────────────
// Anchored on the real query so this list cannot drift into fiction.
for (const table of SUPPRESSION_TABLES) {
	check(
		`${table} is used by the reputation-summary suppression`,
		new RegExp(`FROM ${table}\\b`).test(feedbackApi),
		'this smoke would otherwise be guarding a table that does not matter'
	);
}

// ─── 2. the operator can SEE each of them ────────────────────────
for (const table of SUPPRESSION_TABLES) {
	check(
		`operator view queries ${table}`,
		new RegExp(`FROM ${table}\\b`).test(modLib),
		'a flag the operator cannot see is a flag they cannot clear'
	);
}
check(
	'the flag count covers all four, not a subset',
	/pileOn\.length/.test(modCmd) && /concentration\.length/.test(modCmd),
	'reporting a partial total as "N flags" is what showed Ken a misleading zero'
);
check(
	'--type accepts every signal',
	/'reciprocity', 'related', 'pile_on', 'concentration'/.test(modCmd),
	'filtering to a signal the tool refuses to name is useless'
);

// ─── 3. the operator can CLEAR each of them ──────────────────────
// Assert the signal maps to its OWN table, not merely that the key exists — a
// tamper that pointed `concentration` at `related_accounts` passed the weaker
// version of this check, which would have let clearFlag silently delete from
// the wrong table.
const SIGNAL_TO_TABLE: ReadonlyArray<readonly [string, string]> = [
	['reciprocity', 'suspicious_reciprocity'],
	['related', 'related_accounts'],
	['pile_on', 'one_way_pile_on'],
	['concentration', 'review_concentration']
];
for (const [sig, table] of SIGNAL_TO_TABLE) {
	check(
		`clearFlag maps '${sig}' → ${table}`,
		new RegExp(`${sig}: '${table}'`).test(modLib),
		'an unclearable — or wrongly-mapped — signal suppresses a reputation forever'
	);
}
check(
	'the clearance table accepts all four signals (migration 51)',
	/CHECK \(signal IN \('reciprocity', 'related', 'pile_on', 'concentration'\)\)/.test(migrations),
	'the ROOT cause: C and D were unclearable at the database level'
);

// ─── 4. each DETECTOR honours a clearance ────────────────────────
// Without this a clearance is cosmetic: the row returns on the next pass.
const detectorsNeedingClearance = [
	['detectSuspiciousReciprocityInTx', 'reciprocity'],
	['detectRelatedAccountsInTx', 'related'],
	['detectReviewConcentrationInTx', 'concentration']
] as const;
for (const [fn, sig] of detectorsNeedingClearance) {
	const start = signals.indexOf(`export async function ${fn}`);
	const body = start === -1 ? '' : signals.slice(start, start + 4000);
	check(
		`${fn} consults moderation_flag_clearances`,
		body.includes('moderation_flag_clearances') && body.includes(`'${sig}'`),
		'clearing is cosmetic unless the detector checks it before re-inserting'
	);
}

// ─── 5. behavioural clearances re-arm; identity ones do not ──────
check(
	"the concentration clearance captures a watermark (it is BEHAVIOURAL)",
	/params\.signal === 'concentration'[\s\S]{0,600}?MAX\(review_count\)/.test(modLib),
	'a permanent clearance here would blind the detector to a pair that resumes concentrating'
);
check(
	'the related-accounts clearance stays permanent (identity facts cannot change)',
	!/params\.signal === 'related'[\s\S]{0,300}?watermark =/.test(modLib),
	'a re-arming clearance would re-flag the same pair forever on immutable evidence'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} moderation-signal-coverage checks passed` : '✗ moderation-signal-coverage FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
