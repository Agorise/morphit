/**
 * Morphit indexer — operator-earnings attribution + immediate
 * payout.
 *
 * Called by the order handler after a BLURT fee is verified.
 * If the order op carries an `operator_tag` that resolves to
 * a registered, active operator, this module credits that
 * operator with their share of the fee, queues an immediate
 * relay transfer for the credited amount, and records audit
 * events.
 *
 * REVISIT-LIST item 5 — pipeline shipped 2026-05-02.
 *
 * ─── Policy of record ──────────────────────────────────────
 *
 * **BLURT-paid listing fees: 90% to the attributed operator,
 * 10% to the Morphit treasury.**  This is what the user-facing
 * FAQ promises in all 10 locales (faq.entries.how_operators_earn).
 *
 * BTC- and XMR-paid listing fees flow 100% to the treasury.
 * That path doesn't go through this module — it's enforced
 * by `attributeBlurtFee` only being called from the BLURT-fee
 * branch of the order handler.  See `apps/indexer/src/indexer/handlers/order.ts`.
 *
 * The split percentage is recorded on each event row as
 * `split_percent_at_event` so a future policy change doesn't
 * retroactively rewrite history.  If 90/10 ever shifts, NEW
 * events use the new ratio while the audit log of OLD events
 * stays intact.
 *
 * ─── Immediate-payout model ────────────────────────────────
 *
 * Per Ken's directive (2026-05-02), payout is immediate per
 * attribution rather than batched.  Blurt's 3-second blocks
 * + mana-based (effectively zero per-tx fee) economics make
 * batching pointless: the relay account already does dozens
 * of welcome-bonus transfers daily without strain.
 *
 * Pipeline within a single transaction (the order-handler's
 * per-op savepoint):
 *   1. Look up operator by tag (active only).
 *   2. Insert audit row in operator_attribution_events.
 *      UNIQUE on trx_id rejects replays.
 *   3. If operator_share_blurt > 0:
 *        a. Insert row in relay_pending_transfers (kind='liquid',
 *           amount = operator's share, recipient = operator's
 *           account, reason = 'operator_payout:<trx_id>').
 *        b. Insert audit row in operator_payouts referencing
 *           both the attribution event and the relay row.
 *        c. UPSERT operator_earnings (cumulative_blurt_earned
 *           and lifetime_paid_blurt += share, last_payout_at
 *           = block_time, last_payout_blurt = share).
 *      If operator_share_blurt == 0 (sub-precision rounding
 *      to zero — e.g. 0.001-BLURT fees), no transfer queued
 *      and operator_earnings is updated with 0 share but the
 *      attribution event row still records the fact for audit
 *      completeness.
 *
 * The relay drainer picks up the queued row on its next cycle
 * (~seconds) and broadcasts it.  Operator sees BLURT in their
 * wallet within typically 10-15s of the user's order op.
 *
 * ─── Black-hat audit (deep) ────────────────────────────────
 *
 * Attacker scenarios considered when designing this module:
 *
 * 1. *Tag forging.*  Order op sets `operator_tag: 'alice'`.
 *    Handler does `SELECT account FROM operators WHERE tag = $1
 *    AND is_active = TRUE`.  Tag-not-found = no attribution,
 *    no payout.
 *
 * 2. *Self-dealing.*  Attacker stuffs a real operator's tag
 *    on their own orders to credit a colluding operator.
 *    Net: attacker pays 10% of fee they wouldn't otherwise.
 *    Money-loser; not a serious attack vector.  Logged in
 *    operator_attribution_events for transparency.
 *
 * 3. *Replay.*  trx_id UNIQUE on operator_attribution_events
 *    rejects double-credit.  (order_account, order_permlink)
 *    UNIQUE is the secondary defense.  CRUCIALLY: if the
 *    attribution event insert fails, NO downstream writes
 *    happen — no relay queue, no operator_payouts, no
 *    operator_earnings update.  All-or-nothing per op.
 *
 * 4. *Tag-charset injection.*  Tags are validated at REGISTRATION
 *    time by the operator-register handler's TAG_PATTERN.  At
 *    order-handler time we cheap-check length and charset
 *    BEFORE the SQL lookup so a hostile order op can't pass a
 *    pathological string.  No SQLi risk because we use
 *    parameterized queries; the cheap-check just stops payload
 *    spam from costing us a SELECT.
 *
 * 5. *Operator deactivation race.*  We require `is_active=TRUE`
 *    on the lookup.  Deactivated operators stop earning new
 *    attribution.  Their PRIOR earnings are already paid (in
 *    the immediate-payout model) so deactivation has clean
 *    semantics: no funny pending-balance edge cases.
 *
 * 6. *Negative or zero-fee attribution.*  Fees that pass the
 *    order-handler's verification have amount > 0 by
 *    construction (else fee_underpaid rejected).  We CHECK
 *    amount > 0 again here as defense-in-depth.
 *
 * 7. *Floating-point precision.*  Share computation is done
 *    in milli-BLURT integer arithmetic with FLOOR rounding.
 *    Operator never gets over-credited; treasury keeps any
 *    sub-precision residual.  3-decimal output matches
 *    BLURT chain precision exactly.
 *
 * 8. *Race between operator registration and order op in the
 *    same block.*  Indexer processes ops sequentially within a
 *    block.  If register comes first, lookup succeeds.  If
 *    order comes first, no attribution.  Acceptable: operator
 *    misses the very first attribution if it lands in the same
 *    block as their own register.
 *
 * 9. *Relay broadcast failure.*  Once we queue the
 *    relay_pending_transfers row, it's the relay drainer's
 *    responsibility.  If broadcast fails (operator account
 *    doesn't exist on-chain, bad witness, network), the row
 *    stays unbroadcast with last_error set.  The earnings
 *    accounting on our side is correct: we credited
 *    lifetime_paid_blurt at queue time, and the relay's
 *    failure to broadcast doesn't unwind that.  Recovery is
 *    a federation-level human concern (operator support).
 *
 * 10. *Relay account out of mana.*  Relay drainer broadcasts
 *     when mana is available; otherwise rows pile up in the
 *     queue.  Same as welcome-bonus path.  No corruption.
 *
 * 11. *Treasury front-running attack.*  Attacker watches the
 *     mempool for a high-fee order op carrying an operator_tag,
 *     copies the attribution payload onto their own order,
 *     pre-pays a 0.001 BLURT fee.  Result: 0.001 fee × 90% =
 *     0 milli-BLURT (floors to nothing).  No payout queued.
 *     Mitigation effective.
 *
 * 12. *Recursive operator_tag attack.*  Operator alice
 *     attributes orders to herself, getting 90% back.  Net
 *     cost is 10% per order.  This is "paying for orderbook
 *     spam" — see the order handler's anti-spam rate limits.
 *     Not a money-extraction vector.
 */

