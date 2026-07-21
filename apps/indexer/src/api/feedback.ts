/**
 * Morphit indexer — /v1/accounts/:account/feedback endpoint.
 *
 * Returns feedback *about* the subject (account in path), plus:
 *   - a summary: count, weighted rating, rating histogram
 *   - per-feedback responses (the subject's replies to reviews)
 *
 * Three SQL queries in parallel for one response:
 *   1. summary (count, avg, histogram)
 *   2. feedback page (with cursor + limit)
 *   3. responses for that page's feedback ids
 *
 * Step 3 runs after step 2 because it depends on the ids. Step 1
 * and 2 could run in parallel, but in practice the latency is
 * dominated by the roundtrip, not the query, so the sequential
 * two-shot is simpler and slightly more Postgres-friendly (the
 * planner sees them distinctly).
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Database } from '$db/pool';
import { decodeCursor, encodeCursor, errorBody, isAccountName } from '$api/shared';
import { FEEDBACK_EXCLUSIONS_SQL } from '$api/reputationJoin';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
	cursor: z.string().min(1).max(512).optional()
});

interface Cursor {
	readonly c: string; // created_at ISO
	readonly i: number; // feedback id
}

function narrowCursor(v: unknown): Cursor | null {
	if (typeof v !== 'object' || v === null) return null;
	const o = v as Record<string, unknown>;
	if (typeof o.c !== 'string' || typeof o.i !== 'number') return null;
	if (!Number.isFinite(o.i)) return null;
	if (Number.isNaN(new Date(o.c).getTime())) return null;
	return { c: o.c, i: o.i };
}

interface SummaryRow {
	count: string; // bigint → string
	weighted_rating: string | null; // NUMERIC → string, null if count=0
	buy_count: string;
	buy_weighted_rating: string | null;
	sell_count: string;
	sell_weighted_rating: string | null;
	r1: string;
	r2: string;
	r3: string;
	r4: string;
	r5: string;
}

interface FeedbackRow {
	id: string; // bigint → string
	reviewer: string;
	subject: string;
	rating: number;
	comment: string | null;
	order_permlink: string | null;
	created_at: Date;
	source_trx_id: string;
	has_verified_chat: boolean;
	/** cp471 (D1/D2): the cited order's OWNER (subject or reviewer),
	 *  so the frontend links "View the order" to the right account. */
	order_account: string | null;
}

interface ResponseRow {
	feedback_id: string;
	responder: string;
	comment: string;
	created_at: Date;
}

