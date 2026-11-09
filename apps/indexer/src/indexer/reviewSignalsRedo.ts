/**
 * Morphit indexer — Signals B and D under the v1.23.5 rule, for flags raised
 * without it.
 *
 * From v1.23.5 Signals B (suspicious reciprocity) and D (review concentration)
 * leave a pair's proven repeat trades out of the pair's own count
 * (signals.ts, reputation/repeatTrades.ts). Their flags are sticky (ON CONFLICT
 * DO NOTHING), so a pair flagged by an older version — before this node
 * upgraded, or while it ran an older version after a rollback — would stay
 * flagged, every review between them left out, where a node that indexed the
 * same chain with v1.23.5 never raised the flag.
 *
 * The rule only ever flags less, and only where a review is proven, so only
 * those flags can be wrong: a B flag on a pair one of whose reviews of the
 * other is proven, a D flag on a reviewer one of whose reviews is proven. When
 * an older version may have raised flags (below), each such flag is dropped and its detector runs again at each
 * review time live indexing ran it (raiseReviewSignals: B at each review
 * between the two, D at each review by the reviewer), in chain order, as of
 * that time (provenTradeSql's asOf: the other review and the partner's naming
 * from by then). That reproduces exactly the flags live indexing under the
 * v1.23.5 rule raises. The operator's clearances (moderation_flag_clearances)
 * are honoured by the detectors as always. Display only: no consensus rule
 * reads these tables.
 */
import type { Database } from '$db/pool';
import { detectReviewConcentrationInTx, detectSuspiciousReciprocityInTx } from '$indexer/signals';
import { provenTradeSql } from '$indexer/reputation/repeatTrades';

/** When it is due (`indexer_state.review_signals_redo_due`: the first start
 *  of this version, and after an older one applied blocks — repeatTradesGuard
 *  sets it), else null. One transaction, which clears it: an interrupted run
 *  leaves the flags as they were and is tried again at the next start.
 *  Returns how many flags were looked at again and how many reviews that
 *  took. */
export async function redoReviewSignals(
	db: Database
): Promise<{ pairs: number; reviewers: number; reviews: number } | null> {
	const due = await db.query<{ due: boolean }>(
		`SELECT review_signals_redo_due AS due FROM indexer_state WHERE id = 1`
	);
	if (due.rows[0]?.due !== true) return null;
	return db.withTx(async (client) => {
		const pairs = await client.query<{ a: string; b: string }>(
			`SELECT s.account_a AS a, s.account_b AS b FROM suspicious_reciprocity s
			  WHERE EXISTS (
			        SELECT 1 FROM feedback f
			         WHERE ((f.reviewer = s.account_a AND f.subject = s.account_b)
			             OR (f.reviewer = s.account_b AND f.subject = s.account_a))
			           AND f.order_permlink IS NOT NULL
			           AND ${provenTradeSql('f')})`
		);
		const reviewers = await client.query<{ reviewer: string }>(
			`SELECT DISTINCT rc.reviewer FROM review_concentration rc
			  WHERE EXISTS (
			        SELECT 1 FROM feedback f
			         WHERE f.reviewer = rc.reviewer
			           AND f.order_permlink IS NOT NULL
			           AND ${provenTradeSql('f')})`
		);
		let reviews = 0;
		for (const { a, b } of pairs.rows) {
			await client.query(
				`DELETE FROM suspicious_reciprocity WHERE account_a = $1 AND account_b = $2`,
				[a, b]
			);
			const rows = await client.query<{ reviewer: string; subject: string; created_at: Date }>(
				`SELECT reviewer, subject, created_at FROM feedback
				  WHERE (reviewer = $1 AND subject = $2) OR (reviewer = $2 AND subject = $1)
				  ORDER BY created_at, id`,
				[a, b]
			);
			for (const r of rows.rows) {
				await detectSuspiciousReciprocityInTx(client, {
					asOf: r.created_at,
					pair: [r.reviewer, r.subject]
				});
				reviews++;
			}
		}
		for (const { reviewer } of reviewers.rows) {
			await client.query(`DELETE FROM review_concentration WHERE reviewer = $1`, [reviewer]);
			const rows = await client.query<{ created_at: Date }>(
				`SELECT created_at FROM feedback WHERE reviewer = $1 ORDER BY created_at, id`,
				[reviewer]
			);
			for (const r of rows.rows) {
				await detectReviewConcentrationInTx(client, { asOf: r.created_at, reviewer });
				reviews++;
			}
		}
		await client.query(`UPDATE indexer_state SET review_signals_redo_due = FALSE WHERE id = 1`);
		return { pairs: pairs.rows.length, reviewers: reviewers.rows.length, reviews };
	});
}
