/**
 * Handler: morphit_feature_bid_v1 (Phase 5 item 5 — featured-slot auction).
 *
 * Payload shape:
 *   {
 *     "order_permlink": string (must match a live order by the signer),
 *     "hours_requested": integer (6..168, i.e. 6h to 1 week)
 *   }
 *
 * Fee model:
 *   The op MUST be accompanied by a sibling transfer of
 *   (config.featureFeeBlurtPerHour × hours_requested) BLURT from the
 *   signer to config.feeRecipient with memo
 *   `morphit-feature:<permlink>`. Same pattern as listing fees.
 *   Underpayment rejects the bid; overpayment is credited to the
 *   bidder (they chose to pay more) but still just buys
 *   hours_requested hours of featured-slot time.
 *
 * Effect:
 *   Inserts one row into `featured_slot_bids`. No state mutation on
 *   the referenced order — queries against /v1/orderbook/featured
 *   JOIN across at read time.
 *
 * Rejection reasons (all slugs, lodged in event_log):
 *   - payload_not_object
 *   - order_permlink_not_string / _bad_chars
 *   - hours_requested_not_integer / _out_of_range
 *   - referenced_order_not_found
 *   - referenced_order_not_live
 *   - not_order_author (bidder must own the order)
 *   - fee_missing
 *   - fee_underpaid
 *   - bid_increment_too_small (would displace a visible-slot
 *     bid by less than max(1 BLURT/hour, 5%))
 *
 * Idempotency:
 *   trx_id UNIQUE constraint means a replay of the same op is a
 *   no-op (handler returns ok without inserting a duplicate row).
 *   This is important because a feature-bid op's fee is non-trivial
 *   — we must not double-charge a legit bidder for a network-retry
 *   re-broadcast.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { validateOrderPermlink } from '$indexer/permlink';
import { canonicalShareOk, sumFeeTransfers } from '$indexer/fee';
import { CANONICAL_TREASURY } from '../../config/canonicalTreasury';
import { logger } from '$log';
import { localize, normalizeLocale } from '$indexer/pushLocalize';

const log = logger('featureBid');

// Minimum bid duration: 6 hours.  Anti-sniping floor — without
// this, a one-hour bid at slightly higher blurt_per_hour can
// displace a multi-day bidder for the cost of just one hour, and
// the displaced bidder gets no refund for their lost slot time.
// 6 hours is a soft floor: short enough to be useful for legitimate
// "feature my new listing during today's busiest hours" use cases,
// long enough that the cheapest displacement attack costs 6×
// instead of 1×.  Operators who decide a different floor is right
// for their community can edit this constant in the source —
// it's deliberately a code constant rather than env-tunable
// because changing it changes auction dynamics for everyone in
// the federation.  See REVISIT-LIST §G "Featured-slot auction
// refinements" for the longer-term anti-sniping design discussion.
const MIN_HOURS = 6;
const MAX_HOURS = 168; // one week

/** Mirror of MAX_SLOTS in `apps/indexer/src/api/featuredOrderbook.ts`.
 *  See "Min-bid increment" block in handle() below for why this
 *  lives here.  If you change one, change both. */
const MAX_SLOTS_VISIBLE = 5;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Postgres SQLSTATE 23505 = unique_violation. */
function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: unknown }).code === '23505'
	);
}

