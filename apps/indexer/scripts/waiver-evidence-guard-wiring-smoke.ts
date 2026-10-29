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
 * Tamper tests (each must turn this red): drop the call from Poller.run, catch
 * and ignore the gap error, stop updating the marker in markApplied (or update
 * it unconditionally), insert a fresh state row without it.
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
	'a fresh node starts in step',
	/INSERT INTO indexer_state \(id, last_applied_block, chain_id, waiver_evidence_through_block\)\s*VALUES \(\$1, \$2, \$3, \$2\)/.test(
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
