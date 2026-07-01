/**
 * Morphit — feature-bid broadcaster (Phase 5 item 5).
 *
 * Issues a `morphit_feature_bid_v1` op bundled with a sibling
 * transfer to the fee-collection account. Pattern mirrors
 * `broadcastOrder` with feeMethod='blurt': same two-op
 * transaction shape, same active-key unlock requirement, but a
 * different op id and a different memo namespace
 * (`morphit-feature:<permlink>` instead of `morphit-fee:<permlink>`).
 *
 * The caller is expected to have:
 *   - confirmed the target order is live and owned by the signer
 *   - JIT-unlocked the active key via `useActiveKey()`
 *   - picked an hours-requested value in [1, 168]
 *   - fetched the current `featureFeeBlurtPerHour` from the
 *     indexer's /v1/config (or used the cached default)
 *
 * Overpayment is accepted by the indexer (tolerance band same as
 * listing fees), so if `featureFeeBlurtPerHour × hours` rounds to
 * a fractional BLURT we ceil-round at 3 decimals — the user
 * slightly overpays rather than risking an `fee_underpaid` reject.
 */

import { prepareUnsignedOrderWithFee, broadcastSignedTransaction } from '$blurt/sign';
import type { Transaction, SignedTransaction } from '@beblurt/dblurt';
import { getUserBlurtAccount, BroadcastError } from '$blurt/ops/profile';
import { OP_IDS } from '$net/config';
import type { LiveIdentity } from '$crypto/keygen';

import { FEE_RECIPIENT, formatBlurtAmount } from '$lib/orders/fee';

export interface FeatureBidInput {
	/** Permlink of a live order owned by the signer. */
	readonly orderPermlink: string;
	/** How many hours the bidder is paying for. 1..168. */
	readonly hoursRequested: number;
	/** Current per-hour rate from indexer config (default 50). */
	readonly feeBlurtPerHour: number;
}

export interface BroadcastFeatureBidResult {
	readonly block_num: number;
	readonly trx_id: string;
	/** Total BLURT transferred, as the canonical "N.NNN BLURT" string. */
	readonly blurtPaidFormatted: string;
	/** Same value as a number, for UI arithmetic / analytics. */
	readonly blurtPaid: number;
}

/** Format the memo for a feature-bid sibling transfer. Matches
 *  what the indexer's featureBid handler parses. */
export function featureBidMemoFor(permlink: string): string {
	return `morphit-feature:${permlink}`;
}

/**
 * Broadcast a feature bid.
 *
 * Phase F.5 audit fix (F-18) — takes a `signCallback` rather
 * than the raw active-key scalar.  See broadcastNewOrder for
 * pattern explanation.
 *
 * @param live           Unlocked identity (posting key)
 * @param signCallback   Sign-callback (caller wraps useActiveKey)
 * @param input          Bid parameters
 */
export async function broadcastFeatureBid(
	_live: LiveIdentity,
	signCallback: (tx: Transaction) => SignedTransaction | Promise<SignedTransaction>,
	input: FeatureBidInput
): Promise<BroadcastFeatureBidResult> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError(
			'no_account',
			'You need a Blurt account before bidding on a featured slot.'
		);
	}

	// Defensive input checks. The UI should already have guarded
	// these; re-checking here means a bug in the UI can't produce
	// a malformed on-chain op.  Indexer enforces MIN_HOURS=6 +
	// MAX_HOURS=168 (see apps/indexer/src/indexer/handlers/featureBid.ts);
	// keep this in sync — divergent client/server validation just
	// produces confusing rejection codes for the user.
	if (
		!Number.isInteger(input.hoursRequested) ||
		input.hoursRequested < 6 ||
		input.hoursRequested > 168
	) {
		throw new BroadcastError('no_account', 'hours_requested must be an integer in [6, 168]');
	}
	if (!Number.isFinite(input.feeBlurtPerHour) || input.feeBlurtPerHour <= 0) {
		throw new BroadcastError('no_account', 'feeBlurtPerHour must be a positive number');
	}
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.orderPermlink)) {
		throw new BroadcastError('no_account', 'orderPermlink has invalid characters');
	}

	const blurtAmount = input.feeBlurtPerHour * input.hoursRequested;
	const blurtFormatted = formatBlurtAmount(blurtAmount);
	const memo = featureBidMemoFor(input.orderPermlink);

	const payload = {
		order_permlink: input.orderPermlink,
		hours_requested: input.hoursRequested
	};

	// Phase F.5 audit fix (F-18) — three-phase split.
	const unsigned = await prepareUnsignedOrderWithFee(
		OP_IDS.featureBid,
		payload,
		account,
		FEE_RECIPIENT,
		blurtFormatted,
		memo
	);
	const signed = await signCallback(unsigned);
	const result = await broadcastSignedTransaction(signed);

	return {
		block_num: result.block_num,
		trx_id: result.trx_id,
		blurtPaidFormatted: blurtFormatted,
		blurtPaid: Math.ceil(blurtAmount * 1000) / 1000
	};
}
