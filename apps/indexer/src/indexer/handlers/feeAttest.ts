/**
 * Handler: morphit_fee_attest_v1
 *
 * Payload shape:
 *   {
 *     "order_account":  string (the poster's account),
 *     "order_permlink": string (the order's permlink)
 *   }
 *
 * Effect:
 *   1. Insert a row in fee_attestations for (order_account,
 *      order_permlink, attestor=ctx.signer).
 *   2. If the referenced order is in fee_status='pending_external'
 *      AND there are ≥2 distinct INDEPENDENT attestors for this order
 *      (never the poster; never an account flagged as a related or
 *      reciprocal pair with the poster), update the order to
 *      fee_status='verified_by_attestation'.
 *
 * Rationale: ADR-0011 §3 originally let the poster be one of the two
 * attestors. (v1.18.0 deep-deep, H1) that let the poster plus one sock
 * self-verify an unpaid order forever; the poster is now rejected
 * (`attestor_is_poster`) and the quorum lives in
 * $indexer/fee/attestationQuorum, shared with the external-fee re-check
 * job, which also re-verifies pending/attested orders against the
 * explorers and demotes them when the explorers say the payment does
 * not exist. The rule is checked in-handler rather than via a CHECK
 * constraint because it depends on row count, not column values.
 *
 * Idempotency: the UNIQUE (order_account, order_permlink, attestor)
 * constraint means the same attestor attesting the same order
 * twice returns `already_attested` rather than duplicate-counting.
 *
 * Finding I mitigation (attestor eligibility): before inserting
 * the attestation row, the handler consults
 * `checkAttestorEligibility` (see
 * apps/indexer/src/indexer/attestorEligibility.ts). An attestor
 * must meet the loyalty + age thresholds under the current
 * phase rule (OR in 'launch', AND in 'steady') or be rejected
 * with an `attestor_*` subcode. This closes the sybil path
 * where a grifter + free throwaway account would otherwise
 * self-verify their own order's fee.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { checkAttestorEligibility } from '$indexer/attestorEligibility';
import { attestationQuorumMet } from '$indexer/fee/attestationQuorum';
import { validateOrderPermlink } from '$indexer/permlink';

// Per Blurt's is_valid_account_name, account names are
// dot-separated multi-segment.  Canonicalized to match
// $api/shared.ts isAccountName — see REVISIT-LIST.md
// "C-19 follow-on consistency pass" for context.
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** SQLSTATE 23505 = unique_violation. */
function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: unknown }).code === '23505'
	);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) {
		return { ok: false, reason: 'payload_not_object' };
	}

	const orderAccount = ctx.payload.order_account;
	if (typeof orderAccount !== 'string') {
		return { ok: false, reason: 'order_account_not_string' };
	}
	if (!ACCOUNT_NAME_RE.test(orderAccount)) {
		return { ok: false, reason: 'order_account_invalid' };
	}

	const orderPermlink = ctx.payload.order_permlink;
	const permlinkFail = validateOrderPermlink(orderPermlink);
	if (permlinkFail) {
		// Map order-side codes to this handler's documented set.
		if (permlinkFail === 'permlink_not_string') {
			return { ok: false, reason: 'order_permlink_not_string' };
		}
		if (permlinkFail === 'permlink_bad_length') {
			return { ok: false, reason: 'order_permlink_too_long' };
		}
		return { ok: false, reason: 'order_permlink_invalid' };
	}

	// Verify the target order exists. A missing order isn't an
	// error — it's plausibly a race where attestation lands before
	// the indexer has applied the order op (if they're in the same
	// block, the dispatcher's order-of-application handles this;
	// but attestations in later blocks against orders that never
	// existed or were rejected are non-actionable).
	const orderRow = await client.query<{
		fee_status: string;
		account: string;
	}>(`SELECT fee_status, account FROM orders WHERE account = $1 AND permlink = $2`, [
		orderAccount,
		orderPermlink
	]);
	if (orderRow.rowCount === 0) {
		return { ok: false, reason: 'order_not_found' };
	}

	// (v1.18.0 deep-deep, H1) The poster can never attest their own order.
	// Before, the poster counted as one of the two required attestors, so the
	// poster plus ONE aged sock could flip an unpaid BTC order to
	// verified_by_attestation — for free, as often as they liked. Rejected
	// here (before any row is written) so it is visible in the event log.
	if (ctx.signer === orderAccount) {
		return { ok: false, reason: 'attestor_is_poster' };
	}

	// Finding I mitigation: attestor eligibility gate. Checks
	// loyalty + age thresholds against the current phase's rule
	// (OR gate in 'launch', AND gate in 'steady'). Runs before
	// INSERT so ineligible attestations don't land in the
	// fee_attestations table — rejected-with-reason is visible
	// in the event log, which is better than a silent row
	// that never gets counted toward quorum.
	const eligibility = await checkAttestorEligibility(
		ctx.signer,
		ctx.config.attestationPhase,
		client,
		ctx.blockTime
	);
	if (!eligibility.eligible) {
		// Four distinct rejection codes, one per EligibilityFail
		// reason. Frontends map each to a localized explanation
		// that tells the user what they're missing.
		const subCode =
			eligibility.reason === 'account_not_found'
				? 'attestor_account_not_found'
				: eligibility.reason === 'insufficient_loyalty_and_young_account'
					? 'attestor_insufficient_loyalty_and_young_account'
					: eligibility.reason === 'insufficient_loyalty'
						? 'attestor_insufficient_loyalty'
						: 'attestor_young_account';
		return { ok: false, reason: subCode };
	}

	// Insert the attestation row. A duplicate from the same
	// attestor on the same order is informational-level rejection
	// (already_attested), not an error.
	try {
		await client.query(
			`INSERT INTO fee_attestations
			   (order_account, order_permlink, attestor,
			    observed_in_block, observed_at, trx_id)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[orderAccount, orderPermlink, ctx.signer, ctx.blockNum, ctx.blockTime, ctx.trxId]
		);
	} catch (err) {
		if (isUniqueViolation(err)) {
			return { ok: false, reason: 'already_attested' };
		}
		throw err;
	}

	// Only promote if the order is currently pending_external.
	// Orders in any other state (verified, missing, etc.) keep
	// their existing state; the attestation is recorded for the
	// audit trail but has no effect.
	const currentStatus = orderRow.rows[0]!.fee_status;
	if (currentStatus !== 'pending_external') {
		return { ok: true };
	}

	// (v1.18.0 deep-deep, H1) Quorum = ≥2 attestors that are neither the
	// poster nor flagged as a related/reciprocal pair with the poster by the
	// anti-review-ring signals. One shared implementation with the external-fee
	// re-check job ($indexer/fee/attestationQuorum), so intake and re-derivation
	// can never disagree. The old rule (≥2 distinct, ≥1 non-poster) let the
	// poster be one of the two.
	if (await attestationQuorumMet(client, orderAccount, orderPermlink as string)) {
		const updated = await client.query(
			`UPDATE orders
			   SET fee_status = 'verified_by_attestation',
			       updated_at = $3
			 WHERE account = $1
			   AND permlink = $2
			   AND fee_status = 'pending_external'`,
			[orderAccount, orderPermlink, ctx.blockTime]
		);
		// Only emit if the UPDATE actually flipped a row.  A
		// no-op UPDATE (already verified, or status changed) does
		// not change orderbook visibility, so subscribers don't
		// need to know about it.
		//
		// Bumping updated_at here serves two purposes:
		//  1. The order becomes orderbook-visible at this moment;
		//     sort=recent should put it where it belongs.
		//  2. The orderbook-stream fallback poll uses
		//     `o.updated_at > cutoff` to find recently-changed
		//     rows.  Without this bump, fee_status flips would
		//     be invisible to the poll if the bus emit got
		//     dropped (F-7 audit fix).
		if ((updated.rowCount ?? 0) > 0) {
			ctx.recordOrderbookChange(`${orderAccount}/${orderPermlink}`);
		}
	}

	return { ok: true };
};

export default handle;
