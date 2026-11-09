/**
 * Morphit indexer — repeat trades between the same two people (v1.23.5).
 *
 * Until v1.23.5 only a reviewer's LATEST order-bound review of a trader counted
 * toward that trader's rating: a counterparty used to file a 1★ review per
 * paid order the victim ever posted. Two people who really trade with each
 * other again and again were therefore worth one review to each other, however
 * many trades they did. Now an earlier review counts too, at REPEAT_TRADE_WEIGHT
 * (half a new partner's), when the trade it reviews is PROVEN and it is SPACED:
 *
 *   PROVEN (provenTradeSql) — both of them reviewed each other citing that
 *   order's permlink, both reviews were admitted on the strength of the SAME
 *   order (`feedback.order_account`, recorded when each review is applied: the
 *   citation rule's first choice, reviewCitation.ts), and that order was
 *   completed naming the other, both reviews within
 *   REPEAT_TRADE_PROOF_WINDOW_HOURS of the completion. The admitting order is
 *   one whose listing fee was paid (or a proven first-buy waiver), so every
 *   proven trade costs a real listing: a second order under the same permlink,
 *   posted without a fee and completed naming the partner, proves nothing, and
 *   neither does naming a partner on an order completed long ago (G7). Nobody
 *   types a name for this: it follows from the two reviews and the completion.
 *   Worked out from the chain-derived rows (feedback, orders) whenever it is
 *   needed, never stored.
 *
 *   SPACED — walking the reviewer's order-bound reviews of that trader in
 *   (created_at, id) order, a review is spaced when it is proven and comes at
 *   least REPEAT_TRADE_SPACING_HOURS after the last spaced one (the first
 *   proven one is spaced; an unproven one uses up nothing). An earlier review
 *   counts only if it is spaced and also that long before the reviewer's
 *   latest review of the trader (which always counts fully, as before), so the
 *   reviews that count are always that far apart.
 *
 * What each review weighs is stored (`feedback.review_weight`, display only:
 * no consensus rule reads it) so the rating aggregates read one column. It is
 * a pure function of the pair's reviews and orders, worked out again for the
 * pair whenever a review of it arrives or a completion names one of them
 * (rewalkPairsOfTrade) — the only events that change those rows — and for
 * every pair when the indexer starts (rewalkAllPairs: the reviews indexed
 * before v1.23.5, any an older version wrote after a rollback, any walk that
 * failed). So every node holds the same weights for the same chain.
 *
 * Signals B (suspicious reciprocity) and D (review concentration) leave a
 * pair's proven reviews out of the pair's own count, and so does the review
 * gate's ring check from the v1.23.5 activation time (signals.ts,
 * signalVerdicts.ts): two people who trade with each other often are what
 * those checks would otherwise catch. A review of a third party still counts
 * as the reviewer's other activity, as before.
 */
import type { Queryable } from '$indexer/signalVerdicts';
import { citationCandidatesSql } from '$indexer/reviewCitation';
import {
	CONSENSUS_V2_ACTIVATION_TIME,
	CONSENSUS_V3_ACTIVATION_TIME
} from '$indexer/consensusActivation';

/** Hours between two counted reviews of the same trader by the same reviewer
 *  (3 days; hours, so a database time zone with daylight saving cannot make it
 *  71 or 73). */
export const REPEAT_TRADE_SPACING_HOURS = 72;
/** Both reviews of a proven trade come within this many hours of the order's
 *  completion, before or after it (7 days). */
export const REPEAT_TRADE_PROOF_WINDOW_HOURS = 168;
/** What a counted earlier review weighs, against 1 for the reviewer's latest. */
export const REPEAT_TRADE_WEIGHT = 0.5;

const SPACING_MS = REPEAT_TRADE_SPACING_HOURS * 3_600_000;

