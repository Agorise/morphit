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
import { consensusV2Active } from '$indexer/consensusActivation';
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
 *  This is independent of the first-COMPLETED-trade reward (see
 *  the feedback handler), which is 10 BLURT liquid + 10 BLURT
 *  Power (a `vesting` transfer the user OWNS — NOT a delegation,
 *  and NOT reclaimable). The two run in parallel. Only the
 *  delegations — this first-fee 1 BP welcome plus the loyalty
 *  milestones below — accumulate into the cumulative delegation
 *  target; the first-trade liquid+vesting reward does not.
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

/**
 * The BP this instance's relay should delegate to `account`: the rewards of
 * the milestones (and the first-fee welcome) reached by fees on orders tagged
 * to THIS instance. A delegation SETS the level from the delegating account,
 * so each instance's relay must carry only its own share. It used to carry
 * the account's whole cumulative total, so once a user's milestones were
 * reached through two instances, both relays delegated the earlier ones.
 * A milestone row is attributed through the order its fee paid for (same
 * account, same block time, the instance's tag).
 */
async function delegationTargetBp(
	client: pg.PoolClient,
	account: string,
	instanceTag: string
): Promise<number> {
	const r = await client.query<{ bp: string }>(
		`SELECT COALESCE(SUM(m.bp_rewarded), 0)::text AS bp
		   FROM account_loyalty_milestones m
		  WHERE m.account = $1
		    AND EXISTS (
		          SELECT 1 FROM orders o
		           WHERE o.account = m.account
		             AND o.operator_tag = $2
		             AND o.created_at = m.triggered_at
		        )`,
		[account, instanceTag]
	);
	return Number(r.rows[0]?.bp ?? '0');
}

/** Called when an order pays a BLURT fee with fee_status='verified'.
 *  Updates cumulative total and queues any newly-crossed milestone
 *  rewards. Must run inside a transaction owning the given client.
 *
 *  `instanceOperatorTag` and `orderOperatorTag` are
 *  used to gate the relay-queue inserts for federation cost-
 *  attribution.  If the order op's operator_tag does NOT match
 *  THIS instance's tag, the cumulative total is still updated
 *  (so the user's loyalty history is consistent across all
 *  indexers in the federation), but NO milestone delegations are
 *  queued — the operator named on the op is the one obligated
 *  for the BP delegation, not us.  If `instanceOperatorTag` is
 *  undefined (unregistered), no delegations queue.
 *
 *  `canonicalBlurt` is the part of the fee that reached the canonical
 *  treasury. From CONSENSUS_V2_ACTIVATION_TIME on it is also added to
 *  `canonical_blurt_paid`, the measure the attestor loyalty gate reads:
 *  the owner leg can go to an account the payer controls (any account can
 *  register an operator naming itself as fee recipient), so only the
 *  canonical leg is money the payer really parted with.
 */