import type pg from 'pg';
import { logger } from '$log';

const log = logger('operator-earnings');

/** Current split percentage going to the operator on BLURT-paid
 *  fees.  See FAQ key `how_operators_earn` for the policy
 *  rationale.  If this changes via governance vote, update here
 *  AND in the FAQ in all 10 locales. */
export const OPERATOR_BLURT_SPLIT_PERCENT = 90;

/** Maximum tag length we'll accept in an order-op payload before
 *  even looking it up.  Mirrors the operator-register handler's
 *  TAG_MAX (64). */
const TAG_MAX_LENGTH = 64;

/** Tag charset.  Must match the registration handler's
 *  TAG_PATTERN.  Cheap pre-filter before SQL lookup. */
const TAG_PATTERN = /^[a-z0-9._-]+$/;

/** Result returned to the order handler. */
export type AttributionResult =
	| {
			kind: 'attributed';
			operatorAccount: string;
			operatorShareBlurt: number;
			payoutQueued: boolean;
	  }
	| { kind: 'no_tag' }
	| { kind: 'tag_malformed' }
	| { kind: 'tag_unknown' }
	| { kind: 'duplicate_attribution' }
	/** Part 111 — the order op's operator_tag does not match
	 *  THIS instance's MORPHIT_INSTANCE_OPERATOR_TAG.  The op is
	 *  for another operator's instance; this indexer records the
	 *  order for orderbook/audit purposes but does NOT queue a
	 *  payout (the named operator's relay is the one obligated).
	 *  Pre-Part-111, every operator queued every op's payout —
	 *  multiplying federation cost.  This gate fixes it. */
	| { kind: 'attributed_other_instance'; opTag: string; instanceTag: string };

/** Compute the operator's share of a BLURT fee.  Pure function
 *  for unit testing.  Returned as 3-decimal strings ready for
 *  Postgres NUMERIC parameters. */
