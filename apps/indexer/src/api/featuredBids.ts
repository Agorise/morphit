/**
 * Morphit indexer — /v1/orderbook/featured/bids?account=X
 *
 * Returns recent featured-slot bids placed by `account` on their
 * own orders.  Used by the FeatureBidHistory UI to give a bidder
 * context on their own activity:
 *
 *   - What did I pay last time?
 *   - Is my current bid still in the top-N visible set?
 *   - Did my bid expire while the order was still live?
 *
 * Window: up to 30 most-recent bids by block_time_at, hard cap.
 * No cursor pagination — 30 rows is plenty for "your history at
 * a glance"; power users hit the chain explorer for the long
 * tail.
 *
 * Privacy:
 *   - `account` is a CHAIN-PUBLIC fact (bids are on-chain ops);
 *     this endpoint reveals nothing the chain doesn't.
 *   - No IPs, no session data; same privacy posture as the rest
 *     of the indexer's read-only API.
 *
 * Visibility computation:
 *   - For each bid, we compute `is_visible` = "would this bid
 *     appear in the top-MAX_SLOTS active set RIGHT NOW".  This
 *     requires computing the rank against all CURRENT active
 *     bids — the same predicate as /v1/orderbook/featured.
 *
 * Cache-Control: max-age=30 to match the featured-orderbook
 * endpoint; visibility flips when other bidders move and that
 * stabilizes over tens of seconds.
 *
 * Part 122 cp17.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Database } from '$db/pool';

const MAX_RESULTS = 30;
const MAX_SLOTS = 3;

/** Valid Blurt account name pattern.  Same regex used elsewhere
 *  in the indexer for input validation. */
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

const queryParams = z.object({
	account: z.string().regex(ACCOUNT_NAME_RE, 'invalid account name')
});

interface BidRow {
	order_permlink: string;
	hours_requested: number;
	blurt_paid: string;
	blurt_per_hour: string;
	effective_at: Date;
	expires_at: Date;
	is_visible_now: boolean;
	order_status: string;
	extension_count: number;
	last_extended_at: Date | null;
}

export function featuredBidsRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		const parsed = queryParams.safeParse({ account: c.req.query('account') });
		if (!parsed.success) {
			return c.json(
				{ error: 'invalid_params', details: parsed.error.issues[0]?.message },
				400
			);
		}
		const account = parsed.data.account;

		// One SQL roundtrip.  The "is_visible_now" computation uses
		// a window function: for each of `account`'s bids, compute
		// its rank among all currently-active bids by the same
		// (blurt_per_hour DESC, block_time_at ASC) ordering as the
		// featured-orderbook endpoint, then check rank ≤ MAX_SLOTS.
		//
		// We INNER-JOIN orders so we can also surface the order's
		// current status — a bid against a now-cancelled order
		// still appears in the history (educational), but won't
		// be visible regardless of rank.
		const rows = await db.query<BidRow>(
			`WITH active_ranks AS (
				-- Rank ONLY the currently-active bids (cancelled=false,
				-- effective_at past, expires_at future).  Ranking is by
				-- the same (blurt_per_hour DESC, block_time_at ASC) as
				-- featuredOrderbook.ts uses so visibility flips are
				-- consistent across the two endpoints.
				SELECT
					b.bid_id,
					ROW_NUMBER() OVER (
						ORDER BY b.blurt_per_hour DESC, b.block_time_at ASC
					) AS rank
				FROM featured_slot_bids b
				WHERE b.cancelled = FALSE
				  AND b.effective_at <= NOW()
				  AND b.expires_at > NOW()
			)
			SELECT
				b.order_permlink,
				b.hours_requested,
				b.blurt_paid::text AS blurt_paid,
				b.blurt_per_hour::text AS blurt_per_hour,
				b.effective_at,
				b.expires_at,
				-- Active and within top-MAX_SLOTS → visible.  Bids
				-- that aren't in active_ranks (cancelled or expired)
				-- are not visible by definition.
				(ar.rank IS NOT NULL AND ar.rank <= $2) AS is_visible_now,
				COALESCE(o.status, 'unknown') AS order_status,
				b.extension_count,
				b.last_extended_at
			FROM featured_slot_bids b
			LEFT JOIN active_ranks ar ON ar.bid_id = b.bid_id
			LEFT JOIN orders o
			  ON o.account = b.bidder
			 AND o.permlink = b.order_permlink
			WHERE b.bidder = $1
			ORDER BY b.block_time_at DESC
			LIMIT $3`,
			[account, MAX_SLOTS, MAX_RESULTS]
		);

		const bids = rows.rows.map((r) => ({
			order_permlink: r.order_permlink,
			hours_requested: r.hours_requested,
			blurt_paid: r.blurt_paid,
			blurt_per_hour: r.blurt_per_hour,
			effective_at: r.effective_at.toISOString(),
			expires_at: r.expires_at.toISOString(),
			is_visible: r.is_visible_now,
			order_status: r.order_status,
			extension_count: r.extension_count,
			last_extended_at: r.last_extended_at ? r.last_extended_at.toISOString() : null
		}));

		c.header('cache-control', 'max-age=30, public');
		return c.json({ account, bids, max_slots: MAX_SLOTS });
	});

	return app;
}