export async function trackVerifiedBlurtFee(
	client: pg.PoolClient,
	account: string,
	amountBlurt: number,
	blockNum: number,
	blockTime: Date,
	orderOperatorTag: string | null,
	instanceOperatorTag: string | undefined,
	canonicalBlurt: number
): Promise<void> {
	if (amountBlurt <= 0) return;
	const canonicalCounted =
		consensusV2Active(blockTime) && Number.isFinite(canonicalBlurt) && canonicalBlurt > 0
			? canonicalBlurt
			: 0;

	// federation-scope gate.  Whether THIS instance is
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
		`INSERT INTO account_loyalty (account, cumulative_blurt_paid, canonical_blurt_paid, updated_at)
		 VALUES ($1, $2, $4, $3)
		 ON CONFLICT (account) DO UPDATE
		   SET cumulative_blurt_paid =
		         account_loyalty.cumulative_blurt_paid + EXCLUDED.cumulative_blurt_paid,
		       canonical_blurt_paid =
		         account_loyalty.canonical_blurt_paid + EXCLUDED.canonical_blurt_paid,
		       updated_at = EXCLUDED.updated_at
		 RETURNING
		   (cumulative_blurt_paid - $2)::text AS previous_total,
		   cumulative_blurt_paid::text AS new_total`,
		[account, amountBlurt, blockTime, canonicalCounted]
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
	// gate (backlog: integration-suite-in-default-gate).
	let firstFeeWelcomeFired = false;
	const welcomeSavepoint = 'first_fee_welcome_sp';
	await client.query(`SAVEPOINT ${welcomeSavepoint}`);
	try {
		await client.query(
			// write triggered_at explicitly with block
			// time, not NOW().  Previously, the DEFAULT NOW was
			// the indexer's wall clock at insert moment, which
			// would diverge across replays.  Column is currently
			// unread; this preempts a future reader tripping on
			// the determinism gap.
			`INSERT INTO account_loyalty_milestones
			   (account, milestone_blurt, bp_rewarded, triggered_at, triggered_in_block)
			 VALUES ($1, $2, $3, $4, $5)`,
			[account, FIRST_FEE_WELCOME_SENTINEL_BLURT, FIRST_FEE_WELCOME_BP, blockTime, blockNum]
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
		// The target includes the 1 BP we just inserted; if no
		// milestone crosses on this same fee, this is just the 1.
		// If a milestone DOES cross, the loop re-computes it and
		// picks up this row plus the milestone row.
		//
		// only queue the relay-payout when THIS instance
		// is the named operator.  The milestone insert above
		// happens unconditionally (global loyalty state); only the
		// federation-cost-bearing queue insert is gated.
		const cumulativeBp = await delegationTargetBp(client, account, orderOperatorTag!);
		if (cumulativeBp <= 0) {
			// Nothing attributable to this instance (no tagged order row for
			// the fee): never queue a zero delegation, which would undelegate.
			log.warn('loyalty_delegation_unattributed', { account, block_num: blockNum });
		} else {
			await client.query(
				`INSERT INTO relay_pending_transfers
				   (recipient, kind, amount_blurt, amount_bp, reason, created_at)
				 VALUES ($1, 'delegation', 0, $2, $3, $4)`,
				[account, cumulativeBp, 'first_listing_fee_welcome', blockTime]
			);
		}
	} else if (firstFeeWelcomeFired && !isOurInstance) {
		// log the skip.  Per-op audit trail
		// for operators reviewing "why didn't we delegate BP
		// after this user's first verified fee?"  All public
		// chain data — no PII.
		log.info('first_fee_welcome_bp_skipped_other_instance', {
			reason: orderOperatorTag === null ? 'order_no_tag' : 'order_tag_mismatch',
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
				// see first INSERT — explicit
				// triggered_at = blockTime for replay determinism.
				`INSERT INTO account_loyalty_milestones
				   (account, milestone_blurt, bp_rewarded, triggered_at, triggered_in_block)
				 VALUES ($1, $2, $3, $4, $5)`,
				[account, ms.thresholdBlurt, ms.bpReward, blockTime, blockNum]
			);
			await client.query(`RELEASE SAVEPOINT ${msSavepoint}`);
		} catch (err) {
			await client.query(`ROLLBACK TO SAVEPOINT ${msSavepoint}`);
			await client.query(`RELEASE SAVEPOINT ${msSavepoint}`);
			if (isUniqueViolation(err)) continue;
			throw err;
		}

		// The relay's delegate_vesting_shares op SETS the delegation
		// level rather than adding — so the queued row carries the
		// absolute target of THIS instance's relay: the rewards of
		// the milestones reached through this instance
		// (delegationTargetBp), not the per-milestone increment and
		// not the account's federation-wide total.
		//
		// only queue the relay-payout when THIS instance
		// is the named operator.  The milestone INSERT above
		// happens unconditionally (global loyalty state stays
		// consistent across the federation); only the federation-
		// cost-bearing queue insert is gated.
		if (!isOurInstance) {
			// log per-milestone skip.  Public
			// chain data only.  Fires once per crossed milestone
			// per fee payment; volume bounded by milestone count.
			log.info('loyalty_milestone_skipped_other_instance', {
				reason: orderOperatorTag === null ? 'order_no_tag' : 'order_tag_mismatch',
				account,
				milestone_blurt: ms.thresholdBlurt,
				bp_rewarded: ms.bpReward,
				order_operator_tag: orderOperatorTag,
				our_tag: instanceOperatorTag ?? null,
				block_num: blockNum
			});
			continue;
		}

		const cumulativeBp = await delegationTargetBp(client, account, orderOperatorTag!);
		if (cumulativeBp <= 0) {
			// Nothing attributable to this instance (no tagged order row for
			// the fee): never queue a zero delegation, which would undelegate.
			log.warn('loyalty_delegation_unattributed', { account, block_num: blockNum });
			continue;
		}

		// Queue the delegation for the relay drainer to broadcast.
		// The relay's delegate_vesting_shares call will convert
		// the BP target (BLURT Power) to VESTS at broadcast time
		// using the chain's current ratio — we store the BP target.
		await client.query(
			`INSERT INTO relay_pending_transfers
			   (recipient, kind, amount_blurt, amount_bp, reason, created_at)
			 VALUES ($1, 'delegation', 0, $2, $3, $4)`,
			[account, cumulativeBp, `loyalty_milestone_${ms.thresholdBlurt}`, blockTime]
		);
	}
}
