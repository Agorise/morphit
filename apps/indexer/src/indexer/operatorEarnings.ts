/**
 * Morphit indexer — operator-earnings attribution (audit).
 *
 * Called by the order handler after a BLURT fee is verified.
 * If the order op carries an `operator_tag` that resolves to a
 * registered, active operator, this module records that the
 * operator earned their 90% share of the fee — for the operator
 * dashboard and a per-order audit trail.
 *
 * cp408 — this module NO LONGER queues a relay payout. The
 * operator's 90% is paid DIRECTLY at payment time: the user's fee
 * transaction splits into a 90% transfer to the instance's fee
 * recipient (the operator's account) plus a 10% transfer to the
 * canonical treasury (see `feeTransfersFor` on the frontend and
 * `sumFeeTransfers` in the indexer). Nothing is forwarded
 * afterward, so this module's job is purely attribution + earnings
 * accounting. The older "fee lands in a treasury, relay forwards
 * the operator's 90%" model is retired — it only netted correctly
 * when one entity owned both the treasury and the relay (the
 * canonical case), which is exactly why it broke for independent
 * federation owners.
 *
 * REVISIT-LIST item 5 — attribution pipeline shipped 2026-05-02;
 * relay payout removed 2026-07-04 (cp408) in favor of the
 * payment-time split.
 *
 * ─── Policy of record ──────────────────────────────────────
 *
 * **BLURT-paid listing fees: 90% to the attributed operator, 10%
 * to the canonical Morphit treasury**, both delivered at payment
 * time. This is what the user-facing FAQ promises in all 10
 * locales (faq.entries.how_operators_earn).
 *
 * BTC- and XMR-paid listing fees flow 100% to the canonical
 * treasury. That path doesn't go through this module — it's
 * enforced by `attributeBlurtFeeToOperator` only being called from
 * the BLURT-fee branch of the order handler. See
 * `apps/indexer/src/indexer/handlers/order.ts`.
 *
 * The split percentage is recorded on each event row as
 * `split_percent_at_event` so a future policy change doesn't
 * retroactively rewrite history. If 90/10 ever shifts, NEW events
 * use the new ratio while the audit log of OLD events stays intact.
 *
 * ─── What this module writes ───────────────────────────────
 *
 * Within the order-handler's per-op savepoint:
 *   1. Look up operator by tag (active only).
 *   2. INSERT audit row in operator_attribution_events (fee,
 *      operator's 90% share, treasury's 10% share, split %).
 *      UNIQUE on trx_id rejects replays.
 *   3. UPSERT operator_earnings (cumulative_blurt_earned += share,
 *      total_orders_attributed += 1). The operator dashboard
 *      (/v1/operators) reads those two figures.
 *
 * No relay transfer is queued and no operator_payouts row is
 * written — the operator was already paid by the split at the
 * moment the user's fee cleared.
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
 * 9. *Operator's fee account doesn't exist on-chain.*  Under the
 *    payment-time split the user's wallet is what sends the 90% to
 *    the operator's account. If the operator configured a
 *    non-existent account, the CHAIN rejects that transfer (and
 *    thus the whole fee tx), so the order never lands — the
 *    operator simply can't collect until they set a real account.
 *    This module isn't involved in delivery, so there is no
 *    unbroadcast-payout / last_error state to reconcile anymore.
 *
 * 10. *Relay account out of mana.*  No longer relevant to operator
 *     earnings: the operator's 90% is paid by the user's wallet,
 *     not the relay. The relay still funds welcome bonuses +
 *     loyalty; those paths are unchanged.
 *
 * 11. *Fee-splitting front-running / dust attack.*  Attacker copies
 *     an operator_tag onto their own order and pre-pays a dust fee.
 *     A dust fee is far below the acceptance floor, so the order
 *     handler rejects it as fee_underpaid before this module is
 *     ever called — no attribution, and the attacker paid the
 *     operator (via the split) for nothing. Mitigation effective.
 *
 * 12. *Recursive operator_tag attack.*  Operator alice
 *     attributes orders to herself, getting 90% back.  Net
 *     cost is 10% per order (paid to the canonical treasury by
 *     the split).  This is "paying for orderbook spam" — see the
 *     order handler's anti-spam rate limits.  Not a
 *     money-extraction vector.
 */