/** cp408 — the feature-fee sibling transfer(s) are located + summed by the
 *  shared `sumFeeTransfers` in `$indexer/fee`, which honors the payment-time
 *  federation split (90% owner / 10% canonical, memo `morphit-feature:<permlink>`). */

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) return { ok: false, reason: 'payload_not_object' };

	// ─── Field validation ─────────────────────────────────────────

	const permlinkFail = validateOrderPermlink(ctx.payload.order_permlink);
	if (permlinkFail) {
		// Map order-side failure codes to the chat-handler-facing
		// pair this handler already documented (order_permlink_*).
		if (permlinkFail === 'permlink_not_string') {
			return { ok: false, reason: 'order_permlink_not_string' };
		}
		return { ok: false, reason: 'order_permlink_bad_chars' };
	}
	const permlink = ctx.payload.order_permlink as string;

	const hours = ctx.payload.hours_requested;
	if (typeof hours !== 'number' || !Number.isInteger(hours)) {
		return { ok: false, reason: 'hours_requested_not_integer' };
	}
	if (hours < MIN_HOURS || hours > MAX_HOURS) {
		return { ok: false, reason: 'hours_requested_out_of_range' };
	}

	// ─── Referenced order must exist, be live, have an established
	//     listing fee, and belong to the bidder.
	//
	// Why fee_status too: without this check, a user can pay a
	// feature-bid fee on an order whose own listing fee hasn't
	// verified yet. The bid row would sit inert (the featured
	// endpoint filters on fee_status IN ('verified',
	// 'verified_by_attestation')), so the user spent BLURT for a
	// slot that activates later than expected. Rejecting early
	// lets the per-op savepoint roll the transfer back, so the
	// user keeps their BLURT. Both 'verified' (native BLURT fee)
	// and 'verified_by_attestation' (community-attested external-
	// chain fee, Finding I) count here — equally legitimate for
	// the featured orderbook.
	//
	// Lookup is by (account, permlink) — the orders PRIMARY KEY.
	// Filtering on permlink alone is unsafe because different
	// accounts can share a permlink (Finding O27); the SELECT
	// would return an arbitrary row and the per-account
	// authorization check below could spuriously pass against
	// somebody else's order.
	const orderRow = await client.query<{
		status: string;
		fee_status: string;
	}>(
		`SELECT status, fee_status FROM orders
		 WHERE account = $1 AND permlink = $2`,
		[ctx.signer, permlink]
	);
	if (orderRow.rowCount === 0) {
		// Either no order with this permlink exists for the signer,
		// or the signer doesn't own one with this permlink.  Same
		// outward signal in either case — feature bids have
		// meaning only on your own listing.
		return { ok: false, reason: 'referenced_order_not_found' };
	}
	const order = orderRow.rows[0]!;
	if (order.status !== 'live') {
		return { ok: false, reason: 'referenced_order_not_live' };
	}
	if (order.fee_status !== 'verified' && order.fee_status !== 'verified_by_attestation') {
		return {
			ok: false,
			reason: 'referenced_order_fee_not_verified'
		};
	}

	// ─── Fee verification ─────────────────────────────────────────
	// cp408 — the feature fee is paid as a payment-time split (90% to this
	// instance's recipient + 10% to the canonical treasury, or a single 100%
	// transfer when the recipient is canonical). Sum both legs, then confirm
	// the canonical treasury received its cut.

	const fee = sumFeeTransfers(
		ctx.siblingOps,
		ctx.signer,
		ctx.config.feeRecipient,
		CANONICAL_TREASURY.blurt,
		`morphit-feature:${permlink}`
	);
	if (fee === null) {
		return { ok: false, reason: 'fee_missing' };
	}

	const expectedBlurt = ctx.config.featureFeeBlurtPerHour * hours;
	// Same tolerance as order-handler listing fees — fractional
	// BLURT arithmetic on the client side can produce ±0.001
	// rounding, so we accept within config.feeTolerance.
	const minAcceptable = expectedBlurt * (1 - ctx.config.feeTolerance);
	if (fee.totalBlurt < minAcceptable) {
		return { ok: false, reason: 'fee_underpaid' };
	}
	if (!canonicalShareOk(fee.totalBlurt, fee.toCanonicalBlurt)) {
		// Total paid, but the canonical treasury's 10% leg was missing/short.
		return { ok: false, reason: 'fee_underpaid' };
	}

	// ─── Min-bid increment (anti-pennywise displacement) ──────────
	//
	// REVISIT-LIST §G "Featured-slot auction refinements": prevent
	// 0.01-BLURT-over displacement of an existing visible-slot
	// bidder.  Without this, someone bids `currentTop + 0.01` and
	// displaces the current top for a trivial premium — which
	// invites penny-war bid spam and hostile displacement.
	//
	// Rule: if this bid would land in the top MAX_SLOTS_VISIBLE
	// (i.e., would actually displace someone currently visible),
	// it must beat the bid it displaces by at least
	// max(1 BLURT/hour, 5%).
	//
	// "The bid it displaces" = the LOWEST currently-visible bid
	// that this new bid would push out.  That's the
	// MAX_SLOTS_VISIBLE-th-ranked active bid by blurt_per_hour.
	// Bids landing at position MAX_SLOTS_VISIBLE+1 or later don't
	// displace anyone visible, so we accept them unconditionally
	// (they queue behind the current top-N and become visible if
	// someone above expires).
	//
	// MAX_SLOTS_VISIBLE matches MAX_SLOTS in
	// `apps/indexer/src/api/featuredOrderbook.ts` — kept as a
	// const here rather than imported because the handler module
	// doesn't otherwise depend on the API module and circular
	// imports are a hassle to chase.  If MAX_SLOTS changes there,
	// update here too (handler-coverage smoke does NOT catch this
	// drift; an integration test would).
	const newBidBlurtPerHour = fee.totalBlurt / hours;
	const visibleTop = await client.query<{ blurt_per_hour: string }>(
		`SELECT blurt_per_hour::text AS blurt_per_hour
		 FROM featured_slot_bids
		 WHERE cancelled = FALSE
		   AND effective_at <= $1
		   AND expires_at > $1
		 ORDER BY blurt_per_hour DESC, block_time_at ASC
		 OFFSET $2 LIMIT 1`,
		[ctx.blockTime, MAX_SLOTS_VISIBLE - 1]
	);
	if (visibleTop.rowCount === 1) {
		// There IS a bid at the would-be-displaced rank.  Require
		// the new bid to beat it by max(1 BLURT/hour, 5%).
		const displacedRate = Number(visibleTop.rows[0]!.blurt_per_hour);
		if (Number.isFinite(displacedRate) && newBidBlurtPerHour > displacedRate) {
			const requiredAbsolute = displacedRate + 1;
			const requiredRelative = displacedRate * 1.05;
			const requiredBeat = Math.max(requiredAbsolute, requiredRelative);
			if (newBidBlurtPerHour < requiredBeat) {
				return { ok: false, reason: 'bid_increment_too_small' };
			}
		}
		// If newBidBlurtPerHour <= displacedRate the bid lands at
		// position MAX_SLOTS_VISIBLE+1 or later (or ties for the
		// last visible slot, where the older bid wins per
		// `block_time_at ASC` tiebreak in featured-orderbook).
		// Either way no displacement; accept.
	}
	// If the rowCount is 0 there are < MAX_SLOTS_VISIBLE active
	// bids — the new bid lands in an unfilled visible slot, no
	// displacement, accept.

	// ─── Insert bid row ───────────────────────────────────────────

	const blurtPerHour = newBidBlurtPerHour;
	const expiresAt = new Date(ctx.blockTime.getTime() + hours * 60 * 60 * 1000);

	try {
		await client.query(
			`INSERT INTO featured_slot_bids (
				bidder, order_permlink, hours_requested,
				blurt_paid, blurt_per_hour,
				effective_at, expires_at,
				trx_id, block_num, block_time_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			[
				ctx.signer,
				permlink,
				hours,
				fee.totalBlurt,
				blurtPerHour,
				ctx.blockTime,
				expiresAt,
				ctx.trxId,
				ctx.blockNum,
				ctx.blockTime
			]
		);
	} catch (err) {
		if (isUniqueViolation(err)) {
			// Replay of the same op — the bid already exists.
			// Return ok so the dispatcher doesn't log a duplicate
			// "rejected" entry. The first application is the
			// authoritative one.
			return { ok: true };
		}
		throw err;
	}

	// ─── Anti-snipe extension (Part 122 cp18) ───────────────────
	// When a new bid arrives that would push someone out of the
	// top-MAX_SLOTS, AND any current top-MAX_SLOTS bid expires
	// within SNIPE_WINDOW_MINUTES, extend those expiring bids'
	// expires_at by SNIPE_EXTENSION_MINUTES.  Same "soft close"
	// pattern as eBay — the auction can't be sniped at T-2s
	// because the deadline moves.
	//
	// Cap at MAX_EXTENSIONS to prevent indefinite auction-drag:
	// if a bid has already been extended 6 times (30 min total
	// at 5-min granularity), stop extending it.  The bid will
	// then expire normally and a determined sniper wins one
	// slot — acceptable trade-off vs unbounded auction.
	//
	// Run BEFORE the outbid notification step so the rank query
	// downstream sees the extended expires_at values and
	// correctly identifies who's still visible vs displaced.
	//
	// Non-fatal on failure — bid is already recorded.  An
	// extension miss is a UX regression, not a data-loss event.
	const MAX_SLOTS_FOR_NOTIFY = 5;
	const SNIPE_WINDOW_MINUTES = 5;
	const SNIPE_EXTENSION_MINUTES = 5;
	const MAX_EXTENSIONS = 6;
	try {
		// Update all top-MAX_SLOTS_FOR_NOTIFY bids whose
		// expires_at is within the snipe window AND haven't
		// hit MAX_EXTENSIONS yet.  Excludes the new bid we
		// just inserted (its trx_id is ctx.trxId).
		//
		// The CTE picks the current top-MAX_SLOTS by the same
		// rank predicate as featuredOrderbook.ts; UPDATE...FROM
		// applies the extension to that subset.
		//
		// cp85-A1 — use ctx.blockTime, not NOW().  Same rationale
		// as strangerFee.ts:148 — handler must be deterministic
		// on indexer replay.  NOW() at replay time evaluates to
		// the replay machine's wall-clock, so the set of "top
		// visible bids" and "expiring within snipe window" would
		// differ from the original real-time pass, producing
		// different `extension_count` increments and divergent
		// state between operators replaying chain history.
		const extensionResult = await client.query<{ bid_id: string }>(
			`WITH visible AS (
				SELECT b.bid_id
				  FROM featured_slot_bids b
				 WHERE b.cancelled = FALSE
				   AND b.effective_at <= $6
				   AND b.expires_at > $6
				 ORDER BY b.blurt_per_hour DESC, b.block_time_at ASC
				 LIMIT $1
			)
			UPDATE featured_slot_bids b
			   SET expires_at = b.expires_at + ($3 * INTERVAL '1 minute'),
			       extension_count = b.extension_count + 1,
			       last_extended_at = $6
			  FROM visible v
			 WHERE b.bid_id = v.bid_id
			   AND b.trx_id <> $5
			   AND b.expires_at <= $6 + ($2 * INTERVAL '1 minute')
			   AND b.extension_count < $4
			RETURNING b.bid_id`,
			[
				MAX_SLOTS_FOR_NOTIFY,
				SNIPE_WINDOW_MINUTES,
				SNIPE_EXTENSION_MINUTES,
				MAX_EXTENSIONS,
				ctx.trxId,
				ctx.blockTime
			]
		);
		if (extensionResult.rows.length > 0) {
			log.info('anti_snipe_extended', {
				count: extensionResult.rows.length,
				new_bidder: ctx.signer,
				new_permlink: permlink,
				extension_minutes: SNIPE_EXTENSION_MINUTES
			});
		}
	} catch (err) {
		log.warn('anti_snipe_extension_failed', {
			bidder: ctx.signer,
			permlink,
			err: String((err as Error)?.message ?? err)
		});
	}

	// ─── Outbid notification (Part 122 cp17) ────────────────────
	// If this new bid pushed someone out of the top-N visible
	// set, enqueue a push_pending row for the displaced bidder.
	// They paid for a slot and just lost visibility — they
	// should know so they can decide whether to counter-bid.
	//
	// Strategy: query the bid currently at rank MAX_SLOTS+1
	// among active bids.  If our new bid is in the top-MAX_SLOTS
	// (rank <= MAX_SLOTS) AND there's a bid at rank MAX_SLOTS+1
	// that isn't our own, that bidder is who we displaced.
	//
	// Edge cases handled:
	//   - Our new bid didn't make top-N: no rank MAX_SLOTS+1 bidder
	//     to notify (we didn't displace anyone).
	//   - We had the only existing bid: no rank MAX_SLOTS+1 — no
	//     notification (no one was visible to displace).
	//   - Self-displacement (we already had a top-N bid and
	//     replaced ourselves with a higher one): the rank
	//     MAX_SLOTS+1 bid would be our OWN old bid; skip
	//     self-notification.
	//
	// Non-fatal on enqueue failure — bid is recorded; missing a
	// push is a UX regression, not a data-loss event.
	try {
		const rankResult = await client.query<{
			bidder: string;
			order_permlink: string;
			rank: string;
		}>(
			`WITH ranked AS (
				SELECT
					b.bidder,
					b.order_permlink,
					ROW_NUMBER() OVER (
						ORDER BY b.blurt_per_hour DESC, b.block_time_at ASC
					) AS rank
				FROM featured_slot_bids b
				WHERE b.cancelled = FALSE
				  AND b.effective_at <= $3
				  AND b.expires_at > $3
			)
			SELECT bidder, order_permlink, rank::text AS rank
			  FROM ranked
			 WHERE rank IN ($1, $2)
			 ORDER BY rank`,
			[MAX_SLOTS_FOR_NOTIFY, MAX_SLOTS_FOR_NOTIFY + 1, ctx.blockTime]
		);

		// Did our new bid make the top-N?
		const ourBidIsVisible = rankResult.rows.some(
			(r) =>
				r.bidder === ctx.signer &&
				r.order_permlink === permlink &&
				parseInt(r.rank, 10) <= MAX_SLOTS_FOR_NOTIFY
		);
		// Who's at rank MAX_SLOTS+1?
		const displaced = rankResult.rows.find(
			(r) => parseInt(r.rank, 10) === MAX_SLOTS_FOR_NOTIFY + 1
		);

		if (ourBidIsVisible && displaced && displaced.bidder !== ctx.signer) {
			// Read the displaced bidder's locale (cp14 pattern —
			// same query shape as feedback.ts and chat.ts).
			//
			// DD-meta-cp1718-1: skip the INSERT entirely if the
			// bidder has no push subscription on file.  The
			// push-sender will gracefully drop a no-subs row,
			// but enqueue-then-drop wastes work and pollutes the
			// `push_sender_drops_no_subscriptions` counter that
			// operators monitor.  When no subs exist, the locale
			// query returns 0 rows; that's our signal.
			const localeRow = await client.query<{ locale: string }>(
				`SELECT locale FROM push_subscriptions
				  WHERE account = $1
				  ORDER BY created_at DESC
				  LIMIT 1`,
				[displaced.bidder]
			);
			if (localeRow.rowCount === 0) {
				// No subscriptions — skip the INSERT.  The user
				// will still see their bid as "Outranked" in the
				// FeaturedBidHistory next time they open
				// /my/orders; push is best-effort.
			} else {
				const locale = normalizeLocale(localeRow.rows[0]?.locale);
				const titleStr = localize(locale, 'outbid_title');
				const bodyStr = localize(
					locale,
					'outbid_body',
					ctx.signer,
					displaced.order_permlink
				);
				await client.query(
					`INSERT INTO push_pending
					   (account, category, title, body, click_path, event_at)
					 VALUES ($1, 'order', $2, $3, $4, $5)`,
					[
						displaced.bidder,
						titleStr,
						bodyStr,
						`/my/orders#order-${displaced.order_permlink}`,
						ctx.blockTime
					]
				);
			}
		}
	} catch (err) {
		log.warn('outbid_notify_failed', {
			bidder: ctx.signer,
			permlink,
			err: String((err as Error)?.message ?? err)
		});
	}

	return { ok: true };
};

export default handle;
