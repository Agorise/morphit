/**
 * Morphit smoke — Blurt APR computation (Batch K).
 *
 * Pure deterministic helpers.  Verifies the inflation decay
 * schedule, the APR formula, and the formatter.
 */

import {
	currentAnnualInflationBps,
	computeBlurtVestingApr,
	formatApr
} from '../../web/src/lib/blurt/apr';

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

console.log('\n── apr smoke ─────────────────────────────────────────────\n');

// ─── currentAnnualInflationBps ──────────────────────────────────────

scenario('inflation at block 0 = 950 bps (9.5%)', () => {
	const bps = currentAnnualInflationBps(0);
	if (Math.abs(bps - 950) > 1e-9) throw new Error(`got ${bps}`);
});

scenario('inflation decays linearly per block', () => {
	// 250_000 blocks = 1 basis point of decay
	const bps = currentAnnualInflationBps(250_000);
	if (Math.abs(bps - 949) > 1e-9) throw new Error(`got ${bps}`);
});

scenario('inflation at 1M blocks = 950 - 4 = 946 bps', () => {
	const bps = currentAnnualInflationBps(1_000_000);
	if (Math.abs(bps - 946) > 1e-9) throw new Error(`got ${bps}`);
});

scenario('inflation floors at 95 bps (0.95%)', () => {
	// 950 - 95 = 855 bps decay.  At 4 micro-bps/block,
	// that's 855 * 1_000_000 / 4 = 213_750_000 blocks to reach.
	// Anything beyond should clamp at floor.
	const bps = currentAnnualInflationBps(500_000_000);
	if (Math.abs(bps - 95) > 1e-9) throw new Error(`got ${bps}`);
});

scenario('inflation negative head block returns NaN', () => {
	const bps = currentAnnualInflationBps(-1);
	if (!Number.isNaN(bps)) throw new Error('expected NaN');
});

scenario('inflation NaN head block returns NaN', () => {
	const bps = currentAnnualInflationBps(NaN);
	if (!Number.isNaN(bps)) throw new Error('expected NaN');
});

// ─── computeBlurtVestingApr ─────────────────────────────────────────

scenario('APR with realistic mainnet-shaped numbers', () => {
	// Realistic Blurt mainnet (approx Q3 2024):
	//   current_supply ~ 26 million BLURT
	//   total_vesting_fund_blurt ~ 5 million BLURT
	//   head_block ~ 50_000_000
	//
	// Inflation at block 50M: 950 - (50M * 4 / 1M) = 950 - 200 = 750 bps = 7.5%
	// Annual mint: 26M * 7.5% = 1.95M BLURT
	// To vesters: 1.95M * 75% = 1.4625M BLURT
	// APR per BP: 1.4625M / 5M = 29.25% (high because pool is small)
	const apr = computeBlurtVestingApr({
		head_block_number: 50_000_000,
		current_supply: '26000000.000 BLURT',
		total_vesting_fund_blurt: '5000000.000 BLURT'
	});
	const expected = 29.25;
	if (Math.abs(apr - expected) > 0.01) {
		throw new Error(`expected ~${expected}, got ${apr}`);
	}
});

scenario('APR with empty vesting pool returns NaN', () => {
	const apr = computeBlurtVestingApr({
		head_block_number: 1_000_000,
		current_supply: '1000000.000 BLURT',
		total_vesting_fund_blurt: '0.000 BLURT'
	});
	if (!Number.isNaN(apr)) throw new Error('expected NaN');
});

scenario('APR with malformed supply returns NaN', () => {
	const apr = computeBlurtVestingApr({
		head_block_number: 1_000_000,
		current_supply: 'abc',
		total_vesting_fund_blurt: '5000000.000 BLURT'
	});
	if (!Number.isNaN(apr)) throw new Error('expected NaN');
});

scenario('APR scales inversely with vesting pool size', () => {
	const small = computeBlurtVestingApr({
		head_block_number: 1_000_000,
		current_supply: '10000000.000 BLURT',
		total_vesting_fund_blurt: '1000000.000 BLURT'
	});
	const large = computeBlurtVestingApr({
		head_block_number: 1_000_000,
		current_supply: '10000000.000 BLURT',
		total_vesting_fund_blurt: '10000000.000 BLURT'
	});
	if (small <= large) throw new Error('expected smaller pool to give higher APR');
	// Small / large should be exactly 10 (pool ratio).
	if (Math.abs(small / large - 10) > 1e-6) throw new Error(`ratio=${small / large}`);
});

scenario('APR scales linearly with inflation rate', () => {
	// Same supply / pool, different head blocks → different inflation
	const aprAtBlockZero = computeBlurtVestingApr({
		head_block_number: 0,
		current_supply: '10000000.000 BLURT',
		total_vesting_fund_blurt: '1000000.000 BLURT'
	});
	const aprAtFloor = computeBlurtVestingApr({
		head_block_number: 500_000_000,
		current_supply: '10000000.000 BLURT',
		total_vesting_fund_blurt: '1000000.000 BLURT'
	});
	// Block 0: inflation 950 bps; floor: 95 bps.  Ratio 10x.
	if (Math.abs(aprAtBlockZero / aprAtFloor - 10) > 1e-6) {
		throw new Error(`ratio=${aprAtBlockZero / aprAtFloor}`);
	}
});

// ─── formatApr ──────────────────────────────────────────────────────

scenario('formatApr two decimals', () => {
	if (formatApr(7.5) !== '7.50%') throw new Error(formatApr(7.5));
	if (formatApr(0.123) !== '0.12%') throw new Error(formatApr(0.123));
	if (formatApr(100) !== '100.00%') throw new Error(formatApr(100));
});

scenario('formatApr NaN renders em-dash', () => {
	if (formatApr(NaN) !== '—') throw new Error('NaN');
	if (formatApr(Infinity) !== '—') throw new Error('Infinity');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
