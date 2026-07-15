/**
 * Morphit indexer — /v1/orderbook endpoint.
 *
 * Filtered list of live orders, cursor-paginated. Query parameters:
 *   - asset:            AssetTicker (optional)
 *   - side:             'buy' | 'sell' (optional)
 *   - fiat_currency:    comma-separated ISO codes, order matches any of (optional)
 *   - location_region:  string up to 128, prefix-matched (optional)
 *   - payment_methods:  comma-separated list, order matches any of (optional)
 *   - min_trades:       integer ≥0, filter to traders with ≥N COMPLETED TRADES (optional).
 *                       v1.5.5: real completions (both parties credited), not
 *                       the pre-v1.5.5 received-feedback proxy.
 *   - sort:             'recent' (default) | 'rating' | 'trades'
 *   - limit:            1..100 (default 50)
 *   - cursor:           opaque (returned from previous response)
 *
 * Default sort (recent): (updated_at DESC, account, permlink).
 * sort=rating: (weighted_rating DESC NULLS LAST, feedback_count DESC, ...tiebreakers).
 * sort=trades: (feedback_count DESC, ...tiebreakers).
 *
 * Each row now carries feedback_count + weighted_rating from the
 * LEFT JOIN on an aggregate of the feedback table. is_new_trader
 * is derived as feedback_count < 4, giving new traders a four-
 * trade sprout window on the UI. The underlying welcome-bonus
 * trigger in accounts.first_trade_complete_at still fires once on
 * the first counterparty review, independent of this UI flag.
 *
 * Cursor is base64url JSON. Carries the sort mode so a continuation
 * request under a different sort mode is rejected (400). Frontend
 * is expected to clear the cursor on any filter or sort change.
 */

import { Hono } from 'hono';
import { computeReputationScore } from '$indexer/reputation/score';
import {
	feedbackAggregateJoin,
	accountsJoin,
	engagementJoin,
	tradeCountJoin
} from '$api/reputationJoin';
import { z } from 'zod';

import type { Database } from '$db/pool';
import type { Poller } from '$indexer/poller';
import { decodeCursor, encodeCursor, errorBody, escapeLike } from '$api/shared';
import { ASSET_TICKERS, type AssetTicker } from '@morphit/asset-registry';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const querySchema = z.object({
	asset: z.enum(ASSET_TICKERS).optional(),
	side: z.enum(['buy', 'sell']).optional(),
	fiat_currency: z
		.string()
		.min(1)
		.max(120)
		// One or more uppercase ISO-4217 codes, comma-separated (no
		// spaces). The strict shape guarantees ≥1 valid token, so the
		// handler can split on ',' without further validation.
		.regex(/^[A-Z]+(,[A-Z]+)*$/)
		.optional(),
	location_region: z.string().min(1).max(128).optional(),
	payment_methods: z
		.string()
		.min(1)
		.max(256)
		// Comma-separated list of short tokens. Split + validate.
		.optional(),
	/** Minimum completed-trade count (derived from received feedback
	 *  count). Discrete values only — we deliberately restrict to
	 *  sensible presets instead of letting the frontend pass any
	 *  integer, because UX testing will lock in 2-3 good thresholds
	 *  rather than a free-form number that users have to guess at. */
	min_trades: z.coerce.number().int().nonnegative().max(100).optional(),
	/** Sort mode. Default "recent" preserves the historical behavior
	 *  (ORDER BY updated_at DESC); "rating" surfaces highest-average-
	 *  weighted orderers first; "trades" surfaces most-experienced
	 *  orderers first. Tiebreakers fall back to updated_at DESC. */
	sort: z.enum(['recent', 'rating', 'trades']).optional(),
	limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
	cursor: z.string().min(1).max(512).optional()
});

