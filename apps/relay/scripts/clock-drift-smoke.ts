#!/usr/bin/env tsx
/**
 * Smoke for clock-drift checker — task #7.
 *
 * Pure function; tests classify drift levels.
 */

import { checkClockDrift, DRIFT_WARN_MS, DRIFT_FATAL_MS } from '../src/clock/driftCheck.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(
			`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
		);
	}
}

console.log('\n── clock drift smoke ────────────────────────────────────\n');

const NOW = 1_700_000_000_000;

scenario('zero drift → ok', () => {
	const r = checkClockDrift(NOW, NOW);
	assertEqual(r.severity, 'ok', 'severity');
	assertEqual(r.driftMs, 0, 'drift');
});

scenario('1s drift (under warn threshold) → ok', () => {
	const r = checkClockDrift(NOW + 1_000, NOW);
	assertEqual(r.severity, 'ok', 'severity');
});

scenario('-1s drift → ok', () => {
	const r = checkClockDrift(NOW - 1_000, NOW);
	assertEqual(r.severity, 'ok', 'severity');
});

scenario('exactly warn threshold → warn', () => {
	const r = checkClockDrift(NOW + DRIFT_WARN_MS, NOW);
	assertEqual(r.severity, 'warn', 'severity');
});

scenario('30s drift → warn', () => {
	const r = checkClockDrift(NOW + 30_000, NOW);
	assertEqual(r.severity, 'warn', 'severity');
	if (!r.message.includes('AHEAD')) throw new Error('expected AHEAD wording');
});

scenario('-30s drift → warn (BEHIND)', () => {
	const r = checkClockDrift(NOW - 30_000, NOW);
	assertEqual(r.severity, 'warn', 'severity');
	if (!r.message.includes('BEHIND')) throw new Error('expected BEHIND wording');
});

scenario('exactly fatal threshold → fatal', () => {
	const r = checkClockDrift(NOW + DRIFT_FATAL_MS, NOW);
	assertEqual(r.severity, 'fatal', 'severity');
});

scenario('1 hour drift → fatal', () => {
	const r = checkClockDrift(NOW + 3_600_000, NOW);
	assertEqual(r.severity, 'fatal', 'severity');
});

scenario('-1 hour drift → fatal', () => {
	const r = checkClockDrift(NOW - 3_600_000, NOW);
	assertEqual(r.severity, 'fatal', 'severity');
});

scenario('drift fields are correctly populated', () => {
	const r = checkClockDrift(NOW + 7_500, NOW);
	assertEqual(r.localMs, NOW + 7_500, 'localMs');
	assertEqual(r.chainMs, NOW, 'chainMs');
	assertEqual(r.driftMs, 7_500, 'driftMs');
});

scenario('messages reference docs/OPERATIONS.md for non-ok cases', () => {
	const warnR = checkClockDrift(NOW + 30_000, NOW);
	if (!warnR.message.includes('OPERATIONS.md')) {
		throw new Error('warn message should point at OPERATIONS.md');
	}
	const fatalR = checkClockDrift(NOW + 3_600_000, NOW);
	if (!fatalR.message.includes('OPERATIONS.md')) {
		throw new Error('fatal message should point at OPERATIONS.md');
	}
});

scenario('thresholds are sensible', () => {
	if (DRIFT_WARN_MS >= DRIFT_FATAL_MS) {
		throw new Error('warn threshold must be less than fatal');
	}
	if (DRIFT_WARN_MS < 1_000) {
		throw new Error('warn threshold should be at least 1s');
	}
	if (DRIFT_FATAL_MS > 600_000) {
		throw new Error('fatal threshold should be reasonably tight (under 10 min)');
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
