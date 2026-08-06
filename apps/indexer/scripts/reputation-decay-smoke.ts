#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/reputation-decay-smoke.ts
 *
 * Structural Defense (cp123, H1) — invariants over the time-decay
 * reputation formula in apps/indexer/src/indexer/reputation/decay.ts.
 *
 * The JavaScript implementation (`reputationDecayWeight`) and the
 * SQL formula (`POWER(0.5, age_seconds / (365 * 86400))`) MUST
 * produce equivalent results for the verifiable-receipt endpoint
 * (cp124, H4) to work — readers will re-derive scores locally from
 * chain data using the JS implementation.
 *
 * Scenarios:
 *   D-1  weight(0) === 1.0 (review just posted)
 *   D-2  weight(365d) === 0.5 (one half-life)
 *   D-3  weight(730d) === 0.25 (two half-lives)
 *   D-4  weight(1095d) ≈ 0.125 (three half-lives)
 *   D-5  weight is monotonically decreasing with age
 *   D-6  weight is always in (0, 1]
 *   D-7  weight(NaN) === 1 (defensive default)
 *   D-8  weight(negative age) === 1 (defensive default)
 *   D-9  computeWeightedRating handles empty array → null
 *   D-10 computeWeightedRating with all-fresh rows = simple avg
 *   D-11 computeWeightedRating: fresh 5-star outweighs ancient 1-star
 *   D-12 computeWeightedRating with multiple ages — math sanity
 *   D-13 same-age different-rating rows: weighted = AVG(ratings)
 */

import {
	reputationDecayWeight,
	computeWeightedRating,
	REPUTATION_DECAY_HALF_LIFE_DAYS
} from '../src/indexer/reputation/decay';

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── reputation-decay invariants smoke (cp123 H1) ───\n');

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_MS = REPUTATION_DECAY_HALF_LIFE_DAYS * DAY_MS;

// D-1
{
	const w = reputationDecayWeight(0);
	if (Math.abs(w - 1.0) < 1e-9) pass('D-1 weight(0) === 1.0');
	else fail('D-1 weight(0) === 1.0', `got ${w}`);
}

// D-2
{
	const w = reputationDecayWeight(HALF_LIFE_MS);
	if (Math.abs(w - 0.5) < 1e-9) pass(`D-2 weight(${REPUTATION_DECAY_HALF_LIFE_DAYS}d) === 0.5`);
	else fail(`D-2 weight(${REPUTATION_DECAY_HALF_LIFE_DAYS}d) === 0.5`, `got ${w}`);
}

// D-3
{
	const w = reputationDecayWeight(2 * HALF_LIFE_MS);
	if (Math.abs(w - 0.25) < 1e-9) pass(`D-3 weight(${2 * REPUTATION_DECAY_HALF_LIFE_DAYS}d) === 0.25`);
	else fail(`D-3 weight(2×half-life) === 0.25`, `got ${w}`);
}

// D-4
{
	const w = reputationDecayWeight(3 * HALF_LIFE_MS);
	if (Math.abs(w - 0.125) < 1e-9) pass(`D-4 weight(3×half-life) === 0.125`);
	else fail(`D-4 weight(3×half-life) === 0.125`, `got ${w}`);
}

// D-5 monotonically decreasing
{
	const ages = [0, 30, 100, 365, 1000, 1825, 3650].map((d) => d * DAY_MS);
	const weights = ages.map((a) => reputationDecayWeight(a));
	let monotonic = true;
	for (let i = 1; i < weights.length; i++) {
		if (weights[i]! >= weights[i - 1]!) {
			monotonic = false;
			break;
		}
	}
	if (monotonic) pass('D-5 weight is monotonically decreasing with age');
	else fail('D-5 weight monotonicity', `weights: ${weights.join(', ')}`);
}

