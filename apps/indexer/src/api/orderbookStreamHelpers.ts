/**
 * Morphit indexer — orderbook-stream pure helpers.
 *
 * Extracted out of orderbookStream.ts so they're testable in
 * environments where the Hono runtime isn't installed (the
 * tsx smoke runner).  The Hono SSE wiring stays in
 * orderbookStream.ts; this file is platform-independent
 * pure functions.
 *
 * The zod query schema also lives in orderbookStream.ts (not
 * here) because the smoke runner doesn't have zod installed
 * and the schema is only used by the HTTP route layer.  This
 * module exposes a plain TS interface for the same shape.
 *
 * Mirror of the instancesStream / instancesStreamHelpers split.
 */

import { escapeLike } from '$api/shared';
import { computeReputationScore } from '$indexer/reputation/score';
import type { AssetTicker } from '@morphit/asset-registry';

/** Filter shape accepted by the orderbook-stream WHERE-clause
 *  builder.  Mirrors the zod schema in orderbookStream.ts but
 *  is a plain TS interface so the smoke runner doesn't need
 *  zod installed. */
export interface OrderbookStreamQuery {
	asset?: AssetTicker;
	side?: 'buy' | 'sell';
	fiat_currency?: string;
	location_region?: string;
	payment_methods?: string;
	min_trades?: number;
}

export interface OrderbookStreamRow {
	account: string;
	permlink: string;
	side: 'buy' | 'sell';
	asset: AssetTicker;
	fiat_currency: string;
	amount_min: string | null;
	amount_max: string | null;
	price_model: string | null;
	location_region: string | null;
	payment_methods: string[];
	terms: string | null;
	fee_method: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr' | null;
	feedback_count: number;
	weighted_rating: string | null;
	/** MAX(created_at) of included feedback — recency factor for the
	 *  composite reputation score. NULL when no included feedback. */
	last_feedback_at: Date | null;
	is_new_trader: boolean;
	engagement_24h: number;
	/** accounts.first_trade_complete_at — earliest completed trade;
	 *  NULL when none. Drives "N trades since {month}" on order cards. */
	first_trade_complete_at: Date | null;
	/** Primary posting public key for the display-only card identity
	 *  anchor. NULL when not captured yet. */
	posting_pubkey: string | null;
	created_at: Date;
	updated_at: Date;
	expires_at: Date | null;
}

/** Convert a DB row to the wire shape the frontend expects.
 *  Numerics arrive from pg as strings (NUMERIC type guards
 *  precision); we coerce to JS number here because the wire
 *  format is JSON.  Loss of precision past ~15 digits is
 *  acceptable for the user-facing amount range; the source
 *  of truth (chain) preserves full precision. */
