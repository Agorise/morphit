/**
 * powerDownProgress — compute an in-progress power-down (withdraw_vesting) for
 * the wallet's power-down modal (cp439).
 *
 * Blurt pays a power-down out in equal WEEKLY installments (Blurt uses a 4-week
 * schedule vs Steem/Hive's 13, but this derives the count from the actual
 * on-chain rate + remaining amount, so it's correct regardless of the schedule
 * length). The account object carries:
 *   - `vesting_withdraw_rate` : per-week payout, a VESTS asset string.
 *   - `next_vesting_withdrawal`: ISO timestamp of the NEXT weekly payout — a
 *     1970-epoch sentinel when nothing is powering down. NOTE the chain
 *     serialises this WITHOUT a trailing `Z` even though it's UTC, so we append
 *     one before parsing (a Z-less ISO would otherwise parse as LOCAL time).
 *   - `to_withdraw` / `withdrawn`: raw VESTS×1e6 integers (total scheduled /
 *     already paid). Their difference is what's still to be released.
 *
 * Returns null when nothing is powering down (idle account, zero rate, or
 * nothing left) so the modal simply hides the section. Pure — no I/O, no DOM.
 */
import { parseAssetAmount, vestsToBlurtPower } from './balanceMath';

/** VESTS are stored on-chain as int64 with 6 implied decimals. */
const VESTS_SCALE = 1_000_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface PowerDownFields {
	readonly vesting_withdraw_rate: string;
	readonly next_vesting_withdrawal: string;
	readonly to_withdraw: string | number;
	readonly withdrawn: string | number;
}

export interface PowerDownProgress {
	/** BLURT POWER still to be released (the not-yet-withdrawn remainder). */
	readonly remainingBp: number;
	/** ISO timestamp (Z-suffixed UTC) of the FINAL weekly payout. */
	readonly finishIso: string;
	/** Weekly payouts still to come (≥ 1). */
	readonly installmentsLeft: number;
}

/** Parse a chain timestamp as UTC even though the chain omits the `Z`. */
function parseChainTimeMs(iso: string): number {
	const s = iso.trim();
	return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

export function computePowerDownProgress(
	f: PowerDownFields,
	totalVestingFundBlurt: string,
	totalVestingShares: string
): PowerDownProgress | null {
	const rateVests = parseAssetAmount(f.vesting_withdraw_rate);
	const toWithdrawVests = Number(f.to_withdraw) / VESTS_SCALE;
	const withdrawnVests = Number(f.withdrawn) / VESTS_SCALE;
	const remainingVests = toWithdrawVests - withdrawnVests;
	const nextMs = parseChainTimeMs(f.next_vesting_withdrawal);

	// Idle / finished / malformed → nothing to show.
	if (
		!Number.isFinite(rateVests) ||
		rateVests <= 0 ||
		!Number.isFinite(remainingVests) ||
		remainingVests <= 0 ||
		!Number.isFinite(nextMs) ||
		nextMs <= 0 // the 1970 epoch sentinel used when not powering down
	) {
		return null;
	}

	// How many weekly payouts remain, and therefore the date of the last one.
	// Subtract a tiny epsilon before ceil so an amount that divides evenly
	// (e.g. exactly 4 payouts) doesn't round up to a phantom extra week.
	const installmentsLeft = Math.max(1, Math.ceil(remainingVests / rateVests - 1e-9));
	const finishMs = nextMs + (installmentsLeft - 1) * WEEK_MS;

	const remainingBp = vestsToBlurtPower(
		`${remainingVests.toFixed(6)} VESTS`,
		totalVestingFundBlurt,
		totalVestingShares
	);
	if (!Number.isFinite(remainingBp) || remainingBp <= 0) return null;

	return {
		remainingBp,
		finishIso: new Date(finishMs).toISOString(),
		installmentsLeft
	};
}
