/**
 * Morphit — Blurt vesting APR computation.
 *
 * Pure: takes a DGP-shaped object plus the chain's head-block
 * number, returns the current APR for staked BLURT (BP) as a
 * percentage (e.g. 8.32 means 8.32% per year).
 *
 * Blurt's inflation curve mirrors Steem-family chains:
 *
 *   • Inflation starts at ~9.5% annually.
 *   • Decreases by 0.01% (one basis point) every ~250,000 blocks
 *     (roughly one year given Blurt's 3-second block time).
 *   • Floors at ~0.95%.
 *
 * Of the total annual inflation, a fixed share is paid to vesting-
 * stake holders pro-rata.  The remainder goes to content rewards
 * and witness rewards.  Blurt's split per chain config:
 *
 *   • Vesting share of inflation: 75%
 *
 * (Content rewards = 15%, witnesses = 10%.  These percentages are
 * effectively constants in Blurt's mainnet config.)
 *
 * The APR for one unit of staked BLURT is therefore:
 *
 *   annual_blurt_minted = current_supply * annual_inflation_rate
 *   annual_to_vesters   = annual_blurt_minted * vesting_share
 *   apr_per_bp          = annual_to_vesters / total_vesting_fund_blurt
 *
 * We compute and return as a percentage, NOT a fraction.
 *
 * Caveats:
 *
 *   - Chain-config constants (vesting share %, decay rate, floor)
 *     are baked in here.  A future chain hardfork that changes
 *     these would silently produce wrong APR until this module
 *     updates.  The constants are commented above; review them
 *     against the chain config at deploy time.
 *
 *   - The block-time math uses 3 seconds exactly.  Real Blurt
 *     blocks vary slightly (network conditions); this is the
 *     intended schedule.
 *
 *   - We don't account for compounding within the year.  The
 *     chain's vesting rewards are continuous and could be
 *     compounded for a slightly higher effective yield, but the
 *     simple-interest figure is what users typically expect to
 *     see on stake displays.
 *
 * Returns NaN on malformed inputs (bad string-amounts, divide-by-
 * zero on empty pool).
 */

import { parseAssetAmount } from './balanceMath';
import { formatPercent } from '../i18n/formatters';

/** Inflation curve constants — keep in sync with Blurt chain config. */

/** Starting annual inflation rate (basis points).  9.5%. */
const INFLATION_START_BPS = 950;

/** Rate at which inflation decreases per BLOCK, in
 *  micro-basis-points (bps × 1e-6).  Blurt schedule: 1 bp per
 *  ~250,000 blocks, or 4 micro-bps per block. */
const INFLATION_DECAY_PER_BLOCK_MICRO_BPS = 4;

/** Floor on inflation rate (basis points).  0.95%. */
const INFLATION_FLOOR_BPS = 95;

/** Block at which the inflation decay schedule began.  Blurt
 *  mainnet inherited Steem's schedule; the curve is anchored at
 *  block 0 for our purposes (the per-block decay accumulates
 *  over the chain's life). */
const INFLATION_NARROWING_BASELINE_BLOCK = 0;

/** Vesting share of total inflation (basis points).  75%.
 *  Configured by Blurt's chain at hardfork; constant for our
 *  purposes. */
const VESTING_REWARD_SHARE_BPS = 7500;

/** Compute the chain's annual inflation rate, in basis points,
 *  given a current head-block number.
 *
 *  The schedule is monotonically decreasing from
 *  INFLATION_START_BPS toward INFLATION_FLOOR_BPS.  We track in
 *  micro-basis-points internally to avoid integer-division
 *  truncation, then convert back to bps for the return.
 *
 *  Pure; smoke-testable. */
export function currentAnnualInflationBps(headBlockNumber: number): number {
	if (!Number.isFinite(headBlockNumber) || headBlockNumber < 0) return NaN;
	const startMicroBps = INFLATION_START_BPS * 1_000_000;
	const decayMicroBps =
		Math.max(0, headBlockNumber - INFLATION_NARROWING_BASELINE_BLOCK) *
		INFLATION_DECAY_PER_BLOCK_MICRO_BPS;
	const currentMicroBps = Math.max(INFLATION_FLOOR_BPS * 1_000_000, startMicroBps - decayMicroBps);
	return currentMicroBps / 1_000_000;
}

/** Inputs the APR formula needs.  Mirrors the relevant slice of
 *  the chain's DynamicGlobalProperties.  Strings are in the chain's
 *  asset-string format ("123.456 BLURT" / "123.456 VESTS"). */
export interface AprInputs {
	readonly head_block_number: number;
	readonly current_supply: string;
	readonly total_vesting_fund_blurt: string;
}

/** Compute the simple annual percentage rate (APR) earned by
 *  staked BLURT (Blurt Power) as of the given chain state.
 *
 *  Returns the APR as a percentage (e.g. 7.5 for 7.5%/yr) or NaN
 *  on malformed inputs.  See module-level doc for the formula and
 *  caveats. */
export function computeBlurtVestingApr(inputs: AprInputs): number {
	const inflationBps = currentAnnualInflationBps(inputs.head_block_number);
	if (!Number.isFinite(inflationBps)) return NaN;
	const supply = parseAssetAmount(inputs.current_supply);
	const pool = parseAssetAmount(inputs.total_vesting_fund_blurt);
	if (!Number.isFinite(supply) || !Number.isFinite(pool)) return NaN;
	if (supply <= 0 || pool <= 0) return NaN;

	const annualMintedBlurt = (supply * inflationBps) / 10_000;
	const annualToVesters = (annualMintedBlurt * VESTING_REWARD_SHARE_BPS) / 10_000;
	const aprFraction = annualToVesters / pool;
	return aprFraction * 100;
}

/** Format an APR for display: "7.50%".  Two decimal places.
 *  Locale-aware via formatPercent.  Returns "—" for NaN. */
export function formatApr(apr: number): string {
	if (!Number.isFinite(apr)) return '—';
	return formatPercent(apr, 2);
}