export function computeOperatorShareBlurt(feeBlurt: number): {
	operatorShareBlurt: string;
	treasuryShareBlurt: string;
} {
	if (!Number.isFinite(feeBlurt) || feeBlurt <= 0) {
		throw new Error(`computeOperatorShareBlurt: invalid feeBlurt ${feeBlurt}`);
	}
	const feeMilliBlurt = Math.round(feeBlurt * 1000);
	const operatorMilliBlurt = Math.floor((feeMilliBlurt * OPERATOR_BLURT_SPLIT_PERCENT) / 100);
	const treasuryMilliBlurt = feeMilliBlurt - operatorMilliBlurt;
	return {
		operatorShareBlurt: (operatorMilliBlurt / 1000).toFixed(3),
		treasuryShareBlurt: (treasuryMilliBlurt / 1000).toFixed(3)
	};
}

/** Pre-validate an operator_tag value pulled from an order op
 *  payload. */
export function validateOperatorTagField(
	raw: unknown
): { tag: string } | { reason: 'missing' } | { reason: 'malformed' } {
	if (raw === undefined || raw === null) return { reason: 'missing' };
	if (typeof raw !== 'string') return { reason: 'malformed' };
	if (raw.length === 0) return { reason: 'missing' };
	if (raw.length > TAG_MAX_LENGTH) return { reason: 'malformed' };
	if (!TAG_PATTERN.test(raw)) return { reason: 'malformed' };
	return { tag: raw };
}

interface AttributeArgs {
	readonly client: pg.PoolClient;
	readonly operatorTagRaw: unknown;
	readonly orderAccount: string;
	readonly orderPermlink: string;
	readonly feeBlurt: number;
	readonly trxId: string;
	readonly blockNum: number;
	readonly blockTime: Date;
	/** Part 111 — THIS instance's operator tag, from
	 *  `ctx.config.instanceOperatorTag`.  If undefined or empty,
	 *  the indexer is unregistered (canonical bootstrap state or
	 *  community operator pre-registration) and all attributions
	 *  fall through to `attributed_other_instance` — i.e. queue
	 *  NO payouts.  Conservative default: "if I don't know who I
	 *  am, I don't pay for anything."  Set this via
	 *  MORPHIT_INSTANCE_OPERATOR_TAG. */
	readonly instanceOperatorTag: string | undefined;
}

/** Attribute a verified BLURT listing fee to a registered
 *  operator AND immediately queue the relay transfer.
 *
 *  All writes happen inside the caller's transaction (the
 *  order handler's per-op savepoint); a failure anywhere
 *  rolls back the whole attribution.  Idempotent on trx_id
 *  via UNIQUE constraint.
 *
 *  Side effects on success (kind === 'attributed'):
 *    - INSERT into operator_attribution_events
 *    - If operator_share_blurt > 0:
 *        - INSERT into relay_pending_transfers (kind='liquid')
 *        - INSERT into operator_payouts
 *    - UPSERT operator_earnings (lifetime_paid_blurt += share)
 *
 *  Part 111 — when `operator_tag !== instanceOperatorTag`:
 *    - NO DB writes at all.  Returns `attributed_other_instance`.
 *    - The op is for a different operator's instance; their
 *      indexer will handle it.  This indexer recorded the order
 *      itself (in the orders table) for orderbook/audit
 *      purposes; only the payout side is gated.
 *
 *  No-op (no DB writes) for any non-'attributed' outcome.
 */