export function feedbackByAccountRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:account/feedback', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const parsed = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
		if (!parsed.success) {
			return c.json(
				errorBody('bad_request', parsed.error.issues.map((i) => i.message).join('; ')),
				400
			);
		}
		const q = parsed.data;
		const limit = q.limit ?? DEFAULT_LIMIT;

		// ─── Summary query ─────────────────────────────────────────
		// Excludes reviews where the (reviewer, subject) pair is
		// flagged in suspicious_reciprocity OR related_accounts.
		// Both signal tables store rows in canonical (a < b) order,
		// so we test both orderings.  This is what makes the
		// "weighted_rating" actually weighted — without this filter
		// the field was an unweighted AVG that happily included
		// sock-puppet reviews even though Signal A/B detected them.
		// Per Finding R2.
		//
		// Also excludes feedback rows with NULL order_permlink
		// (Finding G2.1) — untethered feedback doesn't drive the
		// reputation signal anywhere in the system, matching the
		// post-§F.12 G1.1 welcome-bonus gating.  The list endpoint
		// below still returns these rows so the per-row feedback
		// list shows them; they just don't count toward the summary
		// aggregate the user reads as "trader's reputation."
		const summary = await db.query<SummaryRow>(
			`WITH non_suppressed AS (
				SELECT f.rating, f.created_at,
				       -- cp471 (t.txt F/H): the cited order may have been
				       -- posted by EITHER party (intake allows account IN
				       -- (subject, reviewer), cp420), so the SUBJECT's side is
				       -- the order's side when the subject owns it, else the
				       -- OPPOSITE (the subject was the taker on the maker's order).
				       CASE
				         WHEN o.account = f.subject THEN o.side
				         WHEN o.account = f.reviewer THEN
				           CASE o.side WHEN 'buy' THEN 'sell' WHEN 'sell' THEN 'buy' ELSE o.side END
				         ELSE NULL
				       END AS side
				  FROM feedback f
				  -- cp471 (t.txt F/H) — was a JOIN on o.account =
				  -- f.subject, which DROPPED every review whose cited order
				  -- was posted by the REVIEWER (a maker reviewing the taker,
				  -- citing the maker's OWN order — valid per intake cp420),
				  -- silently zeroing the subject's whole reputation ("No
				  -- feedback yet" despite a real verified review). Mirror the
				  -- intake: the order is owned by EITHER party; LEFT so a
				  -- since-removed order can't drop the count either. Match on
				  -- account+permlink (the unique key — a bare permlink can
				  -- collide across accounts).
				  LEFT JOIN orders o
				    ON o.permlink = f.order_permlink
				   AND o.account IN (f.subject, f.reviewer)
				 WHERE f.subject = $1
				   AND f.order_permlink IS NOT NULL
				   AND NOT EXISTS (
				       SELECT 1 FROM suspicious_reciprocity sr
				        WHERE (sr.account_a = LEAST(f.reviewer, f.subject)
				          AND sr.account_b = GREATEST(f.reviewer, f.subject))
				   )
				   AND NOT EXISTS (
				       SELECT 1 FROM related_accounts ra
				        WHERE (ra.account_a = LEAST(f.reviewer, f.subject)
				          AND ra.account_b = GREATEST(f.reviewer, f.subject))
				   )
				   -- Signal C exclusion (Part 113): if the subject is
				   -- flagged by the pile-on detector AND this specific
				   -- reviewer is in the attackers list for that flag,
				   -- drop the row from the reputation aggregate.  The
				   -- JSONB->>'reviewer' lookup uses the attackers
				   -- jsonb array stored on the one_way_pile_on row.
				   AND NOT EXISTS (
				       SELECT 1 FROM one_way_pile_on owpo,
				                    jsonb_array_elements(owpo.attacking_reviewers) attacker
				        WHERE owpo.subject = f.subject
				          AND attacker->>'reviewer' = f.reviewer
				   )
				   -- cp123 (Signal D — review concentration): exclude
				   -- feedback from reviewers flagged for concentrating
				   -- ≥80% of their reviews on a single subject (closes
				   -- Part 113 A4 residual).  See signals.ts:
				   -- detectReviewConcentration.
				   AND NOT EXISTS (
				       SELECT 1 FROM review_concentration rc
				        WHERE rc.reviewer = f.reviewer
				          AND rc.dominant_subject = f.subject
				   )
			)
			SELECT
				COUNT(*)::text AS count,
				-- cp123 H1: time-decay weighted rating with 365-day
				-- half-life.  See apps/indexer/src/indexer/reputation/decay.ts
				-- for the rationale.  Empty result → NULL.
				CASE WHEN COUNT(*) > 0
				     THEN ROUND(
				            SUM(rating * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))) /
				            NULLIF(SUM(POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))), 0),
				            2
				          )::text
				     ELSE NULL
				END AS weighted_rating,
				-- cp124 H5: same formula, FILTERed by side, for the
				-- by_side breakdown.  Buyer/seller asymmetry is a
				-- meaningful trust signal — a trader great as buyer
				-- but bad as seller deserves to be visible.
				COUNT(*) FILTER (WHERE side = 'buy')::text AS buy_count,
				CASE WHEN COUNT(*) FILTER (WHERE side = 'buy') > 0
				     THEN ROUND(
				            SUM(rating * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))) FILTER (WHERE side = 'buy') /
				            NULLIF(SUM(POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))) FILTER (WHERE side = 'buy'), 0),
				            2
				          )::text
				     ELSE NULL
				END AS buy_weighted_rating,
				COUNT(*) FILTER (WHERE side = 'sell')::text AS sell_count,
				CASE WHEN COUNT(*) FILTER (WHERE side = 'sell') > 0
				     THEN ROUND(
				            SUM(rating * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))) FILTER (WHERE side = 'sell') /
				            NULLIF(SUM(POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))) FILTER (WHERE side = 'sell'), 0),
				            2
				          )::text
				     ELSE NULL
				END AS sell_weighted_rating,
				SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::text AS r1,
				SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END)::text AS r2,
				SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END)::text AS r3,
				SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END)::text AS r4,
				SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END)::text AS r5
			 FROM non_suppressed`,
			[account]
		);
		const s = summary.rows[0]!;

		// ─── cp124 H6: last_traded_at (dormancy signal) ─────────────
		// Single query — MAX(created_at) across the two activity
		// sources that matter for a "real" trader:
		//   1. orders posted with fee_status='verified'
		//   2. feedback received as subject (someone else completed
		//      a trade with this account and left a review)
		// We DON'T include feedback the account LEFT (that's review
		// activity, not trade activity).
		// Returns NULL if the account has neither posted a verified
		// order nor received any feedback.
		const dormancy = await db.query<{ last_traded_at: Date | null }>(
			`SELECT GREATEST(
			          (SELECT MAX(created_at) FROM orders
			            WHERE account = $1 AND fee_status = 'verified'),
			          (SELECT MAX(created_at) FROM feedback
			            WHERE subject = $1)
			        ) AS last_traded_at`,
			[account]
		);
		const lastTradedAt = dormancy.rows[0]?.last_traded_at ?? null;

		// ─── cp511 [E]: suspicious-reciprocity flag (profile trust pill) ───
		// True iff this account appears in ANY suspicious_reciprocity pair (as
		// account_a OR account_b) — i.e. Signal B (ADR-0009 §5) caught it
		// exchanging mutual reviews with another account. The pairwise flag is
		// already implicit in the reviews this summary EXCLUDES above, so the
		// boolean leaks nothing new; it just lets the profile show "clean"
		// (green) vs "flagged" without a reputation-receipt round-trip.
		const reciprocity = await db.query<{ flagged: boolean }>(
			`SELECT EXISTS (
			          SELECT 1 FROM suspicious_reciprocity sr
			           WHERE sr.account_a = $1 OR sr.account_b = $1
			        ) AS flagged`,
			[account]
		);
		const reciprocityFlagged = reciprocity.rows[0]?.flagged ?? false;

		const summaryObj = {
			count: parseInt(s.count, 10),
			weighted_rating: s.weighted_rating === null ? 0 : Number(s.weighted_rating),
			by_rating: {
				'1': parseInt(s.r1, 10),
				'2': parseInt(s.r2, 10),
				'3': parseInt(s.r3, 10),
				'4': parseInt(s.r4, 10),
				'5': parseInt(s.r5, 10)
			},
			// cp124 H5: side-of-trade distinction.  A trader great as
			// buyer but bad as seller (or vice versa) deserves to be
			// visible — readers see "as buyer: 4.92 (50) · as seller:
			// 3.21 (10)" instead of a single conflated number.
			// weighted_rating null when count on that side is 0.
			by_side: {
				buy: {
					count: parseInt(s.buy_count, 10),
					weighted_rating: s.buy_weighted_rating === null ? null : Number(s.buy_weighted_rating)
				},
				sell: {
					count: parseInt(s.sell_count, 10),
					weighted_rating: s.sell_weighted_rating === null ? null : Number(s.sell_weighted_rating)
				}
			},
			// cp124 H6: dormancy signal.  ISO-8601 string when known,
			// null when the account has no verified orders + no
			// feedback (brand-new account).  Readers see "last traded
			// 3 days ago" vs "last traded 2 years ago" — informs
			// trust without changing any numeric score.
			last_traded_at: lastTradedAt === null ? null : lastTradedAt.toISOString(),
			// cp511 [E] — see the suspicious-reciprocity query above.
			reciprocity_flagged: reciprocityFlagged
		};

		// ─── Feedback page ────────────────────────────────────────
		const params: unknown[] = [account];
		let cursorClause = '';
		if (q.cursor) {
			const cur = narrowCursor(decodeCursor(q.cursor));
			if (!cur) {
				return c.json(errorBody('bad_request', 'invalid cursor'), 400);
			}
			params.push(new Date(cur.c), cur.i);
			cursorClause = ` AND (created_at < $2 OR (created_at = $2 AND id > $3))`;
		}
		params.push(limit + 1);
		const limitParam = `$${params.length}`;

		const fbSql = `SELECT id::text, reviewer, subject, rating, comment,
			        order_permlink, created_at, source_trx_id,
			        has_verified_chat,
			        -- cp471 (t.txt D1/D2): the cited order may belong to
			        -- the subject OR the reviewer (intake cp420). The
			        -- "View the order" link must target the order's real
			        -- OWNER, else it 404s to the "being posted" limbo.
			        (SELECT o.account FROM orders o
			          WHERE o.permlink = feedback.order_permlink
			            AND o.account IN (feedback.subject, feedback.reviewer)
			          LIMIT 1) AS order_account
			 FROM feedback
			 WHERE subject = $1${cursorClause}
			 ORDER BY created_at DESC, id ASC
			 LIMIT ${limitParam}`;

		const fbResult = await db.query<FeedbackRow>(fbSql, params);
		const rows = fbResult.rows;

		let nextCursor: string | null = null;
		if (rows.length > limit) {
			rows.pop();
			const last = rows[rows.length - 1]!;
			nextCursor = encodeCursor({
				c: last.created_at.toISOString(),
				i: parseInt(last.id, 10)
			});
		}

		// ─── Suppression flags ────────────────────────────────────
		// For each feedback row in this page, determine whether the
		// (reviewer, subject) pair is flagged in suspicious_reciprocity
		// (Signal B), related_accounts (Signal A), or the Signal C
		// one_way_pile_on attackers list.  The summary already
		// excludes all three (Finding R2 + Part 113 Signal C
		// extension); exposing the per-item flag lets the frontend
		// render a clear "this review is from a flagged pair / actor"
		// treatment so the displayed list reconciles with the summary
		// count (Finding R15).  Part 118: Signal C added — pre-Part-
		// 118 the per-row flag only covered A+B, so a Signal C
		// attacker's row would appear on the profile WITHOUT the
		// suppression chip while still being excluded from the
		// headline rating — exactly the inconsistency R15 prevented
		// for A+B.
		const reviewers = Array.from(new Set(rows.map((r) => r.reviewer)));
		const flaggedReviewers = new Set<string>();
		if (reviewers.length > 0) {
			const flagResult = await db.query<{ reviewer: string }>(
				`WITH pair_check AS (
					SELECT
						unnest($1::text[]) AS reviewer,
						$2::text AS subject
				)
				SELECT pc.reviewer
				  FROM pair_check pc
				 WHERE EXISTS (
				     SELECT 1 FROM suspicious_reciprocity sr
				      WHERE sr.account_a = LEAST(pc.reviewer, pc.subject)
				        AND sr.account_b = GREATEST(pc.reviewer, pc.subject)
				 ) OR EXISTS (
				     SELECT 1 FROM related_accounts ra
				      WHERE ra.account_a = LEAST(pc.reviewer, pc.subject)
				        AND ra.account_b = GREATEST(pc.reviewer, pc.subject)
				 ) OR EXISTS (
				     -- Signal C (Part 118): mirror the summary
				     -- aggregate's exclusion logic.  The same
				     -- jsonb_array_elements + attacker->>'reviewer'
				     -- pattern that drives the summary CTE at the
				     -- top of this handler.
				     SELECT 1 FROM one_way_pile_on owpo,
				                  jsonb_array_elements(owpo.attacking_reviewers) attacker
				      WHERE owpo.subject = pc.subject
				        AND attacker->>'reviewer' = pc.reviewer
				 )`,
				[reviewers, account]
			);
			for (const r of flagResult.rows) flaggedReviewers.add(r.reviewer);
		}

		// ─── Reviewer reputation (v1.8.0, t.txt) ───────────────────
		// The "reviews this user has received" card now shows the CURRENT
		// reputation of the REVIEWER (the person who left the review) — the
		// mirror of what the feedback-given card already shows for the
		// subject. A reviewer's reputation is the weighted rating of the
		// feedback where THEY are the subject, so this reuses the exact same
		// CANONICAL FEEDBACK_EXCLUSIONS_SQL + decay formula as the summary
		// and the given-card computation — it can never drift from the
		// headline figure on that reviewer's own profile. Batched over the
		// page's distinct reviewers so the card costs ZERO extra round trips
		// (a per-reviewer fetch would be up to DEFAULT_LIMIT requests from a
		// single profile view).
		const reviewerReputation = new Map<
			string,
			{ count: number; weighted_rating: number | null }
		>();
		if (reviewers.length > 0) {
			const repResult = await db.query<{ subject: string; c: number; r: string | null }>(
				`SELECT fb.subject, COUNT(*)::int AS c,
				        ROUND(
				          SUM(fb.rating * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - fb.created_at)) / (365 * 86400.0))) /
				          NULLIF(SUM(POWER(0.5, EXTRACT(EPOCH FROM (NOW() - fb.created_at)) / (365 * 86400.0))), 0),
				          2
				        )::text AS r
				   FROM feedback fb
${FEEDBACK_EXCLUSIONS_SQL}
				    AND fb.subject = ANY($1::text[])
				  GROUP BY fb.subject`,
				[reviewers]
			);
			for (const row of repResult.rows) {
				reviewerReputation.set(row.subject, {
					count: row.c,
					weighted_rating: row.r === null ? null : parseFloat(row.r)
				});
			}
		}

		// ─── Responses for this page's feedback ids ───────────────
		const ids = rows.map((r) => parseInt(r.id, 10));
		const responsesByFeedbackId = new Map<number, ResponseRow[]>();
		if (ids.length > 0) {
			const respResult = await db.query<ResponseRow>(
				`SELECT feedback_id::text, responder, comment, created_at
				 FROM feedback_responses
				 WHERE feedback_id = ANY($1::bigint[])
				 ORDER BY created_at DESC`,
				[ids]
			);
			for (const r of respResult.rows) {
				const fid = parseInt(r.feedback_id, 10);
				const list = responsesByFeedbackId.get(fid);
				if (list) list.push(r);
				else responsesByFeedbackId.set(fid, [r]);
			}
		}

		// ─── Assemble ──────────────────────────────────────────────
		const items = rows.map((r) => {
			const fid = parseInt(r.id, 10);
			const responses = responsesByFeedbackId.get(fid) ?? [];
			return {
				id: fid,
				reviewer: r.reviewer,
				subject: r.subject,
				rating: r.rating,
				comment: r.comment,
				order_permlink: r.order_permlink,
				/** cp471 (D1/D2): the cited order's owner account. */
				order_account: r.order_account,
				created_at: r.created_at.toISOString(),
				source_trx_id: r.source_trx_id,
				/** True iff the (reviewer, subject) pair is in
				 *  suspicious_reciprocity or related_accounts.  The
				 *  summary already excludes these from the displayed
				 *  rating + count (Finding R2); exposing the per-row
				 *  flag lets the frontend show a clear visual cue so
				 *  the list reconciles with the summary (Finding R15). */
				suppressed: flaggedReviewers.has(r.reviewer),
				/** v1.8.0 (t.txt): the REVIEWER's current reputation —
				 *  exclusion-filtered + decay-weighted, identical to the
				 *  headline figure on their own profile. Lets the received
				 *  card render "★ 4.97 (12)" next to the reviewer, mirroring
				 *  the feedback-given card's subject_reputation. null-rating
				 *  when count is 0. */
				reviewer_reputation: reviewerReputation.get(r.reviewer) ?? {
					count: 0,
					weighted_rating: null
				},
				/** ADR-0014 verified-chat badge.  True iff the
				 *  (reviewer, subject) pair satisfied the
				 *  bidirectional-chat conformance at the time the
				 *  feedback was signed.  Stored on the row at
				 *  intake (schema-v26 migration); reads are O(1).
				 *  Frontend renders a small badge with a tooltip
				 *  explaining the badge does NOT prove distinct
				 *  identity — only that a real-looking conversation
				 *  preceded the review. */
				has_verified_chat: r.has_verified_chat === true,
				responses: responses.map((x) => ({
					responder: x.responder,
					comment: x.comment,
					created_at: x.created_at.toISOString()
				}))
			};
		});

		return c.json({
			summary: summaryObj,
			items,
			next_cursor: nextCursor
		});
	});

	// ─── /v1/accounts/:account/feedback-given ─────────────────────
	// Same shape as the feedback route above, minus the summary
	// (a reviewer doesn't have a weighted rating attached to the
	// feedback they've LEFT for others — that would conflate
	// "average rating I gave" with reputation metrics in confusing
	// ways).
	//
	// WHERE reviewer = $1 instead of subject = $1. Everything else
	// — pagination, response join, row projection — is identical,
	// so the frontend renders both lists with the same component.
	app.get('/:account/feedback-given', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const parsed = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
		if (!parsed.success) {
			return c.json(
				errorBody('bad_request', parsed.error.issues.map((i) => i.message).join('; ')),
				400
			);
		}
		const q = parsed.data;
		const limit = q.limit ?? DEFAULT_LIMIT;

		const params: unknown[] = [account];
		let cursorClause = '';
		if (q.cursor) {
			const cur = narrowCursor(decodeCursor(q.cursor));
			if (!cur) {
				return c.json(errorBody('bad_request', 'invalid cursor'), 400);
			}
			params.push(new Date(cur.c), cur.i);
			cursorClause = ` AND (created_at < $2 OR (created_at = $2 AND id > $3))`;
		}
		params.push(limit + 1);
		const limitParam = `$${params.length}`;

		const fbSql = `SELECT id::text, reviewer, subject, rating, comment,
			        order_permlink, created_at, source_trx_id,
			        has_verified_chat,
			        -- cp471 (t.txt D1/D2): same owner rule as the received
			        -- list — the cited order may belong to EITHER party, so
			        -- the "View the order" link needs the real owner.
			        (SELECT o.account FROM orders o
			          WHERE o.permlink = feedback.order_permlink
			            AND o.account IN (feedback.subject, feedback.reviewer)
			          LIMIT 1) AS order_account
			 FROM feedback
			 WHERE reviewer = $1${cursorClause}
			 ORDER BY created_at DESC, id ASC
			 LIMIT ${limitParam}`;

		const fbResult = await db.query<FeedbackRow>(fbSql, params);
		const rows = fbResult.rows;

		let nextCursor: string | null = null;
		if (rows.length > limit) {
			rows.pop();
			const last = rows[rows.length - 1]!;
			nextCursor = encodeCursor({
				c: last.created_at.toISOString(),
				i: parseInt(last.id, 10)
			});
		}

		const ids = rows.map((r) => parseInt(r.id, 10));
		const responsesByFeedbackId = new Map<number, ResponseRow[]>();
		if (ids.length > 0) {
			const respResult = await db.query<ResponseRow>(
				`SELECT feedback_id::text, responder, comment, created_at
				 FROM feedback_responses
				 WHERE feedback_id = ANY($1::bigint[])
				 ORDER BY created_at DESC`,
				[ids]
			);
			for (const r of respResult.rows) {
				const fid = parseInt(r.feedback_id, 10);
				const arr = responsesByFeedbackId.get(fid) ?? [];
				arr.push(r);
				responsesByFeedbackId.set(fid, arr);
			}
		}

		// ─── Suppression flags ────────────────────────────────────
		// In feedback-given, $1 is the reviewer, and the subject
		// varies across rows.  Pre-compute the set of subjects for
		// which (reviewer, subject) is flagged so each row can be
		// marked.  Per Finding R15 — same goal as the received
		// route: list view reconciles with the suppression-aware
		// summary on subject profiles.  Part 118: Signal C added
		// (same posture as the /feedback handler above).
		const subjects = Array.from(new Set(rows.map((r) => r.subject)));
		const flaggedSubjects = new Set<string>();
		if (subjects.length > 0) {
			const flagResult = await db.query<{ subject: string }>(
				`WITH pair_check AS (
					SELECT
						$1::text AS reviewer,
						unnest($2::text[]) AS subject
				)
				SELECT pc.subject
				  FROM pair_check pc
				 WHERE EXISTS (
				     SELECT 1 FROM suspicious_reciprocity sr
				      WHERE sr.account_a = LEAST(pc.reviewer, pc.subject)
				        AND sr.account_b = GREATEST(pc.reviewer, pc.subject)
				 ) OR EXISTS (
				     SELECT 1 FROM related_accounts ra
				      WHERE ra.account_a = LEAST(pc.reviewer, pc.subject)
				        AND ra.account_b = GREATEST(pc.reviewer, pc.subject)
				 ) OR EXISTS (
				     -- Signal C (Part 118): the reviewer is the
				     -- fixed $1 here, the subject varies.  A row
				     -- is flagged iff THIS subject has a Signal C
				     -- pile-on detection AND $1 (the reviewer) is
				     -- in that detection's attackers list.
				     SELECT 1 FROM one_way_pile_on owpo,
				                  jsonb_array_elements(owpo.attacking_reviewers) attacker
				      WHERE owpo.subject = pc.subject
				        AND attacker->>'reviewer' = pc.reviewer
				 )`,
				[account, subjects]
			);
			for (const r of flagResult.rows) flaggedSubjects.add(r.subject);
		}

		// ─── Reviewed-account reputation (cp471, t.txt E) ────────
		// Each "reviews this user has left" card shows the CURRENT
		// reputation of the person who was reviewed (★ 4.97 (12)).
		// Computed here, scoped to this page's subjects, so the card
		// costs ZERO extra round trips (a per-subject fetch would be
		// up to DEFAULT_LIMIT=50 requests from one profile page).
		// Uses the CANONICAL shared FEEDBACK_EXCLUSIONS_SQL — never a
		// local copy — so this number can't drift from the headline
		// rating on the subject's own profile (the whole reason that
		// SQL lives in reputationJoin.ts).
		const subjectReputation = new Map<string, { count: number; weighted_rating: number | null }>();
		if (subjects.length > 0) {
			const repResult = await db.query<{ subject: string; c: number; r: string | null }>(
				`SELECT fb.subject, COUNT(*)::int AS c,
				        ROUND(
				          SUM(fb.rating * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - fb.created_at)) / (365 * 86400.0))) /
				          NULLIF(SUM(POWER(0.5, EXTRACT(EPOCH FROM (NOW() - fb.created_at)) / (365 * 86400.0))), 0),
				          2
				        )::text AS r
				   FROM feedback fb
${FEEDBACK_EXCLUSIONS_SQL}
				    AND fb.subject = ANY($1::text[])
				  GROUP BY fb.subject`,
				[subjects]
			);
			for (const row of repResult.rows) {
				subjectReputation.set(row.subject, {
					count: row.c,
					weighted_rating: row.r === null ? null : parseFloat(row.r)
				});
			}
		}

		const items = rows.map((r) => {
			const fid = parseInt(r.id, 10);
			const responses = responsesByFeedbackId.get(fid) ?? [];
			return {
				id: fid,
				reviewer: r.reviewer,
				subject: r.subject,
				rating: r.rating,
				comment: r.comment,
				order_permlink: r.order_permlink,
				/** cp471 (D1/D2): the cited order's owner account. */
				order_account: r.order_account,
				created_at: r.created_at.toISOString(),
				source_trx_id: r.source_trx_id,
				suppressed: flaggedSubjects.has(r.subject),
				/** cp471 (E): the reviewed account's CURRENT reputation
				 *  (exclusion-filtered + decay-weighted, same as their own
				 *  profile headline). null when they have no counting
				 *  feedback yet. */
				subject_reputation: subjectReputation.get(r.subject) ?? { count: 0, weighted_rating: null },
				/** ADR-0014 verified-chat badge — see the matching
				 *  projection in the /feedback route above for full
				 *  semantics.  Same column, same meaning; mirrored
				 *  here so the feedback-given list renders the same
				 *  badge treatment. */
				has_verified_chat: r.has_verified_chat === true,
				responses: responses.map((x) => ({
					responder: x.responder,
					comment: x.comment,
					created_at: x.created_at.toISOString()
				}))
			};
		});

		return c.json({
			items,
			next_cursor: nextCursor
		});
	});

	return app;
}
