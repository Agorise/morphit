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
 *      AND there are ≥2 distinct attestors for this order AND at
 *      least one of them is not the order poster, update the
 *      order to fee_status='verified_by_attestation'.
 *
 * Rationale: ADR-0011 §3 specifies the two-distinct-accounts,
 * at-least-one-non-poster rule to prevent a grifter from flipping
 * their own order's fee_status via sock-puppet attestations they
 * control. The rule is checked in-handler rather than via a CHECK
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

	// Count distinct attestors + check at least one is not the
	// poster. Both in a single query using FILTER (the modern
	// Postgres way — clearer than subqueries).
	const counts = await client.query<{
		total_attestors: string; // bigint arrives as string
		non_poster_attestors: string;
	}>(
		`SELECT
		    COUNT(DISTINCT attestor) AS total_attestors,
		    COUNT(DISTINCT attestor) FILTER (WHERE attestor <> $3)
		      AS non_poster_attestors
		 FROM fee_attestations
		 WHERE order_account = $1 AND order_permlink = $2`,
		[orderAccount, orderPermlink, orderAccount]
	);
	const total = Number(counts.rows[0]!.total_attestors);
	const nonPoster = Number(counts.rows[0]!.non_poster_attestors);

	// ADR-0011 §3: ≥2 distinct accounts AND at least one
	// not-the-poster. Both conditions must hold.
	if (total >= 2 && nonPoster >= 1) {
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
