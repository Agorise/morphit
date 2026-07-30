#!/usr/bin/env tsx
/**
 * feedback-list-summary-parity — v1.8.12 (Ken).
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
 *   • Signal D (review_concentration) was added to the summary CTE in cp123 but
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

/** The summary aggregate: everything up to `FROM non_suppressed`. */
const summaryEnd = src.indexOf('FROM non_suppressed');
const summary = src.slice(0, summaryEnd);
/** The per-row flag query that decides `suppressed`. */
const flagStart = src.indexOf('const flaggedReviewers');
const flagEnd = src.indexOf('for (const r of flagResult.rows)');
const flagQuery = src.slice(flagStart, flagEnd);

check('the summary aggregate is present', summaryEnd > 0);
check('the per-row flag query is present', flagStart > 0 && flagEnd > flagStart);

/** Every signal table the SCORE excludes on must also be in the ROW flag —
 *  otherwise a review is silently uncounted while looking ordinary. */
const SIGNAL_TABLES = [
	'suspicious_reciprocity',
	'related_accounts',
	'one_way_pile_on',
	'review_concentration'
] as const;

for (const table of SIGNAL_TABLES) {
	const inSummary = new RegExp(`FROM ${table}\\b`).test(summary);
	const inFlag = new RegExp(`FROM ${table}\\b`).test(flagQuery);
	check(
		`${table}: excluded from the score`,
		inSummary,
		'this smoke guards parity; a table absent from BOTH is a different question'
	);
	check(
		`${table}: and marked on the row, so the list agrees`,
		!inSummary || inFlag,
		'a review excluded from the score but unmarked in the list is a silent lie about the score'
	);
}

// The permlink rule is enforced in SQL on the summary side and in TypeScript on
// the row side, so it needs its own check rather than a table-name match.
check(
	'the score requires an order permlink (an unanchored review cannot be verified)',
	/order_permlink IS NOT NULL/.test(summary),
	'without this, anyone could inflate a reputation with reviews tied to no trade'
);
check(
	'…and a review without one is marked in the list',
	/suppressed:[\s\S]{0,400}?r\.order_permlink === null/.test(src),
	'it would otherwise render as an ordinary review while counting for nothing'
);

// Guard against the inverse drift: a row marked suppressed for a reason the
// score does NOT act on would under-report someone's reputation.
check(
	'the row flag introduces no exclusion the score does not apply',
	SIGNAL_TABLES.every((t) => !new RegExp(`FROM ${t}\\b`).test(flagQuery) || new RegExp(`FROM ${t}\\b`).test(summary)),
	'marking a review as uncounted when it IS counted understates a reputation'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} feedback-list-summary-parity checks passed` : '✗ feedback-list-summary-parity FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
