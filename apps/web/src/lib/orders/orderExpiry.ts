/**
 * orderExpiry — effective (query-time) order status for the OWNER's view.
 *
 * WHY THIS EXISTS
 * ---------------
 * The indexer keeps an order's stored `status` at 'live' until a cancel op
 * or a periodic sweep, and enforces expiry at QUERY TIME via `expires_at >
 * now` (see apps/indexer/src/api/orderbook.ts and the price / featured
 * queries).  Consequence:
 *
 *   - The PUBLIC orderbook drops an expired order the instant its
 *     `expires_at` passes — even though the row still says status='live'.
 *   - The per-account query (`/v1/orders/:account`) that /my/orders loads
 *     returns the owner's own orders INCLUDING expired ones, each still
 *     carrying its stale stored status='live'.
 *
 * If /my/orders trusts that stored status, it shows a "Live" pill, a
 * "Visible in orderbook" badge, and a future expiry date on an order the
 * orderbook has already dropped (the bug this module fixes).  These helpers
 * mirror the indexer's query-time rule so the owner's view agrees with the
 * public orderbook.
 *
 * TIMEZONE
 * --------
 * `expires_at` is a Z-suffixed UTC ISO string — the indexer serialises every
 * timestamp with `Date.prototype.toISOString()`.  `Date.parse` reads the
 * trailing `Z` as UTC, so the comparison is timezone-correct on any client
 * with no manual offset.  A malformed timestamp yields `NaN`, and
 * `NaN <= now` is `false`, so a bad value FAILS SAFE (the order stays live
 * and visible to its owner) rather than silently vanishing.
 */

/** The minimal shape these helpers need from an OrderRecord. */
export interface OrderExpiryFields {
	readonly status?: 'live' | 'cancelled' | 'expired' | 'completed';
	readonly expires_at: string | null;
}

/**
 * True when the order should be treated as EXPIRED right now: either the
 * indexer already swept it to status='expired', or it is still stored as
 * 'live' but its `expires_at` has passed relative to `nowMs`.
 *
 * @param o     order (needs only `status` + `expires_at`)
 * @param nowMs current time in epoch ms (pass a reactive ticker so the
 *              caller re-evaluates as time advances)
 */
export function isOrderExpired(o: OrderExpiryFields, nowMs: number): boolean {
	if (o.status === 'expired') return true;
	if (o.status === 'live' && o.expires_at) {
		return Date.parse(o.expires_at) <= nowMs;
	}
	return false;
}

/**
 * True only for an order that is BOTH stored-live AND not past its
 * `expires_at` — i.e. actually visible in the public orderbook right now.
 */
export function isOrderLive(o: OrderExpiryFields, nowMs: number): boolean {
	return o.status === 'live' && !isOrderExpired(o, nowMs);
}
