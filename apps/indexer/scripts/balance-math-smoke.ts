/**
 * Morphit smoke — Blurt balance math (VESTS→BP, voting-power regen).
 *
 * Pure deterministic helpers; verifies the standard Steem-family
 * formulas against known reference values.
 */

import {
	parseAssetAmount,
	vestsToBlurtPower,
	votingPowerPercent,
	formatBalance,
	formatPercentage,
	VOTE_POWER_REGEN_SECONDS
} from '../../web/src/lib/blurt/balanceMath';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── balance math smoke ────────────────────────────────────\n');

// ─── parseAssetAmount ───────────────────────────────────────────────

scenario('parseAssetAmount handles BLURT format', () => {
	if (parseAssetAmount('42.123 BLURT') !== 42.123) throw new Error('BLURT amount');
});
scenario('parseAssetAmount handles VESTS format', () => {
	if (parseAssetAmount('1000000.123456 VESTS') !== 1000000.123456) throw new Error('VESTS amount');
});
scenario('parseAssetAmount handles bare number', () => {
	if (parseAssetAmount('42.5') !== 42.5) throw new Error('bare number');
});
scenario('parseAssetAmount returns NaN for empty', () => {
	if (!Number.isNaN(parseAssetAmount(''))) throw new Error('empty');
	if (!Number.isNaN(parseAssetAmount(undefined))) throw new Error('undef');
	if (!Number.isNaN(parseAssetAmount(null))) throw new Error('null');
});
scenario('parseAssetAmount returns NaN for garbage', () => {
	if (!Number.isNaN(parseAssetAmount('abc'))) throw new Error('abc');
	if (!Number.isNaN(parseAssetAmount('NaN BLURT'))) throw new Error('NaN BLURT');
});
scenario('parseAssetAmount handles zero amount', () => {
	if (parseAssetAmount('0.000 BLURT') !== 0) throw new Error('zero');
});

// ─── vestsToBlurtPower ──────────────────────────────────────────────

scenario('vestsToBlurtPower with realistic pool ratio', () => {
	// Realistic Blurt-mainnet ratio (approx): pool ~5M BLURT,
	// total vests ~3.5e10 → 1 VESTS ≈ 1.43e-4 BLURT.
	// 7000 VESTS ≈ 1 BLURT POWER.
	const bp = vestsToBlurtPower(
		'7000.000000 VESTS',
		'5000000.000 BLURT',
		'35000000000.000000 VESTS'
	);
	const expected = (7000 * 5_000_000) / 35_000_000_000;
	if (Math.abs(bp - expected) > 1e-9) {
		throw new Error(`bp=${bp}, expected=${expected}`);
	}
});

scenario('vestsToBlurtPower returns NaN on degenerate pool', () => {
	const bp = vestsToBlurtPower('1000.000000 VESTS', '100.000 BLURT', '0.000000 VESTS');
	if (!Number.isNaN(bp)) throw new Error('zero pool should be NaN');
});

scenario('vestsToBlurtPower handles zero VESTS', () => {
	const bp = vestsToBlurtPower('0.000000 VESTS', '5000000.000 BLURT', '35000000000.000000 VESTS');
	if (bp !== 0) throw new Error(`zero vests should be 0, got ${bp}`);
});

scenario('vestsToBlurtPower returns NaN on malformed input', () => {
	if (!Number.isNaN(vestsToBlurtPower('abc', '1000 BLURT', '1000 VESTS'))) {
		throw new Error('malformed vests');
	}
});

// ─── votingPowerPercent (legacy voting_power + last_vote_time) ───────
// Matches the "Voting" % classic Blurt explorers (blocks.blurtwallet.com)
// show: regenerate the 0–10000 voting_power counter from last_vote_time.

/** UTC seconds → the no-"Z" timestamp string Blurt's RPC returns. */
const blurtTime = (sec: number): string =>
	new Date(sec * 1000).toISOString().replace('Z', '');
const NOW = 1_700_000_000;

