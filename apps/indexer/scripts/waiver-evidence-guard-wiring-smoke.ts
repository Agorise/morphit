#!/usr/bin/env tsx
/**
 * waiver-evidence-guard-wiring — v1.21.17.
 *
 * waiverEvidenceGuard.ts stops a node whose blocks past the consensus
 * activation time were applied without first-trade evidence (a late upgrade, a
 * rollback, an old snapshot). Its integration test covers the decision; this
 * pins that the poller runs it before applying anything, stops on its verdict,
 * keeps the marker in step, and starts a fresh node in step.
 *
 * v1.23.5: the same for repeatTradesGuard.ts (the repeat-trade rule from the
 * v1.23.5 activation time), which follows the same pattern, and the
 * repeat-trade start-up steps after it (naming times, admitting orders,
 * weights, the review-ring flags), before any block — the upgrade replay
 * included — is applied.
 *
 * Tamper tests (each must turn this red): drop either call from Poller.run,
 * catch and ignore either gap error, stop updating either marker in
 * markApplied (or update it unconditionally), insert a fresh state row
 * without either.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const poller = readFileSync(join(ROOT, 'src/indexer/poller.ts'), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean): void => {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (cond) passed++;
	else failed++;
};

const run = poller.slice(poller.indexOf('async run(): Promise<void> {'));
const firstApply = run.indexOf('applyBlock(');
const guard = run.indexOf('await checkWaiverEvidence(this.db,');
check(
	'Poller.run checks the evidence before it applies any block',
	guard > 0 &&
		(firstApply < 0 || guard < firstApply) &&
		guard < run.indexOf('reconcileAfterUpgrade(')
);
check(
	'a gap stops the node (the error is rethrown, not swallowed)',
	/if \(err instanceof WaiverEvidenceGapError\) \{\s*log\.error\('waiver_evidence_gap', \{\}, err\);\s*throw err;\s*\}/.test(
		run
	)
);
check(
	'markApplied keeps the marker in step only while it was',
	/waiver_evidence_through_block = CASE\s*WHEN waiver_evidence_through_block = last_applied_block THEN \$1\s*ELSE waiver_evidence_through_block\s*END/.test(
		poller
	)
);
check(
	'a fresh node starts in step (both markers)',
	/INSERT INTO indexer_state \(id, last_applied_block, chain_id, waiver_evidence_through_block,\s*repeat_trades_through_block\)\s*VALUES \(\$1, \$2, \$3, \$2, \$2\)/.test(
		poller
	)
);

// v1.23.5 — repeatTradesGuard.ts.
const repeatGuard = run.indexOf('await checkRepeatTradesRule(this.db,');
check(
	'Poller.run checks the repeat-trade rule before it applies any block',
	repeatGuard > 0 &&
		(firstApply < 0 || repeatGuard < firstApply) &&
		repeatGuard < run.indexOf('reconcileAfterUpgrade(')
);
check(
	'a repeat-trade gap stops the node (the error is rethrown, not swallowed)',
	/if \(err instanceof RepeatTradesGapError\) \{\s*log\.error\('repeat_trades_gap', \{\}, err\);\s*throw err;\s*\}/.test(
		run
	)
);
const reconcile = run.indexOf('reconcileAfterUpgrade(');
const steps = [
	'await healNamingTimes(this.db)',
	'await healOrderAccounts(this.db)',
	'await rewalkAllPairs(this.db)',
	'await redoReviewSignals(this.db)'
].map((s) => run.indexOf(s));
check(
	'the repeat-trade start-up steps run after the guard, in order, before any block is applied',
	steps.every((at) => at > repeatGuard) &&
		steps.every((at, i) => i === 0 || at > steps[i - 1]!) &&
		steps.every((at) => (firstApply < 0 || at < firstApply) && at < reconcile)
);
check(
	'markApplied keeps the repeat-trade marker in step only while it was',
	/repeat_trades_through_block = CASE\s*WHEN repeat_trades_through_block = last_applied_block THEN \$1\s*ELSE repeat_trades_through_block\s*END/.test(
		poller
	)
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) {
	console.log(`✓ all ${passed} waiver-evidence-guard-wiring scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed} of ${passed + failed} waiver-evidence-guard-wiring scenarios FAILED`);
process.exit(1);
