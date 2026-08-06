/**
 * Morphit indexer — attestor eligibility helper.
 *
 * Finding I mitigation: the fee-attestation system (ADR-0011
 * §3) requires ≥2 distinct attestors to promote a
 * pending_external order to verified_by_attestation. Without
 * further gating, a grifter with a free throwaway account
 * can trivially self-verify.
 *
 * This module computes whether a given account is eligible to
 * attest based on two signals:
 *   - Loyalty: cumulative BLURT fees paid to Morphit (proxy
 *     for skin-in-the-game).
 *   - Age: days the account has existed on the Blurt chain
 *     (proxy for not being farmed specifically for the
 *     attack).
 *
 * Two-phase rollout controlled by config:
 *   - 'launch' — OR gate. Either loyalty OR age qualifies.
 *     Runs during ecosystem bootstrap when most accounts are
 *     too new to satisfy both.
 *   - 'steady' — AND gate. Both loyalty AND age required.
 *     Hard mode; attacker needs BOTH $20+ in BLURT fees per
 *     sock AND 30 days of patient aging per sock — sustained
 *     abuse becomes negative-ROI.
 *
 * The helper is used by both the feeAttest handler (to reject
 * ineligible attestations at intake) and the
 * /v1/attestor-eligibility endpoint (to let the frontend
 * pre-check before showing an attest button).
 */

import type pg from 'pg';

/** Minimum cumulative BLURT fees paid to count toward the
 *  loyalty threshold. Matches the first loyalty milestone. */
export const ATTESTOR_LOYALTY_THRESHOLD_BLURT = 100;

/** Minimum account age in days to count toward the age
 *  threshold. Per Finding I design — short enough that
 *  committed long-term users aren't penalized, long enough
 *  that a farm-now-attest-tomorrow strategy doesn't work. */
export const ATTESTOR_AGE_THRESHOLD_DAYS = 30;

/** Milliseconds in a day. Used for age arithmetic. */
const DAY_MS = 24 * 60 * 60 * 1000;

export type AttestationPhase = 'launch' | 'steady';

/** Minimal shape the helper needs — accepts both a
 *  PoolClient (inside handler transactions) and a Database
 *  (for API endpoints reading outside transactions). Both
 *  expose a structurally-compatible `query` method. */
interface Queryable {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pg.QueryResult<R>>;
}

export interface EligibilityOk {
	readonly eligible: true;
	/** Which condition(s) qualified. In 'launch' this tells
	 *  the frontend which gate the user cleared; in 'steady'
	 *  it's always 'both'. */
	readonly reason: 'loyalty' | 'age' | 'both';
	readonly loyaltyBlurt: number;
	readonly ageDays: number;
}

export interface EligibilityFail {
	readonly eligible: false;
	/** Human-meaningful failure code the UI can translate. */
	readonly reason:
		| 'insufficient_loyalty_and_young_account'
		| 'insufficient_loyalty'
		| 'young_account'
		| 'account_not_found';
	/** Current cumulative BLURT the account has paid. 0 if
	 *  no loyalty row exists yet. */
	readonly loyaltyBlurt: number;
	/** Current account age in days. 0 if accounts row missing. */
	readonly ageDays: number;
	/** BLURT still needed to reach the loyalty threshold, or 0
	 *  if already met. */
	readonly missingLoyaltyBlurt: number;
	/** Days still needed until age threshold, or 0 if met, or
	 *  null when accounts row is missing. */
	readonly daysUntilEligible: number | null;
}

export type EligibilityResult = EligibilityOk | EligibilityFail;

/**
 * Compute the eligibility result for an account, applying the
 * launch-vs-steady gate rule.
 *
 * @param account The account whose eligibility is being
 *                checked (the would-be attestor).
 * @param phase   'launch' (OR gate) or 'steady' (AND gate).
 * @param db      Anything with a .query method — a Pool for
 *                API endpoints, a PoolClient inside a handler
 *                transaction.
 * @param now     The reference time. Handlers pass
 *                `ctx.blockTime` for deterministic
 *                replay-friendly results; API endpoints pass
 *                `new Date()`.
 */
export async function checkAttestorEligibility(
	account: string,
	phase: AttestationPhase,
	db: Queryable,
	now: Date
): Promise<EligibilityResult> {
	// Fetch both data points in one round-trip. LEFT JOIN so a
	// missing account_loyalty row (account has never paid a
	// fee) yields cumulative_blurt_paid = NULL → treated as 0.
	const result = await db.query<{
		created_block_time: Date | null;
		cumulative_blurt_paid: string | null;
	}>(
		`SELECT
		   a.created_block_time,
		   al.cumulative_blurt_paid
		 FROM accounts a
		 LEFT JOIN account_loyalty al ON al.account = a.name
		 WHERE a.name = $1`,
		[account]
	);

	if (result.rowCount === 0) {
		// Account not known to the indexer. This can happen
		// for accounts that exist on chain but the indexer
		// hasn't observed any relevant op for. Without a
		// created_block_time we can't compute age — treat as
		// ineligible with a distinct reason so the frontend
		// can message appropriately.
		return {
			eligible: false,
			reason: 'account_not_found',
			loyaltyBlurt: 0,
			ageDays: 0,
			missingLoyaltyBlurt: ATTESTOR_LOYALTY_THRESHOLD_BLURT,
			daysUntilEligible: null
		};
	}

	const row = result.rows[0]!;
	const loyaltyBlurt = Number(row.cumulative_blurt_paid ?? '0');
	const ageDays =
		row.created_block_time === null
			? 0
			: (now.getTime() - row.created_block_time.getTime()) / DAY_MS;

	const hasLoyalty = loyaltyBlurt >= ATTESTOR_LOYALTY_THRESHOLD_BLURT;
	const hasAge = ageDays >= ATTESTOR_AGE_THRESHOLD_DAYS;

	const passesGate = phase === 'launch' ? hasLoyalty || hasAge : hasLoyalty && hasAge;

	if (passesGate) {
		const reason: EligibilityOk['reason'] =
			hasLoyalty && hasAge ? 'both' : hasLoyalty ? 'loyalty' : 'age';
		return {
			eligible: true,
			reason,
			loyaltyBlurt,
			ageDays
		};
	}

	// Failed. Distinguish which gate(s) the account missed so
	// the UI can say "you need X" rather than just "no".
	const missingLoyaltyBlurt = hasLoyalty ? 0 : ATTESTOR_LOYALTY_THRESHOLD_BLURT - loyaltyBlurt;
	const daysUntilEligible = hasAge
		? 0
		: Math.max(0, Math.ceil(ATTESTOR_AGE_THRESHOLD_DAYS - ageDays));

	const failReason: EligibilityFail['reason'] =
		!hasLoyalty && !hasAge
			? 'insufficient_loyalty_and_young_account'
			: !hasLoyalty
				? 'insufficient_loyalty'
				: 'young_account';

	return {
		eligible: false,
		reason: failReason,
		loyaltyBlurt,
		ageDays,
		missingLoyaltyBlurt,
		daysUntilEligible
	};
}
