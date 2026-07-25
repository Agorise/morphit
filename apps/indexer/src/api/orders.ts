/**
 * Morphit indexer — /v1/orders/:account endpoint.
 *
 * All orders belonging to one account, regardless of status. UI
 * decides whether to hide cancelled or show them greyed out.
 *
 * Pagination: cursor on (updated_at DESC, permlink ASC). The
 * account is already fixed by the path parameter, so we don't
 * need it in the cursor.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Database } from '$db/pool';
import type { AssetTicker } from '@morphit/asset-registry';
import { decodeCursor, encodeCursor, errorBody, isAccountName } from '$api/shared';
import { tradeCountJoin, feedbackAggregateJoin } from '$api/reputationJoin';
import { computeReputationScore } from '$indexer/reputation/score';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
	cursor: z.string().min(1).max(512).optional()
});

interface Cursor {
	readonly u: string; // updated_at ISO
	readonly p: string; // permlink
}

function narrowCursor(v: unknown): Cursor | null {
	if (typeof v !== 'object' || v === null) return null;
	const o = v as Record<string, unknown>;
	if (typeof o.u !== 'string' || typeof o.p !== 'string') return null;
	if (Number.isNaN(new Date(o.u).getTime())) return null;
	return { u: o.u, p: o.p };
}

interface OrderRow {
	account: string;
	permlink: string;
	side: 'buy' | 'sell';
	asset: AssetTicker;
	fiat_currency: string;
	amount_min: string | null;
	amount_max: string | null;
	price_model: unknown;
	location_region: string | null;
	payment_methods: string[];
	/** cp425 — accepted crypto set for a BARTER order; null for crypto assets. */
	accepted_assets: string[] | null;
	terms: string | null;
	status: 'live' | 'cancelled' | 'expired' | 'completed';
	fee_status:
		| 'unverified'
		| 'verified'
		| 'missing'
		| 'underpaid'
		// ADR-0011 sub-phase 4b: external-chain fee methods (BTC,
		// XMR) land as pending_external and are promoted to
		// verified_by_attestation once ≥2 attestors with ≥1
		// non-poster meet the Finding I eligibility gate.
		| 'pending_external'
		| 'verified_by_attestation'
		// Order-placement audit Finding O19: the external_tx_id
		// claimed by this order was already used by a prior
		// order.  Recorded for audit; excluded from the orderbook.
		| 'reused';
	/** ADR-0011 — how this order's listing fee was paid. */
	fee_method: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr';
	/** v1.5.5: the OTHER party of this completed trade, as named by the owner
	 *  in morphit_order_complete_v1. NULL unless completed (and unnamed/
	 *  unproven completions stay NULL). */
	completed_counterparty: string | null;
	/** v1.5.5: the owner's COMPLETED-TRADE count (both sides credited,
	 *  sock-puppet-pair filtered). v1.8.15 (Ken, t.txt #5) — this endpoint
	 *  now ALSO carries the rating aggregate + reciprocity flag so the order
	 *  DETAIL page's "POSTED BY" card can render the ⭐ reputation pill and the
	 *  "No mutual-review flags" pill without a second round-trip, matching the
	 *  orderbook cards. (The old "owner's own view, deliberately no rating"
	 *  contract predated the public detail page reusing this endpoint.) */
	trade_count: number;
	/** v1.8.15 — RATINGS backing the star average (DIFFERENT from trade_count:
	 *  a completed trade nobody reviewed counts as a trade, not a rating). */
	feedback_count: number;
	/** v1.8.15 — time-decayed weighted average rating as a numeric string, or
	 *  NULL when feedback_count is zero. */
	weighted_rating: string | null;
	/** v1.8.15 — MAX(created_at) of included feedback; drives the composite
	 *  score's recency factor. NULL when there is no included feedback. */
	last_feedback_at: Date | null;
	/** v1.8.15 — true iff this account appears in a suspicious_reciprocity
	 *  pair (Signal B). Drives the profile-style trust pill on the card. */
	reciprocity_flagged: boolean;
	/** v1.5.5: now `trade_count < 4` — reviews are optional, completions are
	 *  the real experience signal (was: feedback count < 4). */
	is_new_trader: boolean;
	created_at: Date;
	updated_at: Date;
	expires_at: Date | null;
}

