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

/** Locate the sibling transfer paying the feature fee. Same shape
 *  as order.ts's findFeeTransfer, but with a different memo
 *  namespace so listing fees and feature bids don't collide. */
function findFeatureFeeTransfer(
	siblingOps: readonly (readonly [string, Record<string, unknown>])[],
	signer: string,
	feeRecipient: string,
	permlink: string
): { amountBlurt: number } | null {
	const expectedMemo = `morphit-feature:${permlink}`;
	for (const op of siblingOps) {
		if (!op) continue;
		const [name, body] = op;
		if (name !== 'transfer') continue;
		const b = body as {
			from?: unknown;
			to?: unknown;
			amount?: unknown;
			memo?: unknown;
		};
		if (b.from !== signer) continue;
		if (b.to !== feeRecipient) continue;
		if (b.memo !== expectedMemo) continue;

		if (typeof b.amount !== 'string') continue;
		const match = /^(\d+(?:\.\d+)?)\s+BLURT$/.exec(b.amount);
		if (!match) continue;
		const amount = Number(match[1]);
		if (!Number.isFinite(amount) || amount <= 0) continue;

		return { amountBlurt: amount };
	}
	return null;
}

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

	const transfer = findFeatureFeeTransfer(
		ctx.siblingOps,
		ctx.signer,
		ctx.config.feeRecipient,
		permlink
	);
	if (transfer === null) {
		return { ok: false, reason: 'fee_missing' };
	}

	const expectedBlurt = ctx.config.featureFeeBlurtPerHour * hours;
	// Same tolerance as order-handler listing fees — fractional
	// BLURT arithmetic on the client side can produce ±0.001
	// rounding, so we accept within config.feeTolerance.
	const minAcceptable = expectedBlurt * (1 - ctx.config.feeTolerance);
	if (transfer.amountBlurt < minAcceptable) {
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
	const newBidBlurtPerHour = transfer.amountBlurt / hours;
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
				transfer.amountBlurt,
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

	return { ok: true };
};

export default handle;
