/**
 * Morphit smoke — Blurt balance math (VESTS→BP, MANA regen).
 *
 * Pure deterministic helpers; verifies the standard Steem-family
 * formulas against known reference values.
 */

import {
	parseAssetAmount,
	vestsToBlurtPower,
	manaPercentage,
	formatBalance,
	formatPercentage,
	MANA_REGEN_SECONDS,
	type VotingManabar
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

// ─── manaPercentage ─────────────────────────────────────────────────

scenario('manaPercentage at 100% when current == max', () => {
	const manabar: VotingManabar = {
		current_mana: '1000000000',
		last_update_time: 1_700_000_000
	};
	// current_mana is compared on the SAME scale as the parsed vesting
	// amount (the chain reports both in VESTS-base units); this fixture
	// uses artificial magnitudes, so just assert the result is finite —
	// exact-value checks are below. No delegation → effective == owned.
	const pct = manaPercentage(manabar, '1000.000000 VESTS', '0.000000 VESTS', '0.000000 VESTS', 1_700_000_000);
	if (Number.isNaN(pct)) throw new Error('got NaN');
});

scenario('manaPercentage at 100% with consistent scale', () => {
	// Use raw numbers (no symbol) for vesting_shares to align with
	// current_mana scale.  Real chain values use VESTS suffix; the
	// math is identical.  No delegation → effective == owned.
	const manabar: VotingManabar = {
		current_mana: '1000000000',
		last_update_time: 1_700_000_000
	};
	const pct = manaPercentage(manabar, '1000000000', '0', '0', 1_700_000_000);
	if (Math.abs(pct - 100) > 1e-9) throw new Error(`expected 100, got ${pct}`);
});

scenario('manaPercentage at 50% half-elapsed regen from zero', () => {
	const manabar: VotingManabar = {
		current_mana: '0',
		last_update_time: 1_700_000_000
	};
	const halfRegen = MANA_REGEN_SECONDS / 2;
	const pct = manaPercentage(manabar, '1000000000', '0', '0', 1_700_000_000 + halfRegen);
	if (Math.abs(pct - 50) > 0.01) throw new Error(`expected ~50, got ${pct}`);
});

scenario('manaPercentage caps at 100% for over-regen', () => {
	const manabar: VotingManabar = {
		current_mana: '500000000',
		last_update_time: 1_700_000_000
	};
	// Wait 10 days = 2x regen cycle; should cap at 100%.
	const pct = manaPercentage(manabar, '1000000000', '0', '0', 1_700_000_000 + 10 * 86_400);
	if (Math.abs(pct - 100) > 1e-9) throw new Error(`expected 100, got ${pct}`);
});

scenario('manaPercentage returns 0 for zero-vesting account', () => {
	const manabar: VotingManabar = {
		current_mana: '0',
		last_update_time: 1_700_000_000
	};
	const pct = manaPercentage(manabar, '0.000000 VESTS', '0.000000 VESTS', '0.000000 VESTS', 1_700_000_000 + 1000);
	if (pct !== 0) throw new Error(`expected 0, got ${pct}`);
});

scenario('manaPercentage returns NaN for missing manabar', () => {
	if (!Number.isNaN(manaPercentage(null, '1000 VESTS', '0', '0', 1_700_000_000))) {
		throw new Error('null');
	}
	if (!Number.isNaN(manaPercentage(undefined, '1000 VESTS', '0', '0', 1_700_000_000))) {
		throw new Error('undef');
	}
});

scenario('manaPercentage returns NaN for bogus current_mana', () => {
	const bad = { current_mana: 'abc', last_update_time: 1_700_000_000 } as VotingManabar;
	if (!Number.isNaN(manaPercentage(bad, '1000', '0', '0', 1_700_000_000))) {
		throw new Error('bogus');
	}
});

scenario('manaPercentage handles past last_update_time without negative regen', () => {
	const manabar: VotingManabar = {
		current_mana: '1000000000',
		last_update_time: 1_700_000_000
	};
	// nowSeconds BEFORE last_update_time — clock skew.  Should
	// not subtract; clamp at current_mana.
	const pct = manaPercentage(manabar, '1000000000', '0', '0', 1_700_000_000 - 100);
	if (Math.abs(pct - 100) > 1e-9) throw new Error(`expected 100, got ${pct}`);
});

// ── Effective-vesting ceiling (own + received − delegated) ──────────
// The manabar max is EFFECTIVE vesting, not owned (cp322 fix). An
// account that delegates BP out reads HIGHER than the owned-only
// figure; one that receives delegation reads LOWER.

scenario('manaPercentage: delegating BP out raises the % (effective < owned)', () => {
	const manabar: VotingManabar = {
		current_mana: '250000000',
		last_update_time: 1_700_000_000
	};
	// own 1e9, delegated-out 5e8 → effective 5e8. current 2.5e8.
	// effective: 2.5e8 / 5e8 = 50%.  (Owned-only would read 25%.)
	const pct = manaPercentage(manabar, '1000000000', '0', '500000000', 1_700_000_000);
	if (Math.abs(pct - 50) > 1e-9) throw new Error(`expected 50 (effective), got ${pct}`);
});

scenario('manaPercentage: received delegation lowers the % (effective > owned)', () => {
	const manabar: VotingManabar = {
		current_mana: '1000000000',
		last_update_time: 1_700_000_000
	};
	// own 1e9, received 1e9 → effective 2e9. current 1e9.
	// effective: 1e9 / 2e9 = 50%.  (Owned-only would read 100%.)
	const pct = manaPercentage(manabar, '1000000000', '1000000000', '0', 1_700_000_000);
	if (Math.abs(pct - 50) > 1e-9) throw new Error(`expected 50 (effective), got ${pct}`);
});

scenario('manaPercentage returns 0 when fully delegated out (effective <= 0)', () => {
	const manabar: VotingManabar = {
		current_mana: '1000000000',
		last_update_time: 1_700_000_000
	};
	// delegated-out exceeds own+received → effective <= 0 → 0%.
	const pct = manaPercentage(manabar, '1000000000', '0', '1500000000', 1_700_000_000);
	if (pct !== 0) throw new Error(`expected 0, got ${pct}`);
});

scenario('manaPercentage degrades malformed received/delegated to 0 (ceiling = owned)', () => {
	const manabar: VotingManabar = {
		current_mana: '1000000000',
		last_update_time: 1_700_000_000
	};
	// Garbage received/delegated must not poison the result — they fall
	// back to 0, so the ceiling is owned vesting (1e9) → 100%.
	const pct = manaPercentage(manabar, '1000000000', 'garbage', 'also-bad', 1_700_000_000);
	if (Math.abs(pct - 100) > 1e-9) throw new Error(`expected 100 (degraded), got ${pct}`);
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

scenario('formatPercentage one decimal place', () => {
	if (formatPercentage(50) !== '50.0%') throw new Error('50');
	if (formatPercentage(92.45) !== '92.5%') throw new Error('92.45');
	if (formatPercentage(0) !== '0.0%') throw new Error('0');
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