// D-6 weight bounds
{
	const ages = [0, 1, 30 * DAY_MS, 365 * DAY_MS, 10 * 365 * DAY_MS, 100 * 365 * DAY_MS];
	const weights = ages.map((a) => reputationDecayWeight(a));
	const inRange = weights.every((w) => w > 0 && w <= 1);
	if (inRange) pass('D-6 weight is always in (0, 1]');
	else fail('D-6 weight bounds', `weights: ${weights.join(', ')}`);
}

// D-7 NaN guard
{
	const w = reputationDecayWeight(NaN);
	if (w === 1) pass('D-7 weight(NaN) === 1 (defensive default)');
	else fail('D-7 weight(NaN)', `got ${w}`);
}

// D-8 negative age guard
{
	const w = reputationDecayWeight(-1000);
	if (w === 1) pass('D-8 weight(negative) === 1 (defensive default)');
	else fail('D-8 weight(negative)', `got ${w}`);
}

// D-9 empty array
{
	const r = computeWeightedRating([]);
	if (r === null) pass('D-9 computeWeightedRating([]) === null');
	else fail('D-9 empty array', `got ${r}`);
}

// D-10 all-fresh = avg
{
	const now = Date.now();
	const rows = [
		{ rating: 5, createdAt: now },
		{ rating: 4, createdAt: now },
		{ rating: 3, createdAt: now }
	];
	const r = computeWeightedRating(rows, now);
	const expected = 4.0;
	if (r !== null && Math.abs(r - expected) < 1e-9) pass('D-10 all-fresh rows: weighted = simple avg');
	else fail('D-10 all-fresh = avg', `got ${r}, expected ${expected}`);
}

// D-11 fresh 5-star outweighs ancient 1-star
{
	const now = Date.now();
	const rows = [
		{ rating: 5, createdAt: now }, // fresh, weight 1.0
		{ rating: 1, createdAt: now - 5 * HALF_LIFE_MS } // 5 half-lives old → weight 0.03125
	];
	const r = computeWeightedRating(rows, now);
	// Expected: (5*1 + 1*0.03125) / (1 + 0.03125) ≈ 4.878
	if (r !== null && r > 4.5 && r < 5.0) {
		pass(`D-11 fresh 5-star outweighs ancient 1-star (weighted = ${r.toFixed(4)})`);
	} else {
		fail('D-11 fresh outweighs ancient', `got ${r}, expected ~4.88`);
	}
}

// D-12 multi-age math
{
	const now = Date.now();
	const rows = [
		{ rating: 5, createdAt: now }, // w=1
		{ rating: 5, createdAt: now - HALF_LIFE_MS }, // w=0.5
		{ rating: 1, createdAt: now } // w=1
	];
	const r = computeWeightedRating(rows, now);
	// Expected: (5*1 + 5*0.5 + 1*1) / (1 + 0.5 + 1) = 8.5/2.5 = 3.4
	const expected = 8.5 / 2.5;
	if (r !== null && Math.abs(r - expected) < 1e-6) {
		pass(`D-12 multi-age weighted math (${r.toFixed(4)} ≈ ${expected.toFixed(4)})`);
	} else {
		fail('D-12 multi-age math', `got ${r}, expected ${expected}`);
	}
}

// D-13 same-age rows: weighted = AVG
{
	const now = Date.now();
	const oldDate = now - 100 * DAY_MS; // 100 days; weight same for all
	const rows = [
		{ rating: 5, createdAt: oldDate },
		{ rating: 4, createdAt: oldDate },
		{ rating: 3, createdAt: oldDate },
		{ rating: 2, createdAt: oldDate }
	];
	const r = computeWeightedRating(rows, now);
	const expected = 3.5;
	if (r !== null && Math.abs(r - expected) < 1e-9) {
		pass('D-13 same-age rows: weighted = AVG (weights cancel)');
	} else {
		fail('D-13 same-age rows', `got ${r}, expected ${expected}`);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error(`\nreputation-decay smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} reputation-decay scenarios passed`);