import type pg from 'pg';
import { splitListingFeeBlurt } from '@morphit/asset-registry';
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
	  }
	| { kind: 'no_tag' }
	| { kind: 'tag_malformed' }
	| { kind: 'tag_unknown' }
	| { kind: 'duplicate_attribution' }
	/** Part 111 — the order op's operator_tag does not match
	 *  THIS instance's MORPHIT_INSTANCE_OPERATOR_TAG.  The op is
	 *  for another operator's instance; this indexer records the
	 *  order for orderbook/audit purposes but does NOT record
	 *  earnings for it (those belong on the named operator's own
	 *  indexer). Pre-Part-111 every operator recorded every op —
	 *  now each instance only books its own. */
	| { kind: 'attributed_other_instance'; opTag: string; instanceTag: string };

/** Compute the operator's share of a BLURT fee.  Pure function
 *  for unit testing.  Returned as 3-decimal strings ready for
 *  Postgres NUMERIC parameters.
 *
 *  cp408 — delegates to `splitListingFeeBlurt` (the same helper the
 *  frontend uses to build the fee transaction), so the recorded
 *  earnings match to the milliBLURT what the operator was actually
 *  paid by the split. */
export function computeOperatorShareBlurt(feeBlurt: number): {
	operatorShareBlurt: string;
	treasuryShareBlurt: string;
} {
	if (!Number.isFinite(feeBlurt) || feeBlurt <= 0) {
		throw new Error(`computeOperatorShareBlurt: invalid feeBlurt ${feeBlurt}`);
	}
	const { ownerShareBlurt, treasuryShareBlurt } = splitListingFeeBlurt(feeBlurt);
	return {
		operatorShareBlurt: ownerShareBlurt.toFixed(3),
		treasuryShareBlurt: treasuryShareBlurt.toFixed(3)
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

/** Record that a verified BLURT listing fee attributed to a
 *  registered operator earned that operator their 90% share.
 *
 *  cp408 — audit only. The operator's 90% was already paid at
 *  payment time by the fee split; this queues NO transfer. All
 *  writes happen inside the caller's transaction (the order
 *  handler's per-op savepoint); a failure anywhere rolls back the
 *  whole attribution. Idempotent on trx_id via UNIQUE constraint.
 *
 *  Side effects on success (kind === 'attributed'):
 *    - INSERT into operator_attribution_events (fee + 90/10 shares)
 *    - UPSERT operator_earnings (cumulative_blurt_earned += share,
 *      total_orders_attributed += 1)
 *
 *  Part 111 — when `operator_tag !== instanceOperatorTag`:
 *    - NO DB writes at all.  Returns `attributed_other_instance`.
 *    - The op is for a different operator's instance; their
 *      indexer books its earnings.  This indexer recorded the order
 *      itself (in the orders table) for orderbook/audit purposes;
 *      only the earnings side is gated.
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

	// Insert the attribution event (audit of what this operator earned on
	// this order — the 90% was already paid to them by the split).
	try {
		await args.client.query(
			`INSERT INTO operator_attribution_events (
				operator_account, operator_tag,
				order_account, order_permlink,
				fee_blurt, operator_share_blurt, treasury_share_blurt,
				split_percent_at_event,
				trx_id, block_num, block_time_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
	} catch (err) {
		if (isUniqueViolation(err)) {
			return { kind: 'duplicate_attribution' };
		}
		throw err;
	}

	// cp408 — no relay payout is queued: the operator's 90% was paid directly
	// by the fee split at the moment the user's order cleared. This module only
	// keeps the running earnings tally the dashboard reads.
	//
	// UPSERT operator_earnings. cumulative_blurt_earned is the operator's
	// lifetime earnings; lifetime_paid_blurt mirrors it (they're paid as they
	// earn now, at source), and last_payout_at / last_payout_blurt record the
	// most recent order that paid this operator.
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
		operatorShareBlurt: operatorShareNum
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