scenario('votingPowerPercent: 9646 just-voted → 96.46% (the supergirl case)', () => {
	const pct = votingPowerPercent(9646, blurtTime(NOW), NOW);
	if (Math.abs(pct - 96.46) > 1e-9) throw new Error(`expected 96.46, got ${pct}`);
});

scenario('votingPowerPercent: 10000 → 100%', () => {
	const pct = votingPowerPercent(10_000, blurtTime(NOW), NOW);
	if (Math.abs(pct - 100) > 1e-9) throw new Error(`expected 100, got ${pct}`);
});

scenario('votingPowerPercent: 0 just-voted → 0%', () => {
	const pct = votingPowerPercent(0, blurtTime(NOW), NOW);
	if (pct !== 0) throw new Error(`expected 0, got ${pct}`);
});

scenario('votingPowerPercent: half-regen from 0 → ~50%', () => {
	const half = VOTE_POWER_REGEN_SECONDS / 2; // 2.5 days
	const pct = votingPowerPercent(0, blurtTime(NOW - half), NOW);
	if (Math.abs(pct - 50) > 1e-9) throw new Error(`expected 50, got ${pct}`);
});

scenario('votingPowerPercent: caps at 100% for over-regen', () => {
	// voted 10 days ago starting at 50% → would regen past 100% → capped.
	const pct = votingPowerPercent(5000, blurtTime(NOW - 10 * 86_400), NOW);
	if (Math.abs(pct - 100) > 1e-9) throw new Error(`expected 100, got ${pct}`);
});

scenario('votingPowerPercent: trailing "Z" is optional (UTC either way)', () => {
	const withZ = votingPowerPercent(9646, `${blurtTime(NOW)}Z`, NOW);
	const without = votingPowerPercent(9646, blurtTime(NOW), NOW);
	if (Math.abs(withZ - without) > 1e-9) throw new Error(`Z mismatch: ${withZ} vs ${without}`);
	if (Math.abs(withZ - 96.46) > 1e-9) throw new Error(`expected 96.46, got ${withZ}`);
});

scenario('votingPowerPercent: clock skew (now before last vote) → no negative regen', () => {
	const pct = votingPowerPercent(9646, blurtTime(NOW + 100), NOW);
	if (Math.abs(pct - 96.46) > 1e-9) throw new Error(`expected 96.46, got ${pct}`);
});

scenario('votingPowerPercent: NaN for missing/bad inputs', () => {
	if (!Number.isNaN(votingPowerPercent(null, blurtTime(NOW), NOW))) throw new Error('null vp');
	if (!Number.isNaN(votingPowerPercent(9646, null, NOW))) throw new Error('null time');
	if (!Number.isNaN(votingPowerPercent(9646, 'not-a-date', NOW))) throw new Error('bad time');
	if (!Number.isNaN(votingPowerPercent(9646, blurtTime(NOW), NaN))) throw new Error('bad now');
});

// ─── formatBalance ──────────────────────────────────────────────────

scenario('formatBalance trims trailing zeros', () => {
	if (formatBalance(42) !== '42') throw new Error('integer');
	if (formatBalance(42.5) !== '42.5') throw new Error('one decimal');
	if (formatBalance(42.123) !== '42.123') throw new Error('three decimals');
	if (formatBalance(42.12345) !== '42.123') throw new Error('rounds to 3');
});

scenario('formatBalance handles zero', () => {
	if (formatBalance(0) !== '0') throw new Error(`got '${formatBalance(0)}'`);
});

scenario('formatBalance returns em-dash for NaN', () => {
	if (formatBalance(NaN) !== '—') throw new Error('NaN');
	if (formatBalance(Infinity) !== '—') throw new Error('Infinity');
});

scenario('formatPercentage two decimal places', () => {
	if (formatPercentage(50) !== '50.00%') throw new Error('50');
	if (formatPercentage(92.45) !== '92.45%') throw new Error('92.45');
	if (formatPercentage(96.46) !== '96.46%') throw new Error('96.46');
	if (formatPercentage(0) !== '0.00%') throw new Error('0');
});

scenario('formatPercentage NaN returns em-dash', () => {
	if (formatPercentage(NaN) !== '—') throw new Error('NaN');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
