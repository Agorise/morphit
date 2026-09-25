/**
 * Fee-attestation quorum (ADR-0011 §3) — ONE implementation, shared by the
 * `morphit_fee_attest_v1` handler (promotion at intake) and the external-fee
 * re-check job (re-derivation of already-indexed rows).
 *
 * (v1.18.0 deep-deep, H1) What was wrong: the rule was "≥2 distinct attestors,
 * at least one of them not the poster". The POSTER therefore counted as one of
 * the two, so a poster plus a single aged sock could flip their own unpaid BTC
 * order to `verified_by_attestation`, and do it again forever with the same
 * two accounts. The rule is now:
 *
 *   ≥ ATTESTATION_QUORUM distinct attestors, where an attestor counts only if
 *     - it is NOT the poster, and
 *     - it is not flagged as a related / reciprocal pair WITH the poster by the
 *       anti-review-ring signals (`related_accounts`, Signal A;
 *       `suspicious_reciprocity`, Signal B).
 *
 * The attestor's own eligibility (loyalty / age) is still checked when the
 * attestation is recorded (attestorEligibility.ts); rejected attestations never
 * reach `fee_attestations`, so they cannot count here.
 *
 * Determinism: the inputs are chain-derived rows (attestations; the signal
 * tables, which the indexer derives from indexed chain data). A signal flag can
 * appear on one instance a signal-cycle before another, so the re-check job
 * re-derives this verdict periodically and every instance converges on the
 * same answer from the same chain data.
 */

/** Minimal query surface (PoolClient inside a handler, Database outside). */
interface Queryable {
	query<R extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<import('pg').QueryResult<R>>;
}

/** Independent (non-poster, non-flagged) attestors required for promotion. */
export const ATTESTATION_QUORUM = 2;

/** Count the attestors on an order that count toward the quorum. */
export async function countIndependentAttestors(
	db: Queryable,
	orderAccount: string,
	orderPermlink: string
): Promise<number> {
	const r = await db.query<{ n: string }>(
		`SELECT COUNT(DISTINCT fa.attestor)::text AS n
		   FROM fee_attestations fa
		  WHERE fa.order_account = $1
		    AND fa.order_permlink = $2
		    AND fa.attestor <> $1
		    AND NOT EXISTS (
		          SELECT 1 FROM related_accounts ra
		           WHERE ra.account_a = LEAST(fa.attestor, $1)
		             AND ra.account_b = GREATEST(fa.attestor, $1))
		    AND NOT EXISTS (
		          SELECT 1 FROM suspicious_reciprocity sr
		           WHERE sr.account_a = LEAST(fa.attestor, $1)
		             AND sr.account_b = GREATEST(fa.attestor, $1))`,
		[orderAccount, orderPermlink]
	);
	return Number(r.rows[0]?.n ?? '0');
}

/** True when the order's attestations currently meet the quorum. */
export async function attestationQuorumMet(
	db: Queryable,
	orderAccount: string,
	orderPermlink: string
): Promise<boolean> {
	return (await countIndependentAttestors(db, orderAccount, orderPermlink)) >= ATTESTATION_QUORUM;
}
