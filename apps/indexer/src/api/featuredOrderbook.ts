/**
 * Morphit indexer — /v1/orderbook/featured endpoint.
 *
 * Returns the top 3 featured orders at the current moment. "Top"
 * means: among the bids that can hold a slot now
 * (featuredVisibility.eligibleFeaturedBidsSql: an active bid on an
 * order /v1/orderbook would show), the 3 highest blurt_per_hour,
 * ties broken by earliest block_time_at (first bidder wins ties).
 * The order's liveness is checked BEFORE the top 3 are taken, so a
 * bid on a cancelled or expired order never holds a slot it cannot
 * fill, and an order with no expiry can be featured.
 *
 * Response shape:
 *   {
 *     featured: Array<{
 *       order: { …same shape as /v1/orderbook list items… },
 *       bid: {
 *         hours_requested: number,
 *         blurt_paid: string,       // stringified NUMERIC
 *         blurt_per_hour: string,
 *         effective_at: ISO,
 *         expires_at: ISO
 *       }
 *     }>,
 *     max_slots: 3
 *   }
 *
 * The endpoint is deliberately non-paginated — 3 rows at most,
 * so cursor pagination would be theater. Clients that want a
 * bidder's full history hit the per-account endpoint instead.
 *
 * Cache-Control: max-age=10 because expires_at moves through time
 * but the winning set is stable for tens of seconds in practice.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import type { AssetTicker } from '@morphit/asset-registry';
import {
	feedbackAggregateJoin,
	accountsJoin,
	profileJoin,
	engagementJoin,
	tradeCountJoin,
	reputationSelectColumns,
	reputationFieldsFromRow,
	type ReputationRow
} from '$api/reputationJoin';
import { eligibleFeaturedBidsSql } from '$api/featuredVisibility';
import { sanitizeStoredProfileMetadata } from '$indexer/handlers/profile';

/** At most 3 concurrent featured slots. Keeps the feature scarce and
 *  visually manageable. */
const MAX_SLOTS = 3;

/**
 * One joined featured row. EXPORTED so the unit test's fixture can be
 * typed against it: the fixture was an untyped object literal, so a column
 * added to the query was simply absent from the fixture, `reputationFieldsFromRow`
 * mapped it to `undefined`, and `JSON.stringify` dropped the key — the endpoint
 * silently stopped emitting a field while the test stayed green. That is exactly
 * how `trade_count` went missing here.
 */
export interface FeaturedRow extends ReputationRow {
	// Order columns (subset matching /v1/orderbook list shape)
	account: string;
	permlink: string;
	side: 'buy' | 'sell';
	asset: AssetTicker;
	fiat_currency: string;
	amount_min: string | null;
	amount_max: string | null;
	price_model: Record<string, unknown>;
	location_region: string | null;
	payment_methods: string[];
	/** accepted crypto set for a BARTER order; null for crypto assets. */
	accepted_assets: string[] | null;
	specific_barter_title: string | null;
	terms: string | null;
	status: string;
	// v1.8.16 — inline poster identity, SELECTed via profileJoin. These
	// were joined + selected in v1.8.13 but never declared here nor emitted in
	// the wire mapping, so the featured payload carried NO inline identity and
	// FeaturedOrders.svelte fell back to an async fetch — the homepage cards
	// showed a placeholder/identicon and swapped in the real name/avatar a beat
	// later (tester3's "delayed" avatar). Same shape orderbook.ts emits.
	display_name: string | null;
	profile_json_metadata: unknown;
	updated_at: Date;
	expires_at_order: Date | null;
	fee_status: string;
	fee_method: string;
	// Bid columns
	hours_requested: number;
	blurt_paid: string;
	blurt_per_hour: string;
	effective_at: Date;
	expires_at_bid: Date;
	asset_network: string | null;
	created_at: Date;
	engagement_24h: number;
}