function rowToWire(r: OrderRow) {
	return {
		account: r.account,
		permlink: r.permlink,
		side: r.side,
		asset: r.asset,
		fiat_currency: r.fiat_currency,
		amount_min: r.amount_min === null ? null : Number(r.amount_min),
		amount_max: r.amount_max === null ? null : Number(r.amount_max),
		price_model: r.price_model,
		location_region: r.location_region,
		payment_methods: r.payment_methods,
		accepted_assets: r.accepted_assets ?? null,
		terms: r.terms,
		status: r.status,
		fee_status: r.fee_status,
		fee_method: r.fee_method,
		completed_counterparty: r.completed_counterparty,
		trade_count: r.trade_count,
		// v1.8.15 (t.txt #5) — rating aggregate + composite score, computed
		// with the SAME helper the orderbook uses so the detail-page card and
		// an orderbook card show the identical ⭐ number for the same account.
		feedback_count: r.feedback_count,
		weighted_rating: r.weighted_rating === null ? null : Number(r.weighted_rating),
		reputation_score: computeReputationScore({
			count: r.feedback_count,
			weightedAvg: r.weighted_rating === null ? null : Number(r.weighted_rating),
			lastFeedbackAtMs: r.last_feedback_at === null ? null : r.last_feedback_at.getTime()
		}),
		reciprocity_flagged: r.reciprocity_flagged,
		is_new_trader: r.is_new_trader,
		created_at: r.created_at.toISOString(),
		updated_at: r.updated_at.toISOString(),
		expires_at: r.expires_at === null ? null : r.expires_at.toISOString()
	};
}

export function ordersByAccountRoute(db: Database, operatorAccount: string): Hono {
	const app = new Hono();

	app.get('/:account', async (c) => {
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
			params.push(new Date(cur.u), cur.p);
			// Same mixed-direction predicate pattern as orderbook: we
			// can't use a tuple comparison because updated_at is DESC
			// and permlink is ASC.
			cursorClause = ` AND (o.updated_at < $2 OR (o.updated_at = $2 AND o.permlink > $3))`;
		}
		params.push(limit + 1);
		const limitParam = `$${params.length}`;
		// beta5 — instance-local block: if the requested account is
		// blocked on THIS instance, its listings are hidden here too.
		params.push(operatorAccount);
		const opParam = `$${params.length}`;

		const sql = `SELECT o.account, o.permlink, o.side, o.asset, o.fiat_currency,
			        o.amount_min::text, o.amount_max::text, o.price_model,
			        o.location_region, o.payment_methods, o.accepted_assets, o.terms,
			        o.status, o.fee_status, o.fee_method,
			        o.completed_counterparty,
			        -- v1.5.5 (Ken): the 🌱 new-trader chip now keys off COMPLETED
			        -- TRADES, not reviews. A trader who has actually completed
			        -- trades shouldn't still read as new just because nobody left
			        -- stars — reviews are optional, trades are the real signal.
			        COALESCE(tc.c, 0) AS trade_count,
			        (COALESCE(tc.c, 0) < 4) AS is_new_trader,
			        -- v1.8.15 (t.txt #5) — rating aggregate (same CTE the orderbook
			        -- + feedback summary use) so the detail page's POSTED BY card
			        -- shows the ⭐ reputation pill, plus the suspicious-reciprocity
			        -- flag for the "No mutual-review flags" trust pill.
			        COALESCE(f.c, 0)::int AS feedback_count,
			        CASE WHEN f.r IS NOT NULL THEN f.r::text ELSE NULL END AS weighted_rating,
			        f.last_feedback_at,
			        EXISTS (
			          SELECT 1 FROM suspicious_reciprocity sr
			           WHERE sr.account_a = o.account OR sr.account_b = o.account
			        ) AS reciprocity_flagged,
			        o.created_at, o.updated_at, o.expires_at
			 FROM orders o
			 ${feedbackAggregateJoin('o')}
${tradeCountJoin('o')}
			 WHERE o.account = $1${cursorClause}
			   AND NOT EXISTS (SELECT 1 FROM operator_blocks ob WHERE ob.operator = ${opParam} AND ob.blocked = o.account AND ob.state = 'blocked')
			 ORDER BY o.updated_at DESC, o.permlink ASC
			 LIMIT ${limitParam}`;

		const result = await db.query<OrderRow>(sql, params);
		const rows = result.rows;
		let nextCursor: string | null = null;
		if (rows.length > limit) {
			rows.pop();
			const last = rows[rows.length - 1]!;
			nextCursor = encodeCursor({
				u: last.updated_at.toISOString(),
				p: last.permlink
			});
		}

		return c.json({
			items: rows.map(rowToWire),
			next_cursor: nextCursor
		});
	});

	return app;
}
