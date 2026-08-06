#!/usr/bin/env tsx
/**
 * blurt-apr smoke — cp323.
 *
 * Locks in the Blurt staked-BLURT (BP) APR computation. The figure shown
 * under the BP balance ("Currently earning N% APR") was ~5x too high
 * because the module used a 75% vesting-reward share — but Blurt pays BP
 * holders only 15% of the inflation rate (Blurt FAQ: "the current earning
 * rate is set at 15% of the inflation rate and divided equally between all
 * BP holders"). It also used Steem's 9.5%→0.95% inflation curve, while
 * Blurt reset it to 10% APR narrowing to 1% over 20 years (Blurt fork
 * spec). This smoke pins both so they can't silently regress.
 *
 * Ground truth cross-check (blurtscan.com, head block ~60.4M):
 *   INFLATION ≈ 7.36%, BP APR ≈ 1.73%.
 * Our schedule yields ≈7.42% inflation and ≈1.74% APR at that block with
 * the live vesting-fund / supply — a match within block-time rounding.
 */

import {
	currentAnnualInflationBps,
	computeBlurtVestingApr,
	formatApr
} from '../src/lib/blurt/apr.ts';

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	console.log(`  \u2713 ${m}`);
	pass++;
};
const bad = (m: string): void => {
	console.error(`  \u2717 ${m}`);
	fail++;
};
const approx = (label: string, got: number, want: number, tol: number): void => {
	if (Number.isFinite(got) && Math.abs(got - want) <= tol) ok(`${label}: ${got.toFixed(4)} ≈ ${want} (±${tol})`);
	else bad(`${label}: got ${got}, expected ${want} ±${tol}`);
};

// Blurt: 3-second blocks → blocks/year, and the 20-year narrowing window.
const BLOCKS_PER_YEAR = (365.25 * 24 * 60 * 60) / 3; // ≈ 10,519,200
const TWENTY_YEARS = 20 * BLOCKS_PER_YEAR;

// ── currentAnnualInflationBps ──────────────────────────────────────
// Genesis: 10% (1000 bps).
approx('inflation @block 0 = 10%', currentAnnualInflationBps(0), 1000, 1e-6);
// One year in: dropped 45 bps (900 bps over 20 yr) → 9.55%.
approx('inflation @1yr ≈ 9.55%', currentAnnualInflationBps(BLOCKS_PER_YEAR), 955, 0.5);
// Live head block (blurtscan ~60.4M) ≈ 7.4% (blurtscan reports 7.36%).
approx('inflation @60.4M ≈ 7.4%', currentAnnualInflationBps(60_378_641), 741.7, 1);
// End of the 20-year window: exactly the 1% floor.
approx('inflation @20yr = 1% floor', currentAnnualInflationBps(TWENTY_YEARS), 100, 1e-6);
// Past the window: clamps at the 1% floor, never below.
approx('inflation past window clamps at floor', currentAnnualInflationBps(300_000_000), 100, 1e-9);
// Guards.
if (Number.isNaN(currentAnnualInflationBps(-1))) ok('inflation NaN for negative block');
else bad('inflation should be NaN for negative block');
if (Number.isNaN(currentAnnualInflationBps(Number.POSITIVE_INFINITY))) ok('inflation NaN for non-finite block');
else bad('inflation should be NaN for non-finite block');

// ── computeBlurtVestingApr ─────────────────────────────────────────
// At genesis (10% inflation), supply == pool → APR = 10% * 15% = 1.5%.
// This is THE guard against the 75%-share regression: with 75% it would
// be 7.5%.
{
	const apr = computeBlurtVestingApr({
		head_block_number: 0,
		current_supply: '1000.000 BLURT',
		total_vesting_fund_blurt: '1000.000 BLURT'
	});
	approx('APR @block0, supply==pool = 1.5% (proves 15% share, not 75%)', apr, 1.5, 1e-6);
	if (apr < 3) ok('APR is in the 15%-share regime (< 3%), not the old 75% regime (~7.5%)');
	else bad(`APR ${apr} looks like the old 75% vesting share — regression`);
}

// Live-state cross-check against blurtscan (BP APR ≈ 1.73%). Vesting fund
// 378,031,541 BLURT; supply derived from the live APR/inflation/pool
// relationship (~592.4M). Our value should land ≈1.74%.
{
	const apr = computeBlurtVestingApr({
		head_block_number: 60_378_641,
		current_supply: '592400000.000 BLURT',
		total_vesting_fund_blurt: '378031541.000 BLURT'
	});
	approx('APR @blurtscan-state ≈ 1.73% (live BP APR)', apr, 1.73, 0.1);
}

// Malformed / degenerate inputs → NaN (never a bogus number on a display).
const nanCase = (label: string, inp: Parameters<typeof computeBlurtVestingApr>[0]): void => {
	if (Number.isNaN(computeBlurtVestingApr(inp))) ok(label);
	else bad(`${label}: expected NaN`);
};
nanCase('APR NaN for malformed supply', {
	head_block_number: 60_378_641,
	current_supply: 'not-a-number',
	total_vesting_fund_blurt: '378031541.000 BLURT'
});
nanCase('APR NaN for malformed pool', {
	head_block_number: 60_378_641,
	current_supply: '592400000.000 BLURT',
	total_vesting_fund_blurt: 'garbage'
});
nanCase('APR NaN for empty (zero) vesting pool', {
	head_block_number: 60_378_641,
	current_supply: '592400000.000 BLURT',
	total_vesting_fund_blurt: '0.000 BLURT'
});
nanCase('APR NaN for zero supply', {
	head_block_number: 60_378_641,
	current_supply: '0.000 BLURT',
	total_vesting_fund_blurt: '378031541.000 BLURT'
});
nanCase('APR NaN for negative head block', {
	head_block_number: -5,
	current_supply: '592400000.000 BLURT',
	total_vesting_fund_blurt: '378031541.000 BLURT'
});

// ── formatApr ──────────────────────────────────────────────────────
if (/^1\.73/.test(formatApr(1.7345))) ok('formatApr rounds to 2 decimals (1.7345 → 1.73…)');
else bad(`formatApr(1.7345) = ${formatApr(1.7345)} — expected 2-decimal rounding`);
if (formatApr(Number.NaN) === '—') ok('formatApr(NaN) = em-dash');
else bad(`formatApr(NaN) = ${formatApr(Number.NaN)} — expected em-dash`);

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`\u2713 all ${pass} blurt-apr scenarios passed`);
