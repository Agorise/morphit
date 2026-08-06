/**
 * Morphit — Blurt vesting APR computation.
 *
 * Pure: takes a DGP-shaped object plus the chain's head-block
 * number, returns the current APR for staked BLURT (BP) as a
 * percentage (e.g. 1.73 means 1.73% per year).
 *
 * Blurt reset the Steem-family curve at its 2020 genesis:
 *
 *   • Inflation starts at 10% annually (at block 0).
 *   • Narrows LINEARLY to 1% annually over 20 years.
 *   • Floors at 1% thereafter.
 *
 *   (Source: Blurt fork spec — "Reset inflation to 10% APR inflation
 *   narrowing to 1% APR over 20 years.")
 *
 * Of the total annual inflation, a fixed share is paid to vesting-
 * stake (Blurt Power) holders pro-rata.  The remainder funds author/
 * curation rewards and witnesses.  Blurt's split:
 *
 *   • Vesting (BP) share of inflation: 15%
 *
 * (Source: Blurt FAQ — "The current earning rate is set at 15% of the
 * inflation rate and divided equally between all BP holders."  The
 * other ~85% funds content rewards + witnesses.)  Sanity check: at
 * head block ~60.4M this yields BP APR ≈ 1.7%, matching the live
 * figure on Blurt block explorers.
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

/** Starting annual inflation rate (basis points). 10% at genesis. */
const INFLATION_START_BPS = 1000;

/** Floor on the annual inflation rate (basis points). 1%. */
const INFLATION_FLOOR_BPS = 100;

/** Blurt blocks are 3 seconds. */
const SECONDS_PER_BLOCK = 3;
const BLOCKS_PER_YEAR = (365.25 * 24 * 60 * 60) / SECONDS_PER_BLOCK; // ≈ 10.52M

/** Years over which inflation narrows linearly from START to FLOOR. */
const INFLATION_NARROWING_YEARS = 20;

/** Per-block reduction in the annual inflation rate (basis points), so
 *  the rate falls from INFLATION_START_BPS to INFLATION_FLOOR_BPS across
 *  exactly INFLATION_NARROWING_YEARS, anchored at block 0. */
const INFLATION_DECAY_PER_BLOCK_BPS =
	(INFLATION_START_BPS - INFLATION_FLOOR_BPS) / (INFLATION_NARROWING_YEARS * BLOCKS_PER_YEAR);

/** Vesting (Blurt Power) share of total inflation (basis points). Blurt
 *  pays BP holders 15% of the inflation rate, divided pro-rata across
 *  all BP (Blurt FAQ). The other ~85% funds author/curation rewards and
 *  witnesses. A future hardfork that changes this would silently skew
 *  the APR until this constant is updated. */
const VESTING_REWARD_SHARE_BPS = 1500;

/** Compute the chain's annual inflation rate, in basis points, given a
 *  current head-block number.
 *
 *  Monotonically decreasing from INFLATION_START_BPS toward
 *  INFLATION_FLOOR_BPS along Blurt's documented 10%→1%-over-20-years
 *  schedule, then flat at the floor.
 *
 *  Pure; smoke-testable. */
export function currentAnnualInflationBps(headBlockNumber: number): number {
	if (!Number.isFinite(headBlockNumber) || headBlockNumber < 0) return NaN;
	const decayed = INFLATION_START_BPS - headBlockNumber * INFLATION_DECAY_PER_BLOCK_BPS;
	return Math.max(INFLATION_FLOOR_BPS, decayed);
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
