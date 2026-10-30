/**
 * The fee-attestation quorum count as it was before CONSENSUS_V2_ACTIVATION_TIME
 * — kept, unchanged, so orders whose newest attestation is in an earlier block
 * keep the verdict every node already recorded. attestationQuorum.ts calls it
 * for those orders only.
 *
 * Why it is not used from the activation time on: it reads `related_accounts`,
 * the Signal A detector's output, which is this node's view and not a pure
 * function of the chain (the operator's local clearances keep pairs out of it,
 * the detector skips this node's own relay, and it runs on this node's timer).
 * Two nodes could disagree on whether an attestor is related to the poster, and
 * so on an order's fee_status. The current rule is in attestationQuorum.ts.
 *
 * This is the only consensus module allowed to read a detector table; the
 * consensus-flag-table guard test lists it by name.
 */

import { reciprocityEverHeld } from '$indexer/signalVerdicts';

/** Minimal query surface (PoolClient inside a handler, Database outside). */
interface Queryable {
	query<R extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<import('pg').QueryResult<R>>;
}

/** Attestors that count, by the pre-activation rule: not the poster, not in
 *  `related_accounts` with the poster, and not a reciprocal pair with the
 *  poster as of the newest attestation's block time. */
export async function legacyCountIndependentAttestors(
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