interface Cursor {
	readonly u: string; // updated_at as ISO
	readonly a: string; // account
	readonly p: string; // permlink
	/** Sort mode the cursor was generated under. Absent (undefined)
	 *  means "recent" — backwards-compat with cursors minted before
	 *  the sort feature. A cursor-continuation request whose `sort`
	 *  doesn't match the cursor's `s` returns 400 invalid cursor. */
	readonly s?: 'recent' | 'rating' | 'trades';
	/** Sort-value tie-breakers. `r` is the cursor row's
	 *  weighted_rating (or null if count=0).
	 *
	 *  `c` is the cursor row's numeric seek key, and v1.5.5 made it
	 *  MODE-DEPENDENT: the FEEDBACK count under sort=rating (where it is the
	 *  tiebreaker behind `r`), the TRADE count under sort=trades (where it is
	 *  the primary key). It must always match the column the ORDER BY uses for
	 *  that mode, or the seek walks a different ordering than the sort
	 *  produces and pages skip/repeat rows. Present for sort=rating/trades,
	 *  absent for sort=recent (where updated_at alone suffices). */
	readonly r?: number | null;
	readonly c?: number;
}

function narrowCursor(v: unknown): Cursor | null {
	if (typeof v !== 'object' || v === null) return null;
	const o = v as Record<string, unknown>;
	if (typeof o.u !== 'string' || typeof o.a !== 'string' || typeof o.p !== 'string') {
		return null;
	}
	const d = new Date(o.u);
	if (Number.isNaN(d.getTime())) return null;
	const cursor: Cursor = { u: o.u, a: o.a, p: o.p };
	// Optional sort-aware fields. Present on cursors minted for
	// non-default sort; absent for cursors minted under the
	// backward-compatible "recent" path.
	if (o.s === 'recent' || o.s === 'rating' || o.s === 'trades') {
		(cursor as { s?: 'recent' | 'rating' | 'trades' }).s = o.s;
	}
	if (typeof o.r === 'number' || o.r === null) {
		(cursor as { r?: number | null }).r = o.r;
	}
	if (typeof o.c === 'number') {
		(cursor as { c?: number }).c = o.c;
	}
	return cursor;
}

