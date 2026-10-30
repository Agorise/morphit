/**
 * Morphit indexer — the anti-review-ring verdicts consensus code may use.
 *
 * The detectors in signals.ts write flag tables (related_accounts,
 * suspicious_reciprocity, one_way_pile_on, review_concentration,
 * trade_concentration) for reputation DISPLAY. Those tables are not a pure
 * function of the chain: an operator's local clearances
 * (moderation_flag_clearances, never exported) keep pairs out of them, Signal A
 * also skips this node's own relay (a local setting), and Signal A runs on this
 * node's own hourly timer. Two nodes fed the same blocks can hold different
 * rows.
 *
 * Anything that decides chain-derived state (an op applied or rejected, an
 * order's fee_status) must reach the same answer on every node, so it asks the
 * functions below instead. Each reads ONLY rows that every node derives
 * identically from the chain (feedback, accounts, operators), bounded by a
 * moment taken from the chain (a block time, a block number), and never a
 * flag table, a clearance, this node's settings or the wall clock. The
 * consensus-flag-table guard test (test/indexer/consensusFlagTableGuard.test.ts)
 * fails if this file, or any module the op handlers reach, starts reading one.
 */

import type pg from 'pg';
import { RESERVED_ACCOUNT_NAMES } from '$indexer/confusables';

/** Minimum reviews in each direction to trigger Signal B. */
export const SIGNAL_B_MIN_COUNT = 3;
/** Minimum average rating to consider a review cluster "high-star." */
export const SIGNAL_B_MIN_AVG_RATING = 4.8;
/** Time window for the reciprocity check (ADR-0009 §5). */
export const SIGNAL_B_WINDOW_DAYS = 7;

/** Temporal-proximity window for Signal A. Two accounts created by the same
 *  creator whose first Morphit activities fall within this window are related. */
export const SIGNAL_A_PROXIMITY_MINUTES = 5;

/**
 * Creators whose accounts are never "related" by Signal A, whatever their
 * timing, besides every REGISTERED operator account: the project's reserved
 * accounts. Each instance's relay creates its users' accounts, so "same
 * creator" there means "signed up through the same instance", not "same
 * person". The federation requires an instance's relay account to BE its
 * registered operator account, except the canonical instance, whose operator
 * and relay accounts are both reserved names (federationProbe.ts) — which is
 * why the reserved names are here. A constant, the same on every node.
 */
export const SIGNAL_A_EXEMPT_RESERVED_CREATORS: readonly string[] = RESERVED_ACCOUNT_NAMES;

/** The minimal read surface (a PoolClient inside a handler, the pool outside). */
export interface Queryable {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pg.QueryResult<R>>;
}

/**
 * Did the Signal B pattern (suspicious reciprocity) EVER hold for the pair
 * (a, b) at or before `asOf`? Evaluated over the 7-day window ending at each of
 * the pair's own review times up to `asOf` — the moments the pattern can come
 * into being — from the chain-derived feedback rows alone.
 *
 * `before: true` takes only reviews stamped strictly BEFORE `asOf`, i.e. from
 * earlier blocks. The fee-attestation quorum (from the consensus activation
 * time) uses it: judged as of an attestation's block, a review in that same
 * block may be applied before the attestation or after it, so the verdict at
 * intake and the verdict the re-check job reaches later would differ.
 *
 * This is what the consensus gates use (the verified-chat bar for reviews and
 * order-complete counterparties, and the fee-attestation quorum): the same
 * answer on every node for the same chain history, whenever it is asked, and
 * independent of an operator's local clearances.
 */
export async function reciprocityEverHeld(
	db: Queryable,
	args: { a: string; b: string; asOf: Date; before?: boolean }
): Promise<boolean> {
	if (args.a === args.b) return false;
	const upTo = args.before === true ? 'created_at < $3' : 'created_at <= $3';
	const r = await db.query<{ held: boolean }>(
		`WITH moments AS (
		   SELECT DISTINCT created_at AS t FROM feedback
		    WHERE ((reviewer = $1 AND subject = $2) OR (reviewer = $2 AND subject = $1))
		      AND ${upTo}
		 )
		 SELECT EXISTS (
		   SELECT 1 FROM moments m
		    CROSS JOIN LATERAL (
		      SELECT
		        COUNT(*) FILTER (WHERE f.reviewer = $1 AND f.subject = $2) AS ab,
		        COUNT(*) FILTER (WHERE f.reviewer = $2 AND f.subject = $1) AS ba,
		        AVG(f.rating) FILTER (WHERE f.reviewer = $1 AND f.subject = $2) AS ab_avg,
		        AVG(f.rating) FILTER (WHERE f.reviewer = $2 AND f.subject = $1) AS ba_avg,
		        COUNT(DISTINCT f.subject) FILTER (WHERE f.reviewer = $1) AS a_subjects,
		        COUNT(DISTINCT f.subject) FILTER (WHERE f.reviewer = $2) AS b_subjects
		        FROM feedback f
		       WHERE f.reviewer IN ($1, $2)
		         AND f.created_at > m.t - INTERVAL '${SIGNAL_B_WINDOW_DAYS} days'
		         AND f.created_at <= m.t
		    ) w
		    WHERE w.ab >= $4 AND w.ba >= $4
		      AND w.ab_avg::NUMERIC(3,2) >= $5 AND w.ba_avg::NUMERIC(3,2) >= $5
		      AND w.a_subjects = 1 AND w.b_subjects = 1
		 ) AS held`,
		[args.a, args.b, args.asOf, SIGNAL_B_MIN_COUNT, SIGNAL_B_MIN_AVG_RATING]
	);
	return r.rows[0]?.held === true;
}

