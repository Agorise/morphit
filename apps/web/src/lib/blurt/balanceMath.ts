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

/** Number of seconds for a fully-depleted manabar to refill to 100%. */
export const MANA_REGEN_SECONDS = 432_000;

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

/** A voting_manabar object exactly as the chain returns it. */
export interface VotingManabar {
	/** Mana value at `last_update_time`, as a numeric string.  This
	 *  field is in raw VESTS units, not percentage. */
	current_mana: string;
	/** Unix seconds at which `current_mana` was set. */
	last_update_time: number;
}

/** Compute the account's current voting-power percentage [0..100],
 *  regenerated to the supplied `nowSeconds`.
 *
 *  (Blurt has a SINGLE manabar — the voting manabar — and no separate
 *  resource-credit / "RC mana" system the way Hive does, so this value
 *  IS the account's voting power. The UI labels it "Voting".)
 *
 *  Inputs:
 *   - `manabar`: the chain's voting_manabar struct.
 *   - `ownVestingSharesStr`: the account's own `vesting_shares` (e.g.
 *      `"1000000.123456 VESTS"`).
 *   - `receivedVestingSharesStr`: VESTS delegated TO the account
 *      (`received_vesting_shares`).
 *   - `delegatedVestingSharesStr`: VESTS the account delegated OUT
 *      (`delegated_vesting_shares`).
 *   - `nowSeconds`: Date.now()/1000 floored.  Pass it explicitly so
 *      the function is deterministic and smoke-testable.
 *
 *  The manabar ceiling is the account's EFFECTIVE vesting —
 *  `own + received − delegated` — NOT its owned vesting. This matters
 *  for any account that delegates BP out (e.g. the loyalty-grant relay):
 *  using owned vesting as the ceiling overstates the max and understates
 *  the percentage. When current_mana == effective vesting the account is
 *  at 100%.
 *
 *  Math:
 *    max_mana    = own + received − delegated
 *    elapsed     = max(0, nowSeconds − last_update_time)
 *    regenerated = elapsed * max_mana / MANA_REGEN_SECONDS
 *    current     = min(max_mana, current_mana + regenerated)
 *    pct         = 100 * current / max_mana
 *
 *  Returns a percentage (0..100) suitable for direct display. Returns
 *  NaN when the manabar or owned-vesting input is bad. When effective
 *  vesting is ≤ 0 (zero-stake, or fully delegated out), returns 0 — no
 *  mana to regenerate, so display 0% rather than NaN. A missing or
 *  malformed received/delegated value degrades to 0 (ceiling falls back
 *  to owned-only) rather than poisoning the result with NaN. */
export function manaPercentage(
	manabar: VotingManabar | undefined | null,
	ownVestingSharesStr: string,
	receivedVestingSharesStr: string,
	delegatedVestingSharesStr: string,
	nowSeconds: number
): number {
	if (!manabar || typeof manabar.current_mana !== 'string') return NaN;
	if (typeof manabar.last_update_time !== 'number') return NaN;
	if (!Number.isFinite(nowSeconds)) return NaN;
	const current = Number(manabar.current_mana);
	const own = parseAssetAmount(ownVestingSharesStr);
	if (!Number.isFinite(current) || !Number.isFinite(own)) return NaN;
	const finiteOr0 = (s: string): number => {
		const v = parseAssetAmount(s);
		return Number.isFinite(v) ? v : 0;
	};
	const received = finiteOr0(receivedVestingSharesStr);
	const delegated = finiteOr0(delegatedVestingSharesStr);
	const maxMana = own + received - delegated;
	if (maxMana <= 0) return 0;
	const elapsed = Math.max(0, nowSeconds - manabar.last_update_time);
	const regenerated = (elapsed * maxMana) / MANA_REGEN_SECONDS;
	const present = Math.min(maxMana, current + regenerated);
	return Math.max(0, Math.min(100, (100 * present) / maxMana));
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

/** Format a percentage as "92.4%".  Used for MANA.
 *  Locale-aware via formatPercent. */
export function formatPercentage(n: number): string {
	if (!Number.isFinite(n)) return '—';
	return formatPercent(n, 1);
}