/**
 * SQL: the order-bound review aliased `f` reviews a PROVEN trade (see the
 * header). Reads only chain-derived rows (feedback, orders). `f` must have a
 * non-null order_permlink. (A partner is only ever named on an order as it is
 * completed or after, and completed is final, so a named partner means a
 * completed order; the window is false for an order without a completion
 * time, and a review without a recorded order_account proves nothing.)
 *
 *   asOf  — an SQL expression (a placeholder or a column): count only the
 *           other review, and a partner named, at or before it — what the
 *           chain held then. (A naming time not recorded yet counts as the
 *           completion's: live, every name the database holds was given by
 *           the block being judged, so the verdict never depends on it.)
 *   since — an SQL expression: both reviews must be stamped at or after it.
 *           The review gate passes the v1.23.5 activation time, so its verdict
 *           never rests on an order_account another node may have worked out
 *           at start rather than recorded live.
 */
export function provenTradeSql(f: string, opts: { asOf?: string; since?: string } = {}): string {
	const w = `INTERVAL '${REPEAT_TRADE_PROOF_WINDOW_HOURS} hours'`;
	const asOf =
		opts.asOf === undefined
			? ''
			: `
	             AND pt_g.created_at <= ${opts.asOf}
	             AND COALESCE(pt_o.counterparty_named_at, pt_o.completed_at) <= ${opts.asOf}`;
	const since =
		opts.since === undefined
			? ''
			: `
	             AND ${f}.created_at >= ${opts.since}
	             AND pt_g.created_at >= ${opts.since}`;
	return `EXISTS (
	          SELECT 1 FROM feedback pt_g
	            JOIN orders pt_o
	              ON pt_o.permlink = ${f}.order_permlink
	             AND pt_o.account = ${f}.order_account
	             AND pt_o.completed_counterparty =
	                 (CASE WHEN pt_o.account = ${f}.reviewer THEN ${f}.subject ELSE ${f}.reviewer END)
	           WHERE pt_g.reviewer = ${f}.subject
	             AND pt_g.subject = ${f}.reviewer
	             AND pt_g.order_permlink = ${f}.order_permlink
	             AND pt_g.order_account = ${f}.order_account${asOf}${since}
	             AND ${f}.created_at BETWEEN pt_o.completed_at - ${w} AND pt_o.completed_at + ${w}
	             AND pt_g.created_at BETWEEN pt_o.completed_at - ${w} AND pt_o.completed_at + ${w})`;
}

type WalkRow = {
	id: string;
	reviewer: string;
	subject: string;
	created_at: Date;
	review_weight: number | null;
	proven: boolean;
};

/** The weights of one (reviewer, subject)'s order-bound reviews, given in
 *  (created_at, id) order (see the header). PURE. */
export function pairWeights(rows: readonly { created_at: Date; proven: boolean }[]): number[] {
	const n = rows.length;
	if (n === 0) return [];
	const latestMs = rows[n - 1]!.created_at.getTime();
	const out: number[] = [];
	let last: number | null = null;
	for (let i = 0; i < n; i++) {
		const t = rows[i]!.created_at.getTime();
		const spaced = rows[i]!.proven && (last === null || t - last >= SPACING_MS);
		if (spaced) last = t;
		out.push(i === n - 1 ? 1 : spaced && latestMs >= t + SPACING_MS ? REPEAT_TRADE_WEIGHT : 0);
	}
	return out;
}

/** Store the weights of rows (grouped by pair, each pair in (created_at, id)
 *  order) that changed. Returns how many rows changed. */
async function storeWeights(db: Queryable, rows: readonly WalkRow[]): Promise<number> {
	const ids: string[] = [];
	const ws: number[] = [];
	let start = 0;
	for (let i = 1; i <= rows.length; i++) {
		const a = rows[start]!;
		const b = rows[i];
		if (b !== undefined && b.reviewer === a.reviewer && b.subject === a.subject) continue;
		const group = rows.slice(start, i);
		pairWeights(group).forEach((w, k) => {
			const row = group[k]!;
			if (row.review_weight === null || Number(row.review_weight) !== w) {
				ids.push(row.id);
				ws.push(w);
			}
		});
		start = i;
	}
	for (let i = 0; i < ids.length; i += 5000) {
		await db.query(
			`UPDATE feedback f SET review_weight = u.w
			   FROM unnest($1::bigint[], $2::real[]) AS u(id, w)
			  WHERE f.id = u.id`,
			[ids.slice(i, i + 5000), ws.slice(i, i + 5000)]
		);
	}
	return ids.length;
}