export function rowToWire(r: OrderbookStreamRow): Record<string, unknown> {
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
		fee_method: r.fee_method,
		feedback_count: r.feedback_count,
		weighted_rating: r.weighted_rating === null ? null : Number(r.weighted_rating),
		reputation_score: computeReputationScore({
			count: r.feedback_count,
			weightedAvg: r.weighted_rating === null ? null : Number(r.weighted_rating),
			lastFeedbackAtMs: r.last_feedback_at === null ? null : r.last_feedback_at.getTime()
		}),
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

/** SQL WHERE-clause builder.  Mirrors the REST orderbook
 *  endpoint's filter rules; produces a list of clauses to be
 *  AND-joined plus the parameter list to bind.  startIndex is
 *  for callers that have already bound earlier params (e.g.,
 *  the per-row lookup binds account+permlink as $1,$2 then
 *  passes startIndex=2). */
export function buildWhereClauses(
	q: OrderbookStreamQuery,
	startIndex = 0,
	operatorAccount = ''
): { where: string[]; params: unknown[] } {
	const where: string[] = [
		`o.status = 'live'`,
		`o.fee_status IN ('verified', 'verified_by_attestation')`,
		// BATCH19A-orderbook-1 (2026-05-02 audit): exclude
		// past-expires_at orders.  See orderbook.ts and audit
		// Part 17 finding BATCH19A-orderbook-1 for full
		// rationale.  Note: SSE clients re-evaluate this
		// predicate on every snapshot and on every per-row
		// lookup, so an order silently fades when its
		// expires_at passes — no event is emitted, but the
		// next snapshot won't include it.
		`(o.expires_at IS NULL OR o.expires_at > NOW())`
	];
	const params: unknown[] = [];
	const p = (v: unknown): string => {
		params.push(v);
		return `$${startIndex + params.length}`;
	};

	// beta5 — instance-local block: never surface (snapshot, live emit,
	// or fallback poll) a listing from an account this operator blocked.
	// buildWhereClauses is the single chokepoint for all three SSE
	// paths, so the live stream can't leak a blocked account's new order.
	// The `operatorAccount` param is config.operatorAccountName — the
	// per-instance operator that operatorBlock.ts keys blocks under (NOT
	// officialAccountName, the federation-wide release-signer; cp257
	// renamed this param from the misleading `officialAccount`). Skipped
	// only when no account is supplied (direct unit calls).
	if (operatorAccount !== '') {
		where.push(
			`NOT EXISTS (SELECT 1 FROM operator_blocks ob WHERE ob.operator = ${p(operatorAccount)} AND ob.blocked = o.account AND ob.state = 'blocked')`
		);
	}

	if (q.asset) where.push(`o.asset = ${p(q.asset)}`);
	if (q.side) where.push(`o.side = ${p(q.side)}`);
	if (q.fiat_currency) {
		const fiats = q.fiat_currency.split(',').map((s) => s.toUpperCase());
		where.push(`o.fiat_currency = ANY(${p(fiats)}::text[])`);
	}
	if (q.location_region) {
		const normalizedRegion = q.location_region.normalize('NFC');
		where.push(`o.location_region ILIKE ${p(escapeLike(normalizedRegion) + '%')} ESCAPE '\\'`);
	}
	if (q.payment_methods) {
		const methods = q.payment_methods
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && s.length <= 32)
			.map((s) => s.normalize('NFC').toLowerCase());
		if (methods.length > 0) {
			where.push(
				`EXISTS (SELECT 1 FROM unnest(o.payment_methods) pm WHERE lower(pm) = ANY(${p(methods)}::text[]))`
			);
		}
	}
	if (typeof q.min_trades === 'number' && q.min_trades > 0) {
		where.push(`COALESCE(f.c, 0) >= ${p(q.min_trades)}`);
	}
	return { where, params };
}

/** SSE frame formatter.  Same shape as the instances stream. */
export function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─── F-6 audit fix: per-orderId fetch serializer ─────────────────

/** State of an in-flight fetch for a particular orderId.
 *  undefined = idle (no work in flight). */
export type FetchState = 'in-flight' | 'in-flight-dirty';

/** Construct a per-orderId serializer.  Guarantees at-most-one
 *  concurrent fetch per orderId; concurrent emits for the same
 *  orderId coalesce into "fetch again on completion."
 *
 *  Returns:
 *    - schedule(orderId): call when an emit arrives.  Idempotent
 *      against in-flight state.
 *    - state: a Map exposed for inspection by tests.  In production
 *      callers should not modify it.
 *
 *  Exposed as a pure helper for testability — the actual fetch
 *  body lives in the SSE handler closure, but the state-machine
 *  decisions don't depend on the fetch body and can be tested
 *  independently. */
export function makeFetchSerializer(
	doFetch: (orderId: string) => Promise<void>,
	isCancelled: () => boolean = () => false
): {
	schedule: (orderId: string) => void;
	state: Map<string, FetchState>;
} {
	const state = new Map<string, FetchState>();
	const schedule = (orderId: string): void => {
		if (isCancelled()) return;
		const current = state.get(orderId);
		if (current === 'in-flight') {
			state.set(orderId, 'in-flight-dirty');
			return;
		}
		if (current === 'in-flight-dirty') {
			return;
		}
		state.set(orderId, 'in-flight');
		void (async () => {
			while (!isCancelled()) {
				try {
					await doFetch(orderId);
				} catch {
					// Caller's doFetch is responsible for its own
					// error handling / logging.  We swallow here to
					// keep the loop alive.
				}
				const s = state.get(orderId);
				if (s === 'in-flight-dirty') {
					state.set(orderId, 'in-flight');
					continue;
				}
				state.delete(orderId);
				return;
			}
			// Cancelled during loop — cleanup left for caller's
			// closure GC; clearing here is cosmetic.
			state.delete(orderId);
		})();
	};
	return { schedule, state };
}
