/**
 * Fee-attestation quorum (ADR-0011 §3) — ONE implementation, shared by the
 * `morphit_fee_attest_v1` handler (promotion at intake) and the external-fee
 * re-check job (re-derivation of already-indexed rows).
 *
 * What was wrong: the rule was "≥2 distinct attestors,
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
 * Determinism: the inputs are chain-derived rows, judged as of the newest
 * attestation's block time. The reciprocity part (Signal B) is computed from
 * the feedback rows up to that moment (signals.reciprocityEverHeld), never
 * read from the detector's table, so intake and every later re-derivation, on
 * every node, reach the same answer. The related-accounts part (Signal A) is
 * still read from its table: its inputs are chain-derived, but the periodic
 * detector can raise a pair a cycle later on one node than another, so the
 * re-check job re-derives this verdict and every instance converges.
 */

import { reciprocityEverHeld } from '$indexer/signals';

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
	const r = await db.query<{ attestor: string; as_of: Date }>(
		`SELECT DISTINCT fa.attestor,
		        (SELECT MAX(x.observed_at) FROM fee_attestations x
		          WHERE x.order_account = $1 AND x.order_permlink = $2) AS as_of
		   FROM fee_attestations fa
		  WHERE fa.order_account = $1
		    AND fa.order_permlink = $2
		    AND fa.attestor <> $1
		    AND NOT EXISTS (
		          SELECT 1 FROM related_accounts ra
		           WHERE ra.account_a = LEAST(fa.attestor, $1)
		             AND ra.account_b = GREATEST(fa.attestor, $1))`,
		[orderAccount, orderPermlink]
	);
	let n = 0;
	for (const row of r.rows) {
		const flagged = await reciprocityEverHeld(db, {
			a: row.attestor,
			b: orderAccount,
			asOf: new Date(row.as_of)
		});
		if (!flagged) n++;
	}
	return n;
}

/** True when the order's attestations currently meet the quorum. */
export async function attestationQuorumMet(
	db: Queryable,
	orderAccount: string,
	orderPermlink: string
): Promise<boolean> {
	return (await countIndependentAttestors(db, orderAccount, orderPermlink)) >= ATTESTATION_QUORUM;
}
