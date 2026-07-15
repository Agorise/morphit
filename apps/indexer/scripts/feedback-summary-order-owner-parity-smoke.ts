#!/usr/bin/env tsx
/*
 * feedback-summary-order-owner-parity — cp471 (t.txt F/H) guard.
 *
 * The feedback INTAKE (indexer/handlers/feedback.ts) accepts a cited
 * order posted by EITHER party to the trade — `account IN (subject,
 * reviewer)` (cp420) — because a MAKER reviewing the TAKER cites the
 * maker's OWN order, so the order belongs to the reviewer, not the
 * subject.
 *
 * The reputation SUMMARY query (api/feedback.ts, /v1/accounts/:account/
 * feedback) originally INNER-JOINed orders on `o.account = f.subject`
 * ONLY. That silently DROPPED every maker→taker review from the
 * aggregate — the subject's whole reputation read "No feedback yet"
 * despite a real, verified, on-chain review. Two symptoms, one cause:
 * it also made "View the order" land on the "being posted" limbo.
 *
 * This sentinel locks the summary JOIN to the intake's ownership rule so
 * the two can't drift again:
 *   1. intake still accepts EITHER party (`account IN ($1, $3)`);
 *   2. the summary JOIN matches EITHER party (`o.account IN (f.subject,
 *      f.reviewer)`), NOT the old subject-only `ON o.account = f.subject`;
 *   3. the summary uses a LEFT JOIN (a since-removed order can't zero the
 *      count either);
 *   4. the summary flips the subject's side when the reviewer owns the
 *      order (`WHEN o.account = f.reviewer`), so the by_side breakdown
 *      stays correct.
 *
 * Revert any of those and this smoke fails — the regression is impossible
 * short of deleting the sentinel.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

let pass = 0;
let fail = 0;
function ok(msg: string): void {
	pass++;
	console.log(`  ✓ ${msg}`);
}
function bad(scope: string, msg: string): void {
	fail++;
	console.log(`  ✗ ${scope}: ${msg}`);
}

const intake = readFileSync(resolve(SRC, 'indexer/handlers/feedback.ts'), 'utf8');
const summary = readFileSync(resolve(SRC, 'api/feedback.ts'), 'utf8');

// Normalize whitespace so multi-line/indented SQL matches regardless of
// wrapping. Collapse runs of whitespace to single spaces.
const flatIntake = intake.replace(/\s+/g, ' ');
const flatSummary = summary.replace(/\s+/g, ' ');

// 1. Intake accepts a cited order from EITHER party (subject OR signer).
if (/account IN \(\$1, \$3\)/.test(flatIntake)) {
	ok('intake: cited-order check accepts EITHER party (account IN ($1, $3))');
} else {
	bad(
		'intake',
		'the cited-order check no longer accepts account IN ($1, $3) (subject, reviewer). If intake was intentionally narrowed, the summary JOIN below must be re-narrowed to match — see cp420 / cp471.'
	);
}

// 2. Summary JOIN matches EITHER party — parity with the intake.
if (/o\.account IN \(f\.subject, f\.reviewer\)/.test(flatSummary)) {
	ok('summary: orders JOIN matches EITHER party (o.account IN (f.subject, f.reviewer))');
} else {
	bad(
		'summary',
		'the reputation summary JOIN no longer matches BOTH parties. A subject-only join silently drops every maker→taker review — the exact "No feedback yet" bug (cp471, t.txt F/H).'
	);
}

// 3. The old subject-only JOIN condition must be GONE (tamper guard).
//    (The side CASE legitimately contains `o.account = f.subject`, so we
//    only forbid it as the JOIN's ON clause: `ON o.account = f.subject`.)
if (/ON o\.account = f\.subject/.test(flatSummary)) {
	bad(
		'summary',
		'the old subject-only JOIN condition `ON o.account = f.subject` is back — this re-breaks maker→taker reputation (cp471, t.txt F/H).'
	);
} else {
	ok('summary: the old subject-only JOIN condition (ON o.account = f.subject) is absent');
}

// 4. Summary uses a LEFT JOIN so a since-removed order cannot zero the count.
if (/LEFT JOIN orders o/.test(flatSummary)) {
	ok('summary: orders JOIN is LEFT (a since-removed order cannot drop the count)');
} else {
	bad(
		'summary',
		'the orders JOIN is no longer a LEFT JOIN — a completed/removed order would drop the whole review from the count again (cp471).'
	);
}

// 5. Side classification flips for the reviewer-owned order.
if (/WHEN o\.account = f\.reviewer/.test(flatSummary)) {
	ok("summary: by_side flips the subject's side when the reviewer owns the order");
} else {
	bad(
		'summary',
		"the side CASE no longer flips for a reviewer-owned order — the buy/sell breakdown will mis-classify the subject's role (cp471)."
	);
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
