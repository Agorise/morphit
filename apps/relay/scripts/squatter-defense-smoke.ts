#!/usr/bin/env tsx
/**
 * apps/relay/scripts/squatter-defense-smoke.ts
 *
 * End-to-end check that the squatter-defense stack is wired
 * correctly: Layer 7 (high-value name policy) and Layer 8
 * (sequential detector) work together as the operator runbook
 * §18 promises.
 *
 * This is a regression smoke — it doesn't replace the per-module
 * unit tests (test/highValueName.test.ts and
 * test/sequentialDetector.test.ts).  It asserts the integrated
 * behavior, namely:
 *
 *   1. A short name is rejected by Layer 7 in `strict` policy
 *      WITHOUT the sequential detector being touched.
 *   2. A "lone" enumeration form (`usr001`) is rejected by
 *      Layer 7 even on the FIRST attempt.
 *   3. A long-prefix sequential pattern (`account001`,
 *      `account002`, `account003`) which Layer 7 lets pass on
 *      shape alone is caught by Layer 8 once enough prior
 *      signups accumulate.
 *   4. Year-suffix names (`crypto-noob-2026`) are NOT rejected
 *      by either layer — these are legitimate user names and
 *      the operator-runbook example in §18 promises they pass.
 *   5. Different /24 buckets don't poison each other (Layer 8
 *      bucket isolation).
 *
 * The integration test that actually drives the create endpoint
 * is in apps/relay/test/create.test.ts; this smoke uses the
 * underlying classifier + detector directly so it's fast and
 * catches "the operator-promised semantics changed" regressions
 * even when nothing in the create handler did.
 */

import { classifyHighValueName, isHighValueBlocked } from '../src/policy/highValueName.ts';
import { SequentialDetector } from '../src/policy/sequentialDetector.ts';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
	if (condition) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.log(`  ✗ ${label}${detail ? `\n    ${detail}` : ''}`);
	}
}

console.log('\n── squatter-defense end-to-end smoke ───────────────────\n');

// Helper: simulate the create handler's check ordering.
// Returns either 'blocked_by_layer_7', 'blocked_by_layer_8',
// or 'passed' — the same semantics the create.ts handler exposes.
type Verdict = 'blocked_by_layer_7' | 'blocked_by_layer_8' | 'passed';

function simulate(
	name: string,
	bucket: string,
	detector: SequentialDetector | null = null,
	hvPolicy: 'strict' | 'moderate' | 'off' = 'strict'
): Verdict {
	const cls = classifyHighValueName(name);
	if (isHighValueBlocked(cls, hvPolicy)) return 'blocked_by_layer_7';
	if (detector !== null) {
		const r = detector.check(name, bucket);
		if (r.blocked) return 'blocked_by_layer_8';
	}
	return 'passed';
}

// 1. Short name rejected by Layer 7.
check(
	'Layer 7: 3-char name `abc` rejected on FIRST attempt',
	simulate('abc', '203.0.113.0/24') === 'blocked_by_layer_7'
);
check(
	'Layer 7: 4-char name `abcd` rejected on FIRST attempt',
	simulate('abcd', '203.0.113.0/24') === 'blocked_by_layer_7'
);

// 2. Dictionary brand rejected by Layer 7 (strict).
check(
	'Layer 7: brand `bitcoin` rejected on FIRST attempt (strict)',
	simulate('bitcoin', '203.0.113.0/24') === 'blocked_by_layer_7'
);

// 3. Lone enumeration form rejected by Layer 7.
check(
	'Layer 7: `usr001` rejected on FIRST attempt (numeric_suffix)',
	simulate('usr001', '203.0.113.0/24') === 'blocked_by_layer_7'
);

// 4. Long-prefix sequential — Layer 7 PASSES, Layer 8 catches
//    the pattern once enough prior signups accumulate.
{
	const det = new SequentialDetector({
		windowMs: 3_600_000,
		thresholdCount: 2,
		minPrefixLen: 3
	});
	check(
		'Layer 7: `account001` passes Layer 7 (long prefix)',
		simulate('account001', '203.0.113.0/24', det) === 'passed'
	);
	det.recordSignup('account001', '203.0.113.0/24');
	check(
		'Layer 8: `account002` passes (only 1 prior, threshold 2)',
		simulate('account002', '203.0.113.0/24', det) === 'passed'
	);
	det.recordSignup('account002', '203.0.113.0/24');
	check(
		'Layer 8: `account003` BLOCKED (2 priors meet threshold)',
		simulate('account003', '203.0.113.0/24', det) === 'blocked_by_layer_8'
	);
}

// 5. Year-suffix legitimate names pass both layers.
{
	const det = new SequentialDetector({
		windowMs: 3_600_000,
		thresholdCount: 2,
		minPrefixLen: 3
	});
	check(
		'legitimate: `crypto-noob-2026` passes both layers',
		simulate('crypto-noob-2026', '203.0.113.0/24', det) === 'passed'
	);
	check(
		'legitimate: `myproject-2025` passes both layers',
		simulate('myproject-2025', '203.0.113.0/24', det) === 'passed'
	);
	check(
		'legitimate: `bob-1990` passes both layers',
		simulate('bob-1990', '203.0.113.0/24', det) === 'passed'
	);
	check(
		'legitimate: `alice` passes both layers',
		simulate('alice', '203.0.113.0/24', det) === 'passed'
	);
	check(
		'legitimate: `designer-jen` passes both layers',
		simulate('designer-jen', '203.0.113.0/24', det) === 'passed'
	);
}

// 6. Bucket isolation: a sequential pattern in /24 A doesn't
//    block a name in /24 B.
{
	const det = new SequentialDetector({
		windowMs: 3_600_000,
		thresholdCount: 2,
		minPrefixLen: 3
	});
	det.recordSignup('account001', '203.0.113.0/24');
	det.recordSignup('account002', '203.0.113.0/24');
	check(
		'Layer 8: bucket isolation — same name in different /24 passes',
		simulate('account003', '198.51.100.0/24', det) === 'passed'
	);
	check(
		'Layer 8: same /24 STILL blocks the next sequential',
		simulate('account003', '203.0.113.0/24', det) === 'blocked_by_layer_8'
	);
}

// 7. Moderate policy: brand passes, enumeration still blocks.
check(
	'moderate policy: `bitcoin` passes (brand allowed)',
	simulate('bitcoin', '203.0.113.0/24', null, 'moderate') === 'passed'
);
check(
	'moderate policy: `usr001` STILL blocked (enumeration)',
	simulate('usr001', '203.0.113.0/24', null, 'moderate') === 'blocked_by_layer_7'
);

// 8. Off policy: nothing blocks at Layer 7.
check(
	'off policy: even `bitcoin` passes (Layer 7 disabled)',
	simulate('bitcoin', '203.0.113.0/24', null, 'off') === 'passed'
);
check(
	'off policy: even `abc` passes (Layer 7 disabled)',
	simulate('abc', '203.0.113.0/24', null, 'off') === 'passed'
);

console.log('\n──────────────────────────────────────────────────────');
if (failures > 0) {
	console.log(`✗ ${failures}/${failures} scenarios failed`);
	process.exit(1);
} else {
	console.log('✓ all 18 scenarios passed');
}
