#!/usr/bin/env tsx
/**
 * feedback-list-summary-parity — v1.8.12.
 *
 * THE INVARIANT. A profile shows two things computed by two different queries:
 * the SCORE (a summary aggregate) and the LIST of reviews beneath it. They must
 * agree about which reviews count. A review that renders as ordinary while
 * contributing nothing to the score is a silent lie about someone's reputation.
 *
 * The per-row `suppressed` flag exists precisely to keep them reconciled — its
 * own docblock says so ("so the list reconciles with the summary, Finding R15").
 * It had drifted out of sync on TWO counts:
 *
 *   • Signal D (review_concentration) was added to the summary CTE but
 *     never to the row flag, so a concentration-flagged review displayed
 *     normally and counted for nothing. Same 3-of-4 signal gap this release
 *     found in the moderation CLI.
 *   • The summary requires `order_permlink IS NOT NULL`; the list query has no
 *     such filter. `order_permlink` is NULLABLE and the intake handler treats it
 *     as optional, so an unanchored review — one that cannot be checked against
 *     any real trade — showed as an ordinary review while being excluded from
 *     the score. Reachable, not theoretical.
 *
 * Excluding both from the SCORE is correct and must stay: counting a review tied
 * to no trade would let anyone inflate a reputation at will. The fix is that the
 * list has to say so.
 *
 * Tamper tests (each must turn this red):
 *   - Drop a signal from the row-flag query that the summary still excludes on.
 *   - Drop the `order_permlink === null` term from the row flag.
 *   - Add an exclusion to the summary CTE without adding it to the row flag.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { feedbackPairCountsSql } from '../src/api/reputationJoin.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..', 'src/api/feedback.ts');
const src = readFileSync(API, 'utf8');

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

console.log('\n── feedback-list-summary-parity (v1.8.12) ────────────\n');

// The four signals are ONE predicate, feedbackPairCountsSql in reputationJoin.ts;
// the summary keeps the rows it accepts and both row flags mark the rows it
// rejects, so they agree by construction as long as all three call it.
// (Behavioural guard: test/integration/feedback-count-once.test.ts.)
const summaryEnd = src.indexOf('FROM non_suppressed');
const summary = src.slice(0, summaryEnd);
const received = src.slice(src.indexOf('const flaggedReviewers'), src.indexOf('for (const r of flagResult.rows) flaggedReviewers'));
const givenFlag = src.slice(src.indexOf('const flaggedSubjects'), src.indexOf('for (const r of flagResult.rows) flaggedSubjects'));

check('the summary aggregate is present', summaryEnd > 0);
check(
	'the summary keeps reviews by the shared predicate',
	/AND \$\{feedbackPairCountsSql\('f\.reviewer', 'f\.subject'\)\}/.test(summary)
);
check(
	'the received list flags by NOT the shared predicate',
	/WHERE NOT \(\$\{feedbackPairCountsSql\(/.test(received)
);
check(
	'the given list flags by NOT the shared predicate',
	/WHERE NOT \(\$\{feedbackPairCountsSql\(/.test(givenFlag)
);

const SIGNAL_TABLES = [
	'suspicious_reciprocity',
	'related_accounts',
	'one_way_pile_on',
	'review_concentration'
] as const;
const predicate = feedbackPairCountsSql('r', 's');
for (const table of SIGNAL_TABLES) {
	check(`${table}: in the shared predicate`, new RegExp(`FROM ${table}\\b`).test(predicate));
}

// The permlink rule is enforced in SQL on the summary side and in TypeScript on
// the row side, so it needs its own check rather than a table-name match.
check(
	'the score requires an order permlink (an unanchored review cannot be verified)',
	/order_permlink IS NOT NULL/.test(summary),
	'without this, anyone could inflate a reputation with reviews tied to no trade'
);
check(
	'…and a review without one is marked in BOTH lists',
	(src.match(/suppressed:[\s\S]{0,400}?r\.order_permlink === null/g) ?? []).length === 2,
	'it would otherwise render as an ordinary review while counting for nothing'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} feedback-list-summary-parity checks passed` : '✗ feedback-list-summary-parity FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
