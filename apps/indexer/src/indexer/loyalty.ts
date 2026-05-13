/**
 * Morphit indexer — loyalty milestone tracking (ADR-0011 §4c).
 *
 * Called by the order handler when a BLURT fee is verified.
 * Updates the account's cumulative fee total and triggers
 * delegation rewards when thresholds are crossed.
 *
 * Milestones (in order): 100, 500, 2000, 10000 BLURT paid →
 * 10, 50, 200, 1000 BP delegated. A user who jumps past multiple
 * thresholds in a single order (rare, but possible if they pay
 * an unusually high fee) triggers all crossed milestones in
 * order, one queue entry per milestone.
 *
 * Idempotency: all writes are scoped to the per-op savepoint
 * that the dispatcher establishes. A re-play of the same order
 * would attempt the same UNIQUE inserts and get a
 * unique_violation, which the handler catches and treats as
 * "already rewarded" without failing the op.
 */

import type pg from 'pg';
import { logger } from '$log';

const log = logger('loyalty');

/** ADR-0011 §4c milestone schedule. Order matters — must be
 *  strictly increasing for the cross-detection loop to work. */
export const LOYALTY_MILESTONES: readonly {
	readonly thresholdBlurt: number;
	readonly bpReward: number;
}[] = [
	{ thresholdBlurt: 100, bpReward: 10 },
	{ thresholdBlurt: 500, bpReward: 50 },
	{ thresholdBlurt: 2_000, bpReward: 200 },
	{ thresholdBlurt: 10_000, bpReward: 1_000 }
];

/** First-listing-fee welcome — fires once per account on the
 *  first verified BLURT listing fee, regardless of whether the
 *  underlying trade later succeeds.  Stored in
 *  `account_loyalty_milestones` with milestone_blurt = 0 as a
 *  sentinel; the UNIQUE (account, milestone_blurt) constraint
 *  enforces the once-per-account guarantee.
 *
 *  Why 1 BP and why this trigger:
 *
 *    • The user paid a real fee, so they're not a Sybil farm.
 *    • 1 BP gives them a baseline stake in the Blurt social
 *      network — enough to start earning APR/curation rewards
 *      and feel ownership of the broader ecosystem they just
 *      contributed to.
 *    • Once-per-account avoids per-fee Sybil farming
 *      (1000 accounts × $0.125 listing fee × 1 BP = $125
 *      attacker cost for 1000 BP, which isn't a great deal even
 *      if the attacker is determined).
 *
 *  This is independent of the existing 10 BP delegation that
 *  fires on first COMPLETED trade (see feedback handler) — the
 *  two run in parallel and both add to the cumulative
 *  delegation target.
 */
export const FIRST_FEE_WELCOME_SENTINEL_BLURT = 0;
export const FIRST_FEE_WELCOME_BP = 1;

/** SQLSTATE 23505 = unique_violation — raised if the milestone
 *  is already recorded (idempotent retry). */
function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: unknown }).code === '23505'
	);
}

/** Called when an order pays a BLURT fee with fee_status='verified'.
 *  Updates cumulative total and queues any newly-crossed milestone
 *  rewards. Must run inside a transaction owning the given client.
 *
 *  Part 111 — `instanceOperatorTag` and `orderOperatorTag` are
 *  used to gate the relay-queue inserts for federation cost-
 *  attribution.  If the order op's operator_tag does NOT match
 *  THIS instance's tag, the cumulative total is still updated
 *  (so the user's loyalty history is consistent across all
 *  indexers in the federation), but NO milestone delegations are
 *  queued — the operator named on the op is the one obligated
 *  for the BP delegation, not us.  If `instanceOperatorTag` is
 *  undefined (unregistered), no delegations queue.
 */