export function featuredRoute(db: Database, operatorAccount: string): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		// The CTE keeps the rank filter readable: first pick the
		// MAX_SLOTS winning bids among the eligible ones by
		// (blurt_per_hour DESC, block_time_at ASC), then join.
		//
		// The JOIN on (o.account = w.bidder AND o.permlink =
		// w.order_permlink) is required because orders are PRIMARY
		// KEY (account, permlink) — a permlink alone is NOT unique
		// across accounts.  Joining on permlink alone would mismatch
		// across accounts that happen to share a permlink, surfacing
		// the wrong account's order in the featured slot (Finding
		// O27 from the order-placement audit).  The featureBid
		// handler enforces "bidder == order author", so b.bidder is
		// the legitimate target account for any winning bid row.
		const rows = await db.query<FeaturedRow>(
			`WITH winning_bids AS (
				SELECT
					b.bidder,
					b.order_permlink,
					b.hours_requested,
					b.blurt_paid::text AS blurt_paid,
					b.blurt_per_hour::text AS blurt_per_hour,
					b.effective_at,
					b.expires_at AS expires_at_bid
				FROM (${eligibleFeaturedBidsSql('$2')}) b
				ORDER BY b.blurt_per_hour DESC, b.block_time_at ASC
				LIMIT $1
			)
			SELECT
				o.account, o.permlink, o.side, o.asset, o.asset_network, o.fiat_currency,
				o.amount_min::text AS amount_min,
				o.amount_max::text AS amount_max,
				o.price_model, o.location_region, o.payment_methods, o.accepted_assets,
				o.specific_barter_title,
				o.terms, o.status, o.created_at, o.updated_at,
				o.expires_at AS expires_at_order,
				o.fee_status, o.fee_method,
				${reputationSelectColumns('o', 'a')},
				-- v1.8.14: identity INLINE here too — a featured slot is the
				-- MOST prominent card on the page, so an identity that rewrites
				-- itself there is the worst possible place for it.
				pr.display_name,
				pr.json_metadata AS profile_json_metadata,
				COALESCE(e.distinct_senders_24h, 0)::int AS engagement_24h,
				w.hours_requested, w.blurt_paid, w.blurt_per_hour,
				w.effective_at, w.expires_at_bid
			FROM winning_bids w
			JOIN orders o
			  ON o.account = w.bidder
			 AND o.permlink = w.order_permlink
			${feedbackAggregateJoin('o', 'SELECT bidder FROM winning_bids')}
			${tradeCountJoin('o', 'tc', 'SELECT bidder FROM winning_bids')}
			${engagementJoin('o', 'SELECT bidder FROM winning_bids')}
			${accountsJoin('o', 'a')}
			${profileJoin('o', 'pr')}
			ORDER BY w.blurt_per_hour DESC, w.effective_at ASC`,
			[MAX_SLOTS, operatorAccount]
		);

		const featured = rows.rows.map((r) => ({
			order: {
				account: r.account,
				permlink: r.permlink,
				side: r.side,
				asset: r.asset,
				asset_network: r.asset_network ?? null,
				fiat_currency: r.fiat_currency,
				amount_min: r.amount_min,
				amount_max: r.amount_max,
				price_model: r.price_model,
				location_region: r.location_region,
				payment_methods: r.payment_methods,
				accepted_assets: r.accepted_assets ?? null,
				specific_barter_title: r.specific_barter_title ?? null,
				terms: r.terms,
				status: r.status,
				engagement_24h: r.engagement_24h,
				created_at: r.created_at.toISOString(),
				updated_at: r.updated_at.toISOString(),
				expires_at: r.expires_at_order === null ? null : r.expires_at_order.toISOString(),
				fee_status: r.fee_status,
				fee_method: r.fee_method,
				// featured cards render through the SHARED OrderCard, but the
				// row it was handed carried no reputation/identity columns, so the
				// 🌱 sprout, the ⭐ score, the trade count and the truncated posting
				// key silently vanished on exactly the cards a stranger is most
				// likely to click. Same join, same score function as /v1/orderbook.
				...reputationFieldsFromRow(r),
				// v1.8.16 — inline poster identity so the featured card shows
				// the real display name + avatar on FIRST paint, exactly like the
				// orderbook (profileJoin → rowToWire). Without these two the homepage
				// featured cards did a second round-trip and swapped @account +
				// identicon for the real identity a beat later — tester3's "delayed"
				// avatar. reputationFieldsFromRow is reputation-only by design, so
				// these live here alongside the other order columns.
				display_name: r.display_name ?? null,
				profile_json_metadata:
					r.profile_json_metadata == null
						? null
						: sanitizeStoredProfileMetadata(r.profile_json_metadata)
			},
			bid: {
				hours_requested: r.hours_requested,
				blurt_paid: r.blurt_paid,
				blurt_per_hour: r.blurt_per_hour,
				effective_at: r.effective_at.toISOString(),
				expires_at: r.expires_at_bid.toISOString()
			}
		}));

		// A 10 s cache absorbs homepage traffic while a new winning bid
		// still surfaces quickly; a long cache would let an expired slot
		// linger visibly past its deadline.
		c.header('cache-control', 'max-age=10, public');
		return c.json({ featured, max_slots: MAX_SLOTS });
	});

	return app;
}