interface OrderRow {
	account: string;
	permlink: string;
	side: 'buy' | 'sell';
	asset: AssetTicker;
	/** Part 121 / cp30 / cp31 — sub-network for multi-network
	 *  assets.  Null for single-network assets (BTC/XMR/BLURT/
	 *  BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL/ETH/XRP) and for pre-Part-121 rows.  One of
	 *  'erc20'|'trc20'|'spl'|'bep20' for USDT; one of 'erc20'|
	 *  'spl'|'base'|'polygon' for USDC; one of 'erc20'|'polygon'|
	 *  'base'|'arbitrum' for DAI. */
	asset_network: string | null;
	fiat_currency: string;
	amount_min: string | null; // NUMERIC returns as string from pg
	amount_max: string | null;
	price_model: unknown;
	location_region: string | null;
	payment_methods: string[];
	/** cp425 — for a BARTER (goods/services) order, the crypto tickers the
	 *  seller accepts as settlement (e.g. ['BTC','XMR']). Null for every
	 *  crypto asset (they settle in themselves). */
	accepted_assets: string[] | null;
	terms: string | null;
	/** ADR-0011 §10 — how this order's fee was paid. */
	fee_method: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr';
	/** Number of feedback rows received by this account — i.e. how many
	 *  RATINGS back `weighted_rating`.
	 *
	 *  v1.5.5: this used to double as the proxy for "trades completed where
	 *  this account was a party" because no trade data existed. It no longer
	 *  does — see `trade_count`. Conflating them made "★5.00 (34)" ambiguous
	 *  between 34 ratings and 34 trades, and let an unreviewed real trade
	 *  count for nothing. */
	feedback_count: number;
	/** v1.5.5 — REAL completed trades for this account, crediting BOTH sides
	 *  of every completed order and filtered for sock-puppet pairs. Drives
	 *  is_new_trader, min_trades and sort=trades. */
	trade_count: number;
	/** Average rating across all received feedback (1-5 scale).
	 *  Null when feedback_count is zero. */
	weighted_rating: string | null; // NUMERIC returns as string from pg
	/** MAX(created_at) of this account's included feedback — drives the
	 *  recency factor of the composite reputation score. NULL when the
	 *  account has no included feedback. */
	last_feedback_at: Date | null;
	/** Derived from feedback_count < 4 — shows the 🌱 sprout chip
	 *  during the account's first four counterparty reviews. The
	 *  underlying welcome-bonus trigger (accounts.first_trade_
	 *  complete_at) fires ONCE on the first review regardless;
	 *  this flag is purely a UI hint and shouldn't be confused
	 *  with the bonus trigger. */
	is_new_trader: boolean;
	/** Number of distinct accounts who have messaged this order's
	 *  owner about THIS order in the last 24h.  Derived via the
	 *  Q11-plumbed `chat_messages.order_permlink` column.  A high
	 *  value tells viewers "this seller is being actively asked
	 *  about, expect competition"; zero means "be the first to
	 *  reach out."  See Part-13 audit + #5 for design rationale. */
	engagement_24h: number;
	/** Timestamp of this account's first COMPLETED trade (earliest
	 *  counterparty feedback), from accounts.first_trade_complete_at.
	 *  NULL when the account has never completed a trade — the order
	 *  card then shows just the trade count with no "since {month}". */
	first_trade_complete_at: Date | null;
	/** Primary posting public key (base58 "BLT…") for the display-only
	 *  identity anchor on order cards. NULL when not captured yet. */
	posting_pubkey: string | null;
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
		// Part 121 — null for single-network assets; one of
		// erc20/trc20/spl/bep20 for USDT.
		asset_network: r.asset_network ?? null,
		fiat_currency: r.fiat_currency,
		amount_min: r.amount_min === null ? null : Number(r.amount_min),
		amount_max: r.amount_max === null ? null : Number(r.amount_max),
		price_model: r.price_model,
		location_region: r.location_region,
		payment_methods: r.payment_methods,
		accepted_assets: r.accepted_assets ?? null,
		terms: r.terms,
		fee_method: r.fee_method,
		feedback_count: r.feedback_count,
		weighted_rating: r.weighted_rating === null ? null : Number(r.weighted_rating),
		reputation_score: computeReputationScore({
			count: r.feedback_count,
			weightedAvg: r.weighted_rating === null ? null : Number(r.weighted_rating),
			lastFeedbackAtMs: r.last_feedback_at === null ? null : r.last_feedback_at.getTime()
		}),
		trade_count: r.trade_count,
		is_new_trader: r.is_new_trader,
		engagement_24h: r.engagement_24h,
		first_trade_at:
			r.first_trade_complete_at === null ? null : r.first_trade_complete_at.toISOString(),
		posting_pubkey: r.posting_pubkey ?? null,
		created_at: r.created_at.toISOString(),
		updated_at: r.updated_at.toISOString(),
		expires_at: r.expires_at === null ? null : r.expires_at.toISOString()
	};
}