/**
 * Are a and b related by Signal A as of a point on the chain — from
 * chain-derived rows only (accounts, ops, operators)?
 *
 * Related means, as the detector (signals.detectRelatedAccounts) decides it:
 *   - both were created by the same creator (accounts.creator, written from
 *     the account-create op);
 *   - both have a first Morphit activity at or before `asOf`, at most
 *     SIGNAL_A_PROXIMITY_MINUTES apart;
 *   - the creator is not exempt (below).
 *
 * First activity: the block time of the account's first APPLIED op in the
 * event log (`ops`) — what accounts.first_activity_at, the detector's input,
 * records when the dispatcher applies it. Not that column itself: the jobs
 * that re-judge stored ops (reconcileUpgrade, reconcileRegistrations,
 * blurtFeeReverify) flip an op between rejected and applied without touching
 * it, so on a node that went through one it can differ from a node that
 * replayed the same blocks, while `ops` ends the same on both.
 *
 * `aActiveAt`: the block time of an applied op `a` signed (the fee-attestation
 * quorum passes the attestor's own attestation). An op reaches the event log
 * just AFTER it is applied, so while it is being judged it is not there yet;
 * this stands in for it (it is a's first op when a has no earlier one), so the
 * answer while the op is judged and every later one agree.
 *
 * Exempt creators: every account whose operator registration was accepted in
 * a block BEFORE `asOfBlock` (operators.registered_in_block — never the
 * wall-clock registered_at column; strictly before, since a registration in
 * the same block may be applied after the op being judged), the reserved
 * accounts (SIGNAL_A_EXEMPT_RESERVED_CREATORS), and '' — the placeholder
 * creator of a row the first-buy waiver or welcome-bonus claim inserts for an
 * account created before indexing began, whose real creator is unknown; two
 * such accounts share no creator.
 *
 * Unlike the detector this reads no clearance and no `excludeCreators` (this
 * node's own relay setting): those are this node's view, not the chain's.
 *
 * Since an account's creator and first activity do not change, "the pattern
 * ever held up to the point" and "it holds at the point" coincide, except the
 * exemption, which is judged at the point: a relay is a relay even for the
 * users it created before it registered (the reason the detector excludes
 * this node's own relay before registration).
 */
export async function relatedEverHeld(
	db: Queryable,
	args: { a: string; b: string; asOf: Date; asOfBlock: number; aActiveAt?: Date }
): Promise<boolean> {
	if (args.a === args.b) return false;
	const r = await db.query<{ held: boolean }>(
		`WITH first_op AS (
		   SELECT n.name,
		          (SELECT o.block_time FROM ops o
		            WHERE o.signer = n.name AND o.status = 'applied'
		            ORDER BY o.block_num, o.trx_in_block, o.op_in_trx
		            LIMIT 1) AS t
		     FROM (VALUES ($1::text), ($2::text)) AS n(name)
		 )
		 SELECT EXISTS (
		   SELECT 1 FROM accounts x
		     JOIN accounts y ON y.creator = x.creator
		     JOIN first_op fx ON fx.name = x.name
		     JOIN first_op fy ON fy.name = y.name
		     CROSS JOIN LATERAL (SELECT COALESCE(fx.t, $7::timestamptz) AS t) xa
		    WHERE x.name = $1 AND y.name = $2
		      AND x.creator <> ''
		      AND x.creator <> ALL($5::text[])
		      AND xa.t <= $3 AND fy.t <= $3
		      AND ABS(EXTRACT(EPOCH FROM (fy.t - xa.t))) <= $4
		      AND NOT EXISTS (
		            SELECT 1 FROM operators o
		             WHERE o.account = x.creator AND o.registered_in_block < $6::bigint)
		 ) AS held`,
		[
			args.a,
			args.b,
			args.asOf,
			SIGNAL_A_PROXIMITY_MINUTES * 60,
			SIGNAL_A_EXEMPT_RESERVED_CREATORS,
			args.asOfBlock,
			args.aActiveAt ?? null
		]
	);
	return r.rows[0]?.held === true;
}