export async function attributeBlurtFeeToOperator(args: AttributeArgs): Promise<AttributionResult> {
	const tagCheck = validateOperatorTagField(args.operatorTagRaw);
	if ('reason' in tagCheck) {
		return tagCheck.reason === 'missing' ? { kind: 'no_tag' } : { kind: 'tag_malformed' };
	}
	const tag = tagCheck.tag;

	// Part 111 federation-scope gate.  Each operator pays only
	// for ops attributed to their own tag — the operator getting
	// the 90% reward is the operator obligated for the
	// consequences.  Economic alignment: a spammer trying to
	// dump payouts onto a victim operator would have to pay 90%
	// of every fee TO that victim — net break-even, no leverage.
	//
	// `instanceOperatorTag === undefined` (operator hasn't set
	// MORPHIT_INSTANCE_OPERATOR_TAG yet) collapses to the same
	// branch — no payouts queue.  Conservative default; the
	// operator can re-run their wizard or set the env var and
	// restart to start participating.
	if (args.instanceOperatorTag === undefined || tag !== args.instanceOperatorTag) {
		// Part 112 hardening — log the skip so operators have an
		// audit trail of "saw this op, intentionally didn't queue
		// payouts because it's not for our instance."  Public-data-
		// only: op_tag is on chain, our_tag is in operator env,
		// signer is the order op's signer (chain metadata).  No PII.
		log.info('attribution_skipped_other_instance', {
			reason: 'op_tag_mismatch',
			op_tag: tag,
			our_tag: args.instanceOperatorTag ?? null,
			trx_id: args.trxId,
			block_num: args.blockNum,
			order_account: args.orderAccount,
			order_permlink: args.orderPermlink,
			fee_blurt: args.feeBlurt
		});
		return {
			kind: 'attributed_other_instance',
			opTag: tag,
			instanceTag: args.instanceOperatorTag ?? ''
		};
	}

	// Look up the operator by tag.  Active-only.
	const lookup = await args.client.query<{
		account: string;
	}>(
		`SELECT account FROM operators
		  WHERE tag = $1 AND is_active = TRUE`,
		[tag]
	);
	if (lookup.rowCount === 0) {
		return { kind: 'tag_unknown' };
	}
	const operatorAccount = lookup.rows[0]!.account;

	const { operatorShareBlurt, treasuryShareBlurt } = computeOperatorShareBlurt(args.feeBlurt);
	const operatorShareNum = Number(operatorShareBlurt);

	// Insert the attribution event.  RETURNING the new id so
	// downstream rows can reference it.
	let attributionEventId: string;
	try {
		const ins = await args.client.query<{ id: string }>(
			`INSERT INTO operator_attribution_events (
				operator_account, operator_tag,
				order_account, order_permlink,
				fee_blurt, operator_share_blurt, treasury_share_blurt,
				split_percent_at_event,
				trx_id, block_num, block_time_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			RETURNING id::text`,
			[
				operatorAccount,
				tag,
				args.orderAccount,
				args.orderPermlink,
				args.feeBlurt.toFixed(3),
				operatorShareBlurt,
				treasuryShareBlurt,
				OPERATOR_BLURT_SPLIT_PERCENT,
				args.trxId,
				args.blockNum,
				args.blockTime
			]
		);
		attributionEventId = ins.rows[0]!.id;
	} catch (err) {
		if (isUniqueViolation(err)) {
			return { kind: 'duplicate_attribution' };
		}
		throw err;
	}

	let payoutQueued = false;

	if (operatorShareNum > 0) {
		// Queue the relay transfer.  RETURNING the new id so we
		// can link the operator_payouts row to it.
		const queueRes = await args.client.query<{ id: string }>(
			`INSERT INTO relay_pending_transfers (
				recipient, kind, amount_blurt, reason, created_at
			) VALUES ($1, 'liquid', $2, $3, $4)
			RETURNING id::text`,
			[operatorAccount, operatorShareBlurt, `operator_payout:${args.trxId}`, args.blockTime]
		);
		const relayRowId = queueRes.rows[0]!.id;

		// Audit row linking the attribution to the relay row.
		await args.client.query(
			`INSERT INTO operator_payouts (
				operator_account, attribution_event_id,
				amount_blurt, relay_pending_transfer_id, queued_at
			) VALUES ($1, $2, $3, $4, $5)`,
			[operatorAccount, attributionEventId, operatorShareBlurt, relayRowId, args.blockTime]
		);

		payoutQueued = true;
	}

	// UPSERT operator_earnings.  cumulative_blurt_earned tracks
	// lifetime credit; lifetime_paid_blurt mirrors it (separate
	// for future model divergence).  last_payout_at and
	// last_payout_blurt now mean "most recent attribution"
	// (per-event semantic) rather than "most recent batch."
	await args.client.query(
		`INSERT INTO operator_earnings (
			account, cumulative_blurt_earned, total_orders_attributed,
			lifetime_paid_blurt, last_payout_at, last_payout_blurt, updated_at
		) VALUES ($1, $2, 1, $2, $3, $2, $3)
		ON CONFLICT (account) DO UPDATE
		  SET cumulative_blurt_earned =
		        operator_earnings.cumulative_blurt_earned + EXCLUDED.cumulative_blurt_earned,
		      total_orders_attributed =
		        operator_earnings.total_orders_attributed + 1,
		      lifetime_paid_blurt =
		        operator_earnings.lifetime_paid_blurt + EXCLUDED.lifetime_paid_blurt,
		      last_payout_at = EXCLUDED.last_payout_at,
		      last_payout_blurt = EXCLUDED.last_payout_blurt,
		      updated_at = EXCLUDED.updated_at`,
		[operatorAccount, operatorShareBlurt, args.blockTime]
	);

	return {
		kind: 'attributed',
		operatorAccount,
		operatorShareBlurt: operatorShareNum,
		payoutQueued
	};
}

/** Postgres SQLSTATE 23505 = unique_violation. */
function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: unknown }).code === '23505'
	);
}