const WALK_SELECT = `SELECT f.id::text AS id, f.reviewer, f.subject, f.created_at, f.review_weight,
	        ${provenTradeSql('f')} AS proven
	   FROM feedback f`;

/** Work out and store the weights of `reviewer`'s order-bound reviews of
 *  `subject`. Returns how many rows changed. */
export async function rewalkRepeatSpacing(
	db: Queryable,
	reviewer: string,
	subject: string
): Promise<number> {
	const r = await db.query<WalkRow>(
		`${WALK_SELECT}
		  WHERE f.reviewer = $1 AND f.subject = $2 AND f.order_permlink IS NOT NULL
		  ORDER BY f.created_at, f.id`,
		[reviewer, subject]
	);
	return storeWeights(db, r.rows);
}

/** Both directions of the pair (a, b): a review or a completion can prove the
 *  trade for the other one's review too. */
export async function rewalkPairsOfTrade(db: Queryable, a: string, b: string): Promise<void> {
	await rewalkRepeatSpacing(db, a, b);
	await rewalkRepeatSpacing(db, b, a);
}

/** At start: the weights of every order-bound review, in one read. Returns
 *  how many rows changed (0 when every stored weight already holds). */
export async function rewalkAllPairs(db: Queryable): Promise<number> {
	const r = await db.query<WalkRow>(
		`${WALK_SELECT}
		  WHERE f.order_permlink IS NOT NULL
		  ORDER BY f.reviewer, f.subject, f.created_at, f.id`
	);
	return storeWeights(db, r.rows);
}

/**
 * At start: `order_account` for every order-bound review without one — the
 * reviews indexed before v1.23.5, and any an older version wrote after a
 * rollback — by the citation rule itself (citationCandidatesSql, with the
 * review's own time, and the pair rule as the handler applies it from the
 * consensus v2 activation time). A review no order admits any more keeps NULL
 * and proves nothing. Only reviews from before the v1.23.5 activation time:
 * every later one was recorded live by v1.23.5 or later on every node
 * (repeatTradesGuard.ts), and the review gate reads those, so what was
 * recorded then — none included — is final. Returns how many rows it set.
 */
export async function healOrderAccounts(db: Queryable): Promise<number> {
	const r = await db.query(
		`UPDATE feedback f
		    SET order_account = s.owner
		   FROM (SELECT g.id,
		                (SELECT c.owner FROM (${citationCandidatesSql({
											subject: 'g.subject',
											permlink: 'g.order_permlink',
											reviewer: 'g.reviewer',
											pairBound: `(g.created_at >= '${CONSENSUS_V2_ACTIVATION_TIME}'::timestamptz)`,
											asOf: 'g.created_at',
											pinOnly: true
										})}
		                        LIMIT 1) c) AS owner
		           FROM feedback g
		          WHERE g.order_permlink IS NOT NULL AND g.order_account IS NULL
		            AND g.created_at < '${CONSENSUS_V3_ACTIVATION_TIME}'::timestamptz) s
		  WHERE f.id = s.id AND s.owner IS NOT NULL`
	);
	return (r as { rowCount?: number | null }).rowCount ?? 0;
}

/**
 * At start, before any block is applied: when each order's partner was named
 * (`orders.counterparty_named_at`), for every order with a partner and no
 * time — the orders completed before v1.23.5, or by an older version after a
 * rollback — from the latest applied completion op of that order naming that
 * partner (the one that recorded it: a later one is refused), else the
 * completion time. Returns how many orders it set.
 */
export async function healNamingTimes(db: Queryable): Promise<number> {
	const r = await db.query(
		`UPDATE orders o
		    SET counterparty_named_at = COALESCE(
		          (SELECT MAX(x.block_time) FROM ops x
		            WHERE x.signer = o.account
		              AND x.op_id = 'morphit_order_complete_v1'
		              AND x.status = 'applied'
		              AND x.payload->>'permlink' = o.permlink
		              AND x.payload->>'counterparty' = o.completed_counterparty),
		          o.completed_at)
		  WHERE o.completed_counterparty IS NOT NULL
		    AND o.counterparty_named_at IS NULL`
	);
	return (r as { rowCount?: number | null }).rowCount ?? 0;
}
