/**
 * Morphit — Blurt balance math.
 *
 * Pure, deterministic helpers for two chain quantities that need
 * client-side computation:
 *
 *   1. VESTS → BLURT POWER (BP) conversion.  Blurt stores "powered up"
 *      stake as VESTS, a unit whose conversion rate to BLURT drifts
 *      slowly as the global pool inflates.  The current rate is in
 *      DynamicGlobalProperties: `total_vesting_fund_blurt /
 *      total_vesting_shares`.
 *
 *   2. MANA REGEN.  Blurt's voting_manabar is a regenerating resource
 *      with a 5-day full-charge cycle (432_000 seconds).  The chain
 *      stores `current_mana` as of `last_update_time`; clients compute
 *      the present-time mana by adding linear regen since then,
 *      capped at the user's max mana (which is their effective vesting
 *      shares).
 *
 * Both functions take strings as they appear on chain (e.g.
 * `"42.123 BLURT"`) or numeric strings (VESTS, mana amounts) and
 * return numbers in user-friendly units.  Pure — no I/O, no DOM,
 * smoke-testable.
 *
 * References:
 *   - Steem-family voting mana regen: https://github.com/steemit/condenser
 *     (the formula has been stable across Steem/Hive/Blurt forks).
 *   - VESTS / BLURT conversion: standard Graphene-chain math.
 */

import { formatPercent } from '../i18n/formatters';

/** Seconds for fully-depleted voting power to regenerate to 100%
 *  (Blurt inherits Steem's 5-day vote-power regen). */
export const VOTE_POWER_REGEN_SECONDS = 432_000;

/** Parse a "42.123 BLURT" or "42.123 VESTS" amount string into a
 *  plain number.  Returns NaN if the format is bogus.  Caller decides
 *  how to handle NaN — typically display "—" rather than show a
 *  misleading 0. */
export function parseAssetAmount(s: string | undefined | null): number {
	if (typeof s !== 'string') return NaN;
	const t = s.trim();
	if (t.length === 0) return NaN;
	// Standard format: "<number> <symbol>".  Take everything before
	// the first space.
	const space = t.indexOf(' ');
	const num = space === -1 ? t : t.slice(0, space);
	const v = Number(num);
	return Number.isFinite(v) ? v : NaN;
}

/** Convert a VESTS amount to BLURT POWER given the current global
 *  vesting pool ratio from DynamicGlobalProperties.
 *
 *  The conversion rate is `total_vesting_fund_blurt /
 *  total_vesting_shares`.  E.g. if the pool has 1_000_000 BLURT
 *  staked across 100_000_000 VESTS, then 1 VESTS = 0.01 BLURT (so
 *  1000 VESTS = 10 BLURT POWER).
 *
 *  Returns BLURT POWER as a number.  Returns NaN if any input is
 *  malformed or the pool is degenerate (zero vesting shares — would
 *  divide by zero).
 *
 *  Note: this is the LIVE conversion at the moment of fetch.  The
 *  rate drifts with each block, so the BP value displayed to the
 *  user is precise as of the fetch time and approximate seconds
 *  later.  For UI display this drift is negligible; for any
 *  fund-affecting calculation, fetch fresh DGP. */
export function vestsToBlurtPower(
	vestsStr: string,
	totalVestingFundBlurtStr: string,
	totalVestingSharesStr: string
): number {
	const vests = parseAssetAmount(vestsStr);
	const fund = parseAssetAmount(totalVestingFundBlurtStr);
	const totalVests = parseAssetAmount(totalVestingSharesStr);
	if (!Number.isFinite(vests) || !Number.isFinite(fund) || !Number.isFinite(totalVests)) {
		return NaN;
	}
	if (totalVests <= 0) return NaN;
	return (vests * fund) / totalVests;
}

/** Reverse of `vestsToBlurtPower`: convert a BLURT POWER (BP) figure
 *  back to VESTS given the current global pool ratio. Power-DOWN uses
 *  it — `withdraw_vesting` takes VESTS, but the user enters BP.
 *
 *    vests = (bp * total_vesting_shares) / total_vesting_fund_blurt
 *
 *  Returns NaN on malformed input or a degenerate pool (zero fund).
 *  ALWAYS convert against FRESHLY-fetched DGP for a fund-moving op — the
 *  rate drifts each block. For "power down everything", prefer the
 *  account's EXACT on-chain `vesting_shares` string over a BP→VESTS
 *  round-trip (avoids leaving sub-VESTS dust). */
