#!/usr/bin/env tsx
/**
 * moderation-flag-clearance — v1.8.9.
 *
 * A self-trade flag is a signal, not a verdict: honest activity trips Signals
 * A/B (two handles on one LAN will do it), and a flagged account loses its
 * reputation card and has every review subdued. Clearing has TWO halves, and
 * dropping either one fails in a way that looks like success:
 *
 *   1. DELETE the flag row  → restores the account immediately (all ~10
 *      reputation/review read paths read the flag tables live).
 *      Without this, nothing visibly changes.
 *   2. RECORD the clearance → makes it last. The detectors re-run and would
 *      re-insert the identical row on their next pass, so a bare DELETE
 *      appears to work and then silently undoes itself.
 *
 * And the two signals must clear with DIFFERENT lifetimes:
 *   - Signal A keys on account-CREATION facts (immutable) → PERMANENT. A
 *     re-arming clearance would re-flag the same pair forever on evidence that
 *     can never change.
 *   - Signal B is BEHAVIOURAL → forgiven up to a WATERMARK, re-fires on growth.
 *     Not a time window: that re-flags on the same old reviews when it expires.
 *
 * Tamper tests (each must turn this red):
 *   - Drop either NOT EXISTS clearance check from signals.ts → fails.
 *   - Make Signal B's clearance unconditional (permanent) → fails.
 *   - Give Signal A a watermark condition (re-arming) → fails.
 *   - Have clearFlag record without deleting, or delete without recording → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

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

console.log('\n── moderation-flag-clearance (v1.8.9) ────────────────\n');

const migrations = read('apps/indexer/src/db/migrations.ts');
const schema = read('apps/indexer/src/db/schema.sql');
const signals = read('apps/indexer/src/indexer/signals.ts');
const lib = read('apps/ops-cli/src/lib/moderationSignals.ts');
const cmd = read('apps/ops-cli/src/commands/moderation.ts');
const ops = read('docs/OPERATIONS.md');
const runNode = read('docs/RUN-A-MORPHIT-NODE.md');

// ─── the table exists in BOTH the migration and the fresh-install schema ───
for (const [label, src] of [
	['migrations.ts', migrations],
	['schema.sql', schema]
] as const) {
	check(
		`${label} defines moderation_flag_clearances`,
		/CREATE TABLE IF NOT EXISTS moderation_flag_clearances/.test(src),
		'a table in only one of the two means fresh installs and upgrades diverge'
	);
	check(
		`${label} carries the Signal B watermark column`,
		/watermark\s+integer\s+NULL/.test(src)
	);
	check(
		`${label} stores pairs canonically (a < b)`,
		/CHECK \(account_a < account_b\)/.test(src),
		'so a clearance matches whichever order the operator typed the names in'
	);
}

// ─── the detector must consult clearances, or the clear is cosmetic ───
const sigB = /INSERT INTO suspicious_reciprocity[\s\S]*?ON CONFLICT/.exec(signals)?.[0] ?? '';
const sigA = /INSERT INTO related_accounts[\s\S]*?ON CONFLICT/.exec(signals)?.[0] ?? '';
check('the Signal B insert was located', sigB.length > 0);
check('the Signal A insert was located', sigA.length > 0);
check(
	'Signal B refuses to re-raise a cleared pair',
	/NOT EXISTS \([\s\S]*?moderation_flag_clearances/.test(sigB),
	'without this the flag returns on the next detector pass and the clear undoes itself'
);
check(
	'Signal A refuses to re-raise a cleared pair',
	/NOT EXISTS \([\s\S]*?moderation_flag_clearances/.test(sigA)
);

// ─── ...with the RIGHT lifetime for each ───
check(
	'Signal B clearance is WATERMARKED, not permanent (behavioural signal)',
	/c\.watermark IS NULL[\s\S]*?<= c\.watermark \+ \$3/.test(sigB),
	'a permanent clearance would blind the detector to genuinely new collusion'
);
check(
	'Signal A clearance is PERMANENT — no watermark condition (immutable evidence)',
	!/watermark/.test(sigA),
	're-arming would re-flag the same pair forever on account-creation facts that cannot change'
);
check(
	'the re-arm threshold is a WHOLE signal, derived from the trigger itself',
	/const SIGNAL_B_CLEARANCE_GROWTH = 2 \* SIGNAL_B_MIN_COUNT;/.test(signals),
	'a cleared pair should have to earn the flag from scratch, not trip on one stray review'
);
check(
	'that threshold is actually passed to the query',
	/SIGNAL_B_CLEARANCE_GROWTH\s*\n?\s*\]\)/.test(signals) || /SIGNAL_B_CLEARANCE_GROWTH/.test(signals.split('const sql')[1] ?? '')
);

// ─── clearFlag must do BOTH halves ───
check(
	'clearFlag RECORDS the clearance (this is what makes it last)',
	/INSERT INTO moderation_flag_clearances/.test(lib)
);
check(
	'clearFlag DELETES the flag row (this is what restores the account)',
	/DELETE FROM \$\{table\}/.test(lib),
	'recording without deleting leaves the account flagged until the next detector pass'
);
check(
	'the watermark is captured from the CURRENT count, and only for Signal B',
	/if \(params\.signal === 'reciprocity'\)[\s\S]{0,400}?mutual_review_count/.test(lib)
);
check(
	'a pre-emptive clear (no flag row yet) still lets an outright-earned flag raise',
	/watermark = typeof row\?\.mutual_review_count === 'number' \? row\.mutual_review_count : 0;/.test(lib),
	'defaulting to 0 rather than infinity'
);
check('a clearance can be undone', /export async function unclearFlag/.test(lib));

// ─── the operator can actually reach it ───
check(
	'Moderation offers clearing alongside block/unblock',
	/Clear a flag \(restore an account\)/.test(cmd),
	'the mechanism is worthless if no menu path reaches it'
);
// v1.8.13 (Ken) — the option is now "ALL signals", not "Both". It said "Both"
// while FOUR signals can suppress a reputation, and only cleared two of them:
// Ken picked it for a concentration-flagged pair, the command reported success,
// and the flags stayed. Clearing a subset while reporting success is worse than
// refusing, because it looks resolved. The requirement is that the all-signals
// option LEADS (a pair that trips one usually trips others) and genuinely
// covers every signal.
check(
	'clearing ALL signals leads the menu (a pair that trips one usually trips others)',
	/ALL signals for this pair \(usual choice\)/.test(cmd)
);
check(
	'the clearances list shows each entry\'s lifetime',
	/permanent/.test(cmd) && /watched from/.test(cmd)
);

// ─── documented in BOTH operator docs ───
check(
	'OPERATIONS.md explains the two lifetimes and why they differ',
	/Signal A\) — permanent/.test(ops) && /watermark/.test(ops)
);
check(
	'RUN-A-MORPHIT-NODE.md tells an operator they can undo a flag',
	/Clear a flag/.test(runNode)
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} moderation-flag-clearance checks passed` : '✗ moderation-flag-clearance FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
