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
 *     - it is not a related pair WITH the poster (Signal A: same creator,
 *       first Morphit activity minutes apart), and
 *     - it is not a reciprocal pair with the poster (Signal B: mutual
 *       five-star reviews and nobody else).
 *
 * The attestor's own eligibility (loyalty / age) is still checked when the
 * attestation is recorded (attestorEligibility.ts); rejected attestations never
 * reach `fee_attestations`, so they cannot count here.
 *
 * Determinism. Every node, at intake and at every later re-derivation, must
 * reach the same count, so it is judged as of the NEWEST attestation of the
 * order (its block time and block number, both chain data) from chain-derived
 * rows only. A row written in that same block AFTER the attestation op is
 * invisible at intake but visible to the re-check job, so nothing may depend
 * on one:
 *   - Signal A: signalVerdicts.relatedEverHeld — accounts (creator), the
 *     event log (first applied op) and operators (registration block). Never
 *     the detector's `related_accounts` table, which this node's clearances,
 *     its own relay setting and its timer shape. An operator registration
 *     counts from the next block. The attestor's own attestation stands in
 *     for its first op while that is not logged yet (an attestation that is
 *     the account's first Morphit op); the poster's order op is logged by the
 *     time its order exists.
 *   - Signal B: signalVerdicts.reciprocityEverHeld over the feedback rows of
 *     earlier blocks only (`before`).
 *
 * Activation. That rule applies when the newest attestation is in a block
 * stamped at or after CONSENSUS_V2_ACTIVATION_TIME. An order whose newest
 * attestation is older is counted as it always was (attestationQuorumLegacy.ts:
 * `related_accounts`, and reviews up to and including that block), so history
 * keeps the verdicts every node already recorded.
 */

import { consensusV2Active } from '$indexer/consensusActivation';
import { legacyCountIndependentAttestors } from '$indexer/fee/attestationQuorumLegacy';
import { reciprocityEverHeld, relatedEverHeld } from '$indexer/signalVerdicts';

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
	// The newest attestation of the order: its block time and number. Block
	// times only grow with block numbers, so the two maxima are one block's.
	const newest = await db.query<{ as_of: Date | null; as_of_block: string | null }>(
		`SELECT MAX(observed_at) AS as_of, MAX(observed_in_block)::text AS as_of_block
		   FROM fee_attestations
		  WHERE order_account = $1 AND order_permlink = $2`,
		[orderAccount, orderPermlink]
	);
	const row = newest.rows[0];
	if (row === undefined || row.as_of === null || row.as_of_block === null) return 0;
	// The newest attestation's block time picks the rule (consensusActivation).
	const newestAttestationTime = new Date(row.as_of);
	if (!consensusV2Active(newestAttestationTime)) {
		return legacyCountIndependentAttestors(db, orderAccount, orderPermlink);
	}
	const asOf = newestAttestationTime;
	const asOfBlock = Number(row.as_of_block);
	// One row per attestor (UNIQUE (order_account, order_permlink, attestor)).
	const attestors = await db.query<{ attestor: string; observed_at: Date }>(
		`SELECT attestor, observed_at FROM fee_attestations
		  WHERE order_account = $1 AND order_permlink = $2 AND attestor <> $1
		  ORDER BY attestor`,
		[orderAccount, orderPermlink]
	);
	let n = 0;
	for (const { attestor, observed_at } of attestors.rows) {
		const pair = { a: attestor, b: orderAccount };
		const aActiveAt = new Date(observed_at);
		if (await relatedEverHeld(db, { ...pair, asOf, asOfBlock, aActiveAt })) continue;
		if (await reciprocityEverHeld(db, { ...pair, asOf, before: true })) continue;
		n++;
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