export function blurtPowerToVests(
	bp: number,
	totalVestingFundBlurtStr: string,
	totalVestingSharesStr: string
): number {
	const fund = parseAssetAmount(totalVestingFundBlurtStr);
	const totalVests = parseAssetAmount(totalVestingSharesStr);
	if (!Number.isFinite(bp) || !Number.isFinite(fund) || !Number.isFinite(totalVests)) {
		return NaN;
	}
	if (fund <= 0) return NaN;
	return (bp * totalVests) / fund;
}

/** Format a BLURT quantity as the EXACT 3-decimal chain-asset string
 *  `"N.NNN BLURT"` that `transfer` / `transfer_to_vesting` require.
 *  Distinct from `formatBalance` (which strips trailing zeros for
 *  DISPLAY): the chain needs exactly 3 decimals. Throws on a non-finite
 *  or negative amount — a money op must never be built from a bad number
 *  (fail fast rather than emit "NaN BLURT"). */
export function formatBlurtAmount(n: number): string {
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(`formatBlurtAmount: invalid amount ${n}`);
	}
	return `${n.toFixed(3)} BLURT`;
}

/** Format a VESTS quantity as the EXACT 6-decimal chain-asset string
 *  `"N.NNNNNN VESTS"` that `withdraw_vesting` requires. Throws on a
 *  non-finite or negative amount. */
export function formatVestsAmount(n: number): string {
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(`formatVestsAmount: invalid amount ${n}`);
	}
	return `${n.toFixed(6)} VESTS`;
}

/** Compute an account's current voting-power percentage [0..100] from
 *  the legacy `voting_power` (0–10000) + `last_vote_time` fields,
 *  regenerated to `nowSeconds`.  This is the value classic Blurt
 *  explorers (e.g. blocks.blurtwallet.com) display, so Morphit's
 *  "Voting" stat matches the wider ecosystem:
 *
 *    elapsed     = max(0, nowSeconds − last_vote_time)
 *    regenerated = voting_power + 10000 · elapsed / VOTE_POWER_REGEN_SECONDS
 *    current     = min(10000, regenerated)
 *    pct         = current / 100
 *
 *  Blurt returns `last_vote_time` as a UTC timestamp WITHOUT a trailing
 *  "Z", so it is normalized before parsing.  Returns NaN when either
 *  input is missing/malformed (the UI then shows "—"). */
export function votingPowerPercent(
	votingPower: number | undefined | null,
	lastVoteTime: string | undefined | null,
	nowSeconds: number
): number {
	if (typeof votingPower !== 'number' || !Number.isFinite(votingPower)) return NaN;
	if (typeof lastVoteTime !== 'string' || lastVoteTime.length === 0) return NaN;
	if (!Number.isFinite(nowSeconds)) return NaN;
	const iso = lastVoteTime.endsWith('Z') ? lastVoteTime : `${lastVoteTime}Z`;
	const lastMs = Date.parse(iso);
	if (!Number.isFinite(lastMs)) return NaN;
	const elapsed = Math.max(0, nowSeconds - Math.floor(lastMs / 1000));
	const regenerated = votingPower + (10_000 * elapsed) / VOTE_POWER_REGEN_SECONDS;
	const current = Math.min(10_000, regenerated);
	return Math.max(0, Math.min(100, current / 100));
}

/** Format a number with 3 fractional digits, locale-grouped, dropping
 *  trailing zeros so "42.000" displays as "42".  Used for both BLURT
 *  and BP display so all numbers in the balance card have a uniform
 *  style.  Returns "—" for NaN. */
export function formatBalance(n: number): string {
	if (!Number.isFinite(n)) return '—';
	const fixed = n.toFixed(3);
	// Strip trailing zeros and trailing decimal point.
	return fixed.replace(/\.?0+$/, '');
}

/** Format a percentage as "92.46%".  Used for the voting-power display.
 *  Two fractional digits so the value matches what other Blurt explorers
 *  show (e.g. 96.46%) rather than rounding to a single decimal.
 *  Locale-aware via formatPercent. */
export function formatPercentage(n: number): string {
	if (!Number.isFinite(n)) return '—';
	return formatPercent(n, 2);
}