export async function trackVerifiedBlurtFee(
	client: pg.PoolClient,
	account: string,
	amountBlurt: number,
	blockNum: number,
	blockTime: Date,
	orderOperatorTag: string | null,
	instanceOperatorTag: string | undefined
): Promise<void> {
	if (amountBlurt <= 0) return;

	// Part 111 federation-scope gate.  Whether THIS instance is
	// the operator obligated for the delegation BP payouts.
	const isOurInstance =
		instanceOperatorTag !== undefined &&
		orderOperatorTag !== null &&
		orderOperatorTag === instanceOperatorTag;

	// UPSERT the cumulative total. Returns the OLD total (before
	// this order) so we can detect milestones crossed specifically
	// by this fee — not by some earlier retry.
	const upsert = await client.query<{
		previous_total: string;
		new_total: string;
	}>(
		`INSERT INTO account_loyalty (account, cumulative_blurt_paid, updated_at)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (account) DO UPDATE
		   SET cumulative_blurt_paid =
		         account_loyalty.cumulative_blurt_paid + EXCLUDED.cumulative_blurt_paid,
		       updated_at = EXCLUDED.updated_at
		 RETURNING
		   (cumulative_blurt_paid - $2)::text AS previous_total,
		   cumulative_blurt_paid::text AS new_total`,
		[account, amountBlurt, blockTime]
	);
	const row = upsert.rows[0];
	if (row === undefined) return; // defensive — RETURNING should always yield

	const previousTotal = Number(row.previous_total);
	const newTotal = Number(row.new_total);

	// First-listing-fee welcome.  Fires once per account on the
	// first verified BLURT fee.  Use the milestones table with
	// milestone_blurt=0 as a sentinel — the UNIQUE constraint
	// gives us once-per-account for free, and the cumulative-BP
	// SELECT inside the milestone loop below will naturally pick
	// up this 1 BP when crossing later milestones (so the
	// delegation target stays correct).
	//
	// G6 audit fix — wrap the INSERT in a nested SAVEPOINT.
	// Without this, the UNIQUE violation that fires on every
	// non-first call POISONS the outer transaction (Postgres
	// puts it in ABORTED state).  Catching the JS error doesn't
	// un-abort the tx; subsequent statements fail with
	// "current transaction is aborted, commands ignored until
	// end of transaction block."  The dispatcher's RELEASE
	// SAVEPOINT then fails, the order handler is treated as
	// thrown, and the dispatcher ROLLBACKs the per-op savepoint
	// — discarding the order INSERT we were trying to save.
	//
	// Caught pre-launch by the integration test suite, which
	// was failing all along but wasn't part of the default CI
	// gate (REVISIT-LIST: integration-suite-in-default-gate).
	let firstFeeWelcomeFired = false;
	const welcomeSavepoint = 'first_fee_welcome_sp';
	await client.query(`SAVEPOINT ${welcomeSavepoint}`);
	try {
		await client.query(
			`INSERT INTO account_loyalty_milestones
			   (account, milestone_blurt, bp_rewarded, triggered_in_block)
			 VALUES ($1, $2, $3, $4)`,
			[account, FIRST_FEE_WELCOME_SENTINEL_BLURT, FIRST_FEE_WELCOME_BP, blockNum]
		);
		await client.query(`RELEASE SAVEPOINT ${welcomeSavepoint}`);
		firstFeeWelcomeFired = true;
	} catch (err) {
		// Roll back JUST this nested savepoint — the outer
		// transaction stays alive.  Then re-classify: the
		// expected case is the unique violation (already
		// rewarded), which we treat as "skip, proceed."  Any
		// other error is unexpected and re-thrown.
		await client.query(`ROLLBACK TO SAVEPOINT ${welcomeSavepoint}`);
		await client.query(`RELEASE SAVEPOINT ${welcomeSavepoint}`);
		if (!isUniqueViolation(err)) throw err;
		// Already received the welcome — proceed to milestone
		// detection below without queueing.
	}

	if (firstFeeWelcomeFired && isOurInstance) {
		// Cumulative includes the 1 BP we just inserted; if no
		// milestone crosses on this same fee, this is just the 1.
		// If a milestone DOES cross, it'll re-query cumulative
		// inside the loop and pick up this row plus the milestone
		// row, so the delegation target stays correct.
		//
		// Part 111: only queue the relay-payout when THIS instance
		// is the named operator.  The milestone insert above
		// happens unconditionally (global loyalty state); only the
		// federation-cost-bearing queue insert is gated.
		const cumResult = await client.query<{ cumulative_bp: string }>(
			`SELECT COALESCE(SUM(bp_rewarded), 0)::text AS cumulative_bp
			   FROM account_loyalty_milestones
			  WHERE account = $1`,
			[account]
		);
		const cumulativeBp = Number(cumResult.rows[0]?.cumulative_bp ?? '0');
		await client.query(
			`INSERT INTO relay_pending_transfers
			   (recipient, kind, amount_blurt, amount_bp, reason, created_at)
			 VALUES ($1, 'delegation', 0, $2, $3, $4)`,
			[account, cumulativeBp, 'first_listing_fee_welcome', blockTime]
		);
	} else if (firstFeeWelcomeFired && !isOurInstance) {
		// Part 112 hardening — log the skip.  Per-op audit trail
		// for operators reviewing "why didn't we delegate BP
		// after this user's first verified fee?"  All public
		// chain data — no PII.
		log.info('first_fee_welcome_bp_skipped_other_instance', {
			reason:
				orderOperatorTag === null
					? 'order_no_tag'
					: 'order_tag_mismatch',
			account,
			order_operator_tag: orderOperatorTag,
			our_tag: instanceOperatorTag ?? null,
			block_num: blockNum
		});
	}

	// Find milestones newly crossed by this fee payment.
	// previous_total < threshold ≤ new_total means the threshold
	// was crossed upward by THIS fee.
	for (const ms of LOYALTY_MILESTONES) {
		if (previousTotal >= ms.thresholdBlurt) continue;
		if (newTotal < ms.thresholdBlurt) continue;

		// G6 audit fix — wrap each milestone INSERT in a
		// SAVEPOINT for the same reason as the welcome INSERT
		// above.  A UNIQUE violation here would otherwise
		// poison the transaction.  This loop's collision case
		// is a chain replay (same block re-applied), which
		// idempotency handles cleanly via continue → so the
		// fix matters less than the welcome case but the
		// pattern should match for consistency.
		const msSavepoint = `loyalty_ms_${ms.thresholdBlurt}_sp`;
		await client.query(`SAVEPOINT ${msSavepoint}`);
		try {
			// Record the milestone. UNIQUE violation = already
			// awarded on a previous crossing; continue to check
			// subsequent milestones.
			await client.query(
				`INSERT INTO account_loyalty_milestones
				   (account, milestone_blurt, bp_rewarded, triggered_in_block)
				 VALUES ($1, $2, $3, $4)`,
				[account, ms.thresholdBlurt, ms.bpReward, blockNum]
			);
			await client.query(`RELEASE SAVEPOINT ${msSavepoint}`);
		} catch (err) {
			await client.query(`ROLLBACK TO SAVEPOINT ${msSavepoint}`);
			await client.query(`RELEASE SAVEPOINT ${msSavepoint}`);
			if (isUniqueViolation(err)) continue;
			throw err;
		}

		// Compute the CUMULATIVE BP target across all milestones
		// this account has reached so far (including the one we
		// just inserted). The relay's delegate_vesting_shares op
		// SETS the delegation level rather than adding — so the
		// queued row must carry the absolute target, not the
		// per-milestone increment.
		//
		// Part 111: only queue the relay-payout when THIS instance
		// is the named operator.  The milestone INSERT above
		// happens unconditionally (global loyalty state stays
		// consistent across the federation); only the federation-
		// cost-bearing queue insert is gated.
		if (!isOurInstance) {
			// Part 112 hardening — log per-milestone skip.  Public
			// chain data only.  Fires once per crossed milestone
			// per fee payment; volume bounded by milestone count.
			log.info('loyalty_milestone_skipped_other_instance', {
				reason:
					orderOperatorTag === null
						? 'order_no_tag'
						: 'order_tag_mismatch',
				account,
				milestone_blurt: ms.thresholdBlurt,
				bp_rewarded: ms.bpReward,
				order_operator_tag: orderOperatorTag,
				our_tag: instanceOperatorTag ?? null,
				block_num: blockNum
			});
			continue;
		}

		const cumResult = await client.query<{ cumulative_bp: string }>(
			`SELECT COALESCE(SUM(bp_rewarded), 0)::text AS cumulative_bp
			   FROM account_loyalty_milestones
			  WHERE account = $1`,
			[account]
		);
		const cumulativeBp = Number(cumResult.rows[0]?.cumulative_bp ?? '0');

		// Queue the delegation for the relay drainer to broadcast.
		// The relay's delegate_vesting_shares call will convert
		// cumulative_bp (BLURT Power) to VESTS at broadcast time
		// using the chain's current ratio — we store the BP target.
		await client.query(
			`INSERT INTO relay_pending_transfers
			   (recipient, kind, amount_blurt, amount_bp, reason, created_at)
			 VALUES ($1, 'delegation', 0, $2, $3, $4)`,
			[account, cumulativeBp, `loyalty_milestone_${ms.thresholdBlurt}`, blockTime]
		);
	}
}
