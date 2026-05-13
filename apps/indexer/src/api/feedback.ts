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
				SELECT f.rating
				  FROM feedback f
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
			)
			SELECT
				COUNT(*)::text AS count,
				CASE WHEN COUNT(*) > 0 THEN ROUND(AVG(rating)::NUMERIC, 2)::text ELSE NULL END AS weighted_rating,
				SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::text AS r1,
				SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END)::text AS r2,
				SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END)::text AS r3,
				SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END)::text AS r4,
				SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END)::text AS r5
			 FROM non_suppressed`,
			[account]
		);
		const s = summary.rows[0]!;
		const summaryObj = {
			count: parseInt(s.count, 10),
			weighted_rating: s.weighted_rating === null ? 0 : Number(s.weighted_rating),
			by_rating: {
				'1': parseInt(s.r1, 10),
				'2': parseInt(s.r2, 10),
				'3': parseInt(s.r3, 10),
				'4': parseInt(s.r4, 10),
				'5': parseInt(s.r5, 10)
			}
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
			        has_verified_chat
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
				created_at: r.created_at.toISOString(),
				source_trx_id: r.source_trx_id,
				/** True iff the (reviewer, subject) pair is in
				 *  suspicious_reciprocity or related_accounts.  The
				 *  summary already excludes these from the displayed
				 *  rating + count (Finding R2); exposing the per-row
				 *  flag lets the frontend show a clear visual cue so
				 *  the list reconciles with the summary (Finding R15). */
				suppressed: flaggedReviewers.has(r.reviewer),
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
			        has_verified_chat
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
				created_at: r.created_at.toISOString(),
				source_trx_id: r.source_trx_id,
				suppressed: flaggedSubjects.has(r.subject),
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