export function orderbookRoute(db: Database, poller: Poller, operatorAccount: string): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		const parsed = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
		if (!parsed.success) {
			return c.json(
				errorBody('bad_request', parsed.error.issues.map((i) => i.message).join('; ')),
				400
			);
		}
		const q = parsed.data;
		const limit = q.limit ?? DEFAULT_LIMIT;

		// Build parameterized SQL. Every filter is optional; we
		// concatenate WHERE clauses and parameter indices.
		// Base clauses: only live orders with an established fee
		// appear in the public orderbook. Both 'verified' (indexer
		// saw the BLURT transfer) and 'verified_by_attestation'
		// (community validators attested an external-chain
		// payment for BTC/XMR fees) count as established —
		// Finding I's attestation path is a first-class
		// verification route equivalent to native BLURT fees for
		// the orderbook's purpose. Un-verified, under-paid, or
		// pending_external orders are visible via
		// /v1/orders/:account (owner's view) but not here.
		//
		// BATCH19A-orderbook-1 (2026-05-02 audit): also exclude
		// orders whose expires_at has passed.  No sweep job
		// flips status='live' → 'expired' when expires_at
		// arrives (status='expired' is a valid CHECK constraint
		// value but nothing currently writes it), so without
		// this filter the orderbook serves stale entries
		// indefinitely.  The filter uses NOW() so an order's
		// visibility is computed per-request — no cron needed,
		// no race window between sweep frequency and request
		// arrival.
		const where: string[] = [
			`o.status = 'live'`,
			`o.fee_status IN ('verified', 'verified_by_attestation')`,
			`(o.expires_at IS NULL OR o.expires_at > NOW())`
		];
		const params: unknown[] = [];
		const p = (v: unknown): string => {
			params.push(v);
			return `$${params.length}`;
		};

		// beta5 — instance-local moderation: hide listings from accounts
		// this operator has blocked (operator_blocks, state='blocked';
		// local OR chain-origin both apply). Keeps blocked sellers out of
		// the public orderbook on THIS instance only.
		where.push(
			`NOT EXISTS (SELECT 1 FROM operator_blocks ob WHERE ob.operator = ${p(operatorAccount)} AND ob.blocked = o.account AND ob.state = 'blocked')`
		);

		if (q.asset) where.push(`o.asset = ${p(q.asset)}`);
		if (q.side) where.push(`o.side = ${p(q.side)}`);
		if (q.fiat_currency) {
			// One or more ISO codes — match orders in ANY of them.
			const fiats = q.fiat_currency.split(',').map((s) => s.toUpperCase());
			where.push(`o.fiat_currency = ANY(${p(fiats)}::text[])`);
		}
		if (q.location_region) {
			// U2.1 — NFC-normalize filter input so it byte-matches
			// the NFC-stored values from order/orderReplace handlers
			// (post-§F.21 O3.4).  Without this, a user submitting
			// decomposed-form input doesn't match their own
			// NFC-stored orders.
			const normalizedRegion = q.location_region.normalize('NFC');
			// Case-insensitive prefix match with LIKE metacharacters
			// escaped so "100%" stays literal.
			where.push(`o.location_region ILIKE ${p(escapeLike(normalizedRegion) + '%')} ESCAPE '\\'`);
		}
		if (q.payment_methods) {
			// Split the comma-separated token list, trim, validate each
			// token (avoid arbitrary string injection into an array
			// literal — pg binds as text[] so a malicious payload would
			// be text, not SQL, but we still guard on length).
			//
			// Matching is case-INSENSITIVE: a user who posted
			// "PayPal" should match a filter for "paypal" or "PAYPAL".
			// We lowercase the query tokens here and use a correlated
			// EXISTS over unnest(payment_methods) with lower() on
			// each row value. This is slower than the former `&&`
			// array-overlap operator (GIN-indexable), but correct
			// for the UX — and orderbook scale (live orders in the
			// thousands) makes the per-row lower() cost negligible.
			//
			// U2.1 — also NFC-normalize for the same reason as
			// location_region above.
			const methods = q.payment_methods
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0 && s.length <= 32)
				.map((s) => s.normalize('NFC').toLowerCase());
			if (methods.length === 0) {
				return c.json(errorBody('bad_request', 'payment_methods: no valid tokens'), 400);
			}
			where.push(
				`EXISTS (SELECT 1 FROM unnest(o.payment_methods) pm WHERE lower(pm) = ANY(${p(methods)}::text[]))`
			);
		}

		// Minimum-trades filter. Requires the feedback aggregate
		// subquery (joined below). We reference f.c, treating NULL
		// (no feedback rows at all) as zero.
		if (typeof q.min_trades === 'number' && q.min_trades > 0) {
			// v1.5.5 — filters REAL completed trades. This read `f.c` (the
			// FEEDBACK count) while calling itself min_trades, so the orderbook
			// could show "3 trades · ★…" from the new count and still filter
			// that trader out at min_trades=3 because they had 2 reviews. Two
			// different numbers under one name.
			where.push(`COALESCE(tc.c, 0) >= ${p(q.min_trades)}`);
		}

		// Sort mode. Default "recent" preserves pre-phase-5d
		// ordering; "rating"/"trades" surface top traders without
		// hiding anyone. Cursor seek logic below adapts to each
		// sort mode.
		const sort = q.sort ?? 'recent';

		// Cursor — seek to the row strictly *after* the cursor in
		// the current sort order. The cursor carries the sort mode
		// it was minted under; if the client's current request uses
		// a different sort, the seek semantics don't make sense, so
		// we return 400 and the frontend re-fetches from the top.
		if (q.cursor) {
			const c2 = narrowCursor(decodeCursor(q.cursor));
			if (!c2) {
				return c.json(errorBody('bad_request', 'invalid cursor'), 400);
			}
			// Old cursors (pre-sort) decode with s=undefined, which
			// we treat as "recent" — that's the only sort that
			// existed when they were minted.
			const cursorSort = c2.s ?? 'recent';
			if (cursorSort !== sort) {
				return c.json(errorBody('bad_request', 'cursor sort mismatch — reset pagination'), 400);
			}

			const uParam = p(new Date(c2.u));
			const aParam = p(c2.a);
			const pParam = p(c2.p);

			if (sort === 'recent') {
				// Existing three-term tuple seek (updated_at DESC,
				// account ASC, permlink ASC).
				where.push(
					`(o.updated_at < ${uParam} OR ` +
						`(o.updated_at = ${uParam} AND o.account > ${aParam}) OR ` +
						`(o.updated_at = ${uParam} AND o.account = ${aParam} AND o.permlink > ${pParam}))`
				);
			} else if (sort === 'rating') {
				// Primary: weighted_rating DESC NULLS LAST.
				// Secondary: feedback_count DESC.
				// Tertiary...: updated_at DESC, account ASC, permlink ASC.
				// When the cursor's r is NULL, we're already in the
				// NULLS-LAST tail — all subsequent rows also have
				// NULL rating, so we just continue on the
				// tie-breakers.
				if (c2.r === null || c2.r === undefined) {
					where.push(
						`(f.r IS NULL AND ` +
							`(COALESCE(f.c, 0) < ${p(c2.c ?? 0)} OR ` +
							`(COALESCE(f.c, 0) = ${p(c2.c ?? 0)} AND (o.updated_at < ${uParam} OR ` +
							`(o.updated_at = ${uParam} AND o.account > ${aParam}) OR ` +
							`(o.updated_at = ${uParam} AND o.account = ${aParam} AND o.permlink > ${pParam})))))`
					);
				} else {
					const rParam = p(c2.r);
					const cParam = p(c2.c ?? 0);
					where.push(
						`(f.r < ${rParam} OR f.r IS NULL OR ` +
							`(f.r = ${rParam} AND (COALESCE(f.c, 0) < ${cParam} OR ` +
							`(COALESCE(f.c, 0) = ${cParam} AND (o.updated_at < ${uParam} OR ` +
							`(o.updated_at = ${uParam} AND o.account > ${aParam}) OR ` +
							`(o.updated_at = ${uParam} AND o.account = ${aParam} AND o.permlink > ${pParam})))))` +
							`)`
					);
				}
			} else {
				// sort === 'trades'
				// v1.5.5 — Primary: trade_count DESC (was feedback_count, the
				// pre-v1.5.5 proxy). "Most experienced first" must mean most
				// TRADES, or an unreviewed veteran sorts below a chatty novice.
				// Tiebreakers updated_at DESC, account ASC, permlink ASC.
				const cParam = p(c2.c ?? 0);
				where.push(
					`(COALESCE(tc.c, 0) < ${cParam} OR ` +
						`(COALESCE(tc.c, 0) = ${cParam} AND (o.updated_at < ${uParam} OR ` +
						`(o.updated_at = ${uParam} AND o.account > ${aParam}) OR ` +
						`(o.updated_at = ${uParam} AND o.account = ${aParam} AND o.permlink > ${pParam}))))`
				);
			}
		}

		// ORDER BY driven by sort mode. Tiebreakers are always
		// updated_at DESC, account ASC, permlink ASC — this stable
		// ordering is what makes the cursor-seek logic deterministic
		// when sort values match across rows.
		let orderBy: string;
		if (sort === 'rating') {
			orderBy =
				'f.r DESC NULLS LAST, COALESCE(f.c, 0) DESC, o.updated_at DESC, o.account ASC, o.permlink ASC';
		} else if (sort === 'trades') {
			// v1.5.5 — sorts REAL trades. This MUST stay in lockstep with the
			// sort='trades' seek predicate above: the cursor's `c` is compared
			// against the same expression the ORDER BY uses, so if one reads
			// tc.c and the other f.c the seek walks a different ordering than
			// the sort produces and pagination silently skips or repeats rows.
			orderBy = 'COALESCE(tc.c, 0) DESC, o.updated_at DESC, o.account ASC, o.permlink ASC';
		} else {
			orderBy = 'o.updated_at DESC, o.account ASC, o.permlink ASC';
		}

		const sql = `SELECT o.account, o.permlink, o.side, o.asset, o.asset_network, o.fiat_currency,
			        o.amount_min::text, o.amount_max::text, o.price_model,
			        o.location_region, o.payment_methods, o.accepted_assets, o.terms,
			        o.fee_method,
			        COALESCE(f.c, 0)::int AS feedback_count,
			        CASE WHEN f.r IS NOT NULL THEN f.r::text ELSE NULL END AS weighted_rating,
			        f.last_feedback_at,
			        -- v1.5.5 — REAL completed trades, not the feedback proxy.
			        -- Everything trade-shaped on this endpoint (is_new_trader,
			        -- min_trades, sort=trades) used feedback_count as a stand-in
			        -- because no trade data existed. It does now: completions
			        -- credit BOTH parties, so a taker who owns no order finally
			        -- has a count, and a trade nobody reviewed still counts.
			        COALESCE(tc.c, 0) AS trade_count,
			        (COALESCE(tc.c, 0) < 4) AS is_new_trader,
			        COALESCE(e.distinct_senders_24h, 0)::int AS engagement_24h,
			        a.first_trade_complete_at,
			        a.posting_pubkey,
			        o.created_at, o.updated_at, o.expires_at
			 FROM orders o
			 ${feedbackAggregateJoin('o')}
${tradeCountJoin('o')}
			 ${engagementJoin('o')}
			 ${accountsJoin('o', 'a')}
			 WHERE ${where.join(' AND ')}
			 ORDER BY ${orderBy}
			 LIMIT ${p(limit + 1)}`;

		const result = await db.query<OrderRow>(sql, params);
		const rows = result.rows;

		// If we got limit+1 rows, there's more to fetch. Trim to limit
		// and emit a cursor pointing to the last returned row. The
		// cursor includes the sort mode and the sort-value fields
		// needed for the next page's seek.
		let nextCursor: string | null = null;
		if (rows.length > limit) {
			rows.pop(); // trim the lookahead row
			const last = rows[rows.length - 1]!;
			const cursorPayload: Cursor = {
				u: last.updated_at.toISOString(),
				a: last.account,
				p: last.permlink,
				s: sort,
				// v1.5.5 — `c` is the cursor's numeric seek key, and the two sorts
				// key off DIFFERENT columns now: sort=rating still tiebreaks on
				// the FEEDBACK count, while sort=trades is primary-keyed on the
				// TRADE count. Minting feedback_count for both would make the
				// trades seek compare a rating count against a trade count and
				// silently skip or repeat rows across pages.
				c: sort === 'trades' ? last.trade_count : last.feedback_count,
				r: last.weighted_rating === null ? null : Number(last.weighted_rating)
			};
			nextCursor = encodeCursor(cursorPayload);
		}

		return c.json({
			items: rows.map(rowToWire),
			next_cursor: nextCursor,
			indexed_block: poller.getStatus().indexedBlock
		});
	});

	return app;
}
