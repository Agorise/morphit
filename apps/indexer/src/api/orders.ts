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
	terms: string | null;
	status: 'live' | 'cancelled' | 'expired';
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
	/** Derived from accounts.first_trade_complete_at via LEFT JOIN. */
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
		terms: r.terms,
		status: r.status,
		fee_status: r.fee_status,
		fee_method: r.fee_method,
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
			        o.location_region, o.payment_methods, o.terms,
			        o.status, o.fee_status, o.fee_method,
			        (COALESCE(f.c, 0) < 4) AS is_new_trader,
			        o.created_at, o.updated_at, o.expires_at
			 FROM orders o
			 LEFT JOIN (
			   -- Same trustworthy-feedback-count CTE as /v1/orderbook
			   -- (filters sock-puppet pairs and untethered feedback).
			   -- Aligns is_new_trader semantics across endpoints —
			   -- previously this endpoint used
			   -- (a.first_trade_complete_at IS NULL) which is a
			   -- different threshold (welcome-bonus trigger, not
			   -- low-rep signal).  Closes Memory #11 Category O
			   -- finding O-11 (Part 101).  The field is currently
			   -- unconsumed by the frontend, so this realignment is
			   -- a no-op for users; future consumers see the
			   -- documented semantics.
			   SELECT subject, COUNT(*)::int AS c
			     FROM feedback fb
			    WHERE fb.order_permlink IS NOT NULL
			      AND NOT EXISTS (
			        SELECT 1 FROM suspicious_reciprocity sr
			         WHERE sr.account_a = LEAST(fb.reviewer, fb.subject)
			           AND sr.account_b = GREATEST(fb.reviewer, fb.subject)
			    )
			      AND NOT EXISTS (
			        SELECT 1 FROM related_accounts ra
			         WHERE ra.account_a = LEAST(fb.reviewer, fb.subject)
			           AND ra.account_b = GREATEST(fb.reviewer, fb.subject)
			    )
			    GROUP BY subject
			 ) f ON f.subject = o.account
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
