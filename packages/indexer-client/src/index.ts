import type { AssetTicker } from '@morphit/asset-registry';
/**
 * @morphit/indexer-client — shared types for the indexer HTTP API.
 *
 * Both the indexer itself (to validate its own response shapes) and
 * the frontend (to type its fetch wrappers) import from this package.
 * Keeping the types in one place means a mismatch fails type-check
 * before it fails at runtime.
 *
 * This module exports types only — no runtime code. Do not add
 * helpers here; they belong in the consuming app.
 */

// ─── Health ────────────────────────────────────────────────────────

export interface HealthResponse {
	readonly status: 'ok' | 'degraded';
	readonly version: string;
	readonly uptime_sec: number;
	readonly chain_head_block: number;
	readonly indexed_block: number;
	readonly lag_blocks: number;
	/** Human-readable context for `lag_blocks` (normal range +
	 *  seconds-behind at Blurt's 3s block time). Optional: indexers
	 *  older than v1.0.0-beta.14 don't send it. */
	readonly lag_blocks_note?: string;
	readonly stale: boolean;
}

// ─── Listing fee ───────────────────────────────────────────────────

/** Quote for the current listing fee. Returned by /v1/listing-fee.
 *  Frontend consumes this on the compose-order page to show the
 *  user the BLURT amount the indexer expects.
 *
 *  Fees are BLURT-native: `base_fee_blurt` is the tier-1 amount.
 *  Sybil-tier escalation (1×, 1×, 1×, 1.25×, ... compounding past
 *  10) is applied client-side from the user's recent-order count;
 *  the indexer verifies the same multiplier when the order op
 *  arrives.
 *
 *  Optional fields `base_fee_fiat`, `blurt_price_fiat`, and
 *  `denomination_fiat` are present iff the operator has enabled the
 *  BLURT/fiat price feed AND a live (non-stale) value is available.
 *  Used by the UI for ambient "(~$0.12)" subtext alongside BLURT
 *  amounts.  Frontends that don't see these fields just show BLURT
 *  only.
 *
 *  The `denomination_fiat` field tells the frontend which fiat the
 *  numeric values are in — operator-configured (USD, EUR, GBP, JPY,
 *  BRL, CNY, INR, RUB, AED, XDR, XAU, etc.).  Default USD.  See
 *  ADR-0040 for the design.
 *
 *  cp128 rename: pre-cp128 these were `base_fee_usd` and
 *  `blurt_price_usd`.  Renamed denomination-agnostic. */
export interface ListingFeeResponse {
	readonly base_fee_blurt: number;
	/** Per-hour BLURT cost for boosting an order to the featured
	 *  orderbook. */
	readonly feature_fee_blurt_per_hour: number;
	readonly quote_ttl_seconds: number;
	readonly base_fee_fiat?: number;
	readonly blurt_price_fiat?: number;
	readonly denomination_fiat?: string;
	/** cp127 defense H — NOT-AN-ORACLE warning string.  Present
	 *  alongside the `_fiat` fields.  Downstream protocols using
	 *  these numbers as oracle input do so against this explicit
	 *  recommendation.  See ADR-0039. */
	readonly price_warning?: string;
}

// ─── Order viewcounts (task #14) ───────────────────────────────────

/** GET /v1/orders/:account/:permlink/views response.  See
 *  apps/indexer/src/api/orderViews.ts header for the full
 *  privacy-design rationale.
 *
 *  In short: this endpoint is public-readable, but the
 *  frontend only DISPLAYS the count to the order's author.
 *  The count itself is non-identifying (a soft popularity
 *  signal), and we deliberately track no per-viewer detail. */
export interface OrderViewsResponse {
	readonly count: number;
	readonly updated_at: string | null;
}

/** POST /v1/orders/:account/:permlink/view response.  Returns
 *  the post-increment count. */
export interface OrderViewIncrementResponse {
	readonly count: number;
}

// ─── Orderbook ─────────────────────────────────────────────────────

/** An order's derived state, as stored in the indexer's `orders`
 *  table. Wire format is JSON-serialisable — all timestamps are
 *  ISO-8601 strings, numerics are plain numbers.
 *
 *  `status` and `fee_status` are present on responses from
 *  /v1/orders/:account (where a user sees all their orders
 *  regardless of state) but absent on /v1/orderbook (which
 *  only ever returns live orders with an established fee —
 *  either natively verified or attested — so the fields
 *  would be redundant). Hence optional.
 */
export interface OrderRecord {
	readonly account: string;
	readonly permlink: string;
	readonly side: 'buy' | 'sell';
	readonly asset: AssetTicker;
	readonly fiat_currency: string;
	readonly amount_min: number | null;
	readonly amount_max: number | null;
	readonly price_model: unknown; // opaque to the indexer; frontend interprets
	readonly location_region: string | null;
	readonly payment_methods: readonly string[];
	readonly terms: string | null;
	readonly status?: 'live' | 'cancelled' | 'expired';
	readonly fee_status?:
		| 'verified'
		// ADR-0011 sub-phase 4b: external-chain payment path for
		// BTC/XMR fees. 'pending_external' is the initial state
		// when the fee is declared; 'verified_by_attestation' is
		// set after ≥2 distinct attestors meet the Finding I
		// eligibility gate (100 BLURT loyalty OR 30-day account
		// age under 'launch' phase, AND under 'steady').
		| 'pending_external'
		| 'verified_by_attestation'
		// Order-placement audit Finding O19: this external_tx_id
		// has already been claimed by another order.  An attacker
		// trying to reuse one off-chain payment across multiple
		// listings hits this status.  The order is recorded for
		// audit visibility but is not part of the live orderbook.
		| 'reused'
		// Part 70 fix — type drift correction.  These three values
		// are emitted by the BLURT-fee verifier path AND are in
		// the DB CHECK constraint at apps/indexer/src/db/schema.sql,
		// but were missing from this published type.  The order-
		// detail page renders a branch for each.  Pre-Part-70 a
		// frontend rendering `order.fee_status === 'underpaid'`
		// failed svelte-check ("comparison appears unintentional;
		// types have no overlap") because the type narrowed to
		// only the 4 values above.
		| 'unverified'
		| 'missing'
		| 'underpaid';
	/** ADR-0011: how the fee was paid. Omitted on legacy
	 *  ADR-0009 orders (which were always BLURT). Values:
	 *    'blurt'              — standard sibling-transfer path
	 *    'waived_first_buy'   — onboarding waiver, one per account
	 *    'btc' / 'xmr'        — sub-phase 4b; not yet emitted */
	readonly fee_method?: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr';
	/** Part 121 / cp30 / cp31 — sub-network for multi-network assets
	 *  (USDT, USDC, DAI).  For USDT: one of 'erc20'|'trc20'|'spl'|
	 *  'bep20' when `asset === 'USDT'`.  For USDC: one of
	 *  'erc20'|'spl'|'base'|'polygon' when `asset === 'USDC'`.  For
	 *  DAI: one of 'erc20'|'polygon'|'base'|'arbitrum' when
	 *  `asset === 'DAI'`.  Null otherwise (pre-Part-121 rows and
	 *  orders with single-network assets BTC/XMR/BLURT/BCH/LTC/DASH/
	 *  DOGE). */
	readonly asset_network?: string | null;
	/** Number of feedback rows this account has received.
	 *  Proxy for "completed trades." Zero on accounts with no
	 *  feedback yet. */
	readonly feedback_count?: number;
	/** Weighted average rating (1-5) across received feedback.
	 *  Null when feedback_count is zero. */
	readonly weighted_rating?: number | null;
	/** True when the poster has fewer than 4 received feedback
	 *  rows. Drives the "🌱 New trader" chip in the frontend
	 *  orderbook. The underlying welcome-bonus trigger fires on
	 *  the first review regardless — this flag is purely a UI
	 *  hint that sticks around for the first four trades to give
	 *  newcomers a visible grace period. */
	readonly is_new_trader?: boolean;
	/** Number of distinct accounts who have messaged this order's
	 *  owner about THIS order in the last 24h.  Drives a "💬 N
	 *  talking now" chip on order rows.  Optional for backward
	 *  compatibility with pre-v25 indexer instances; older indexers
	 *  omit the field, which the frontend treats as "not enough
	 *  data, suppress the chip" rather than "zero engagement." */
	readonly engagement_24h?: number;
	readonly created_at: string;
	readonly updated_at: string;
	readonly expires_at: string | null;
}

export interface OrderbookQuery {
	readonly asset?: AssetTicker;
	readonly side?: 'buy' | 'sell';
	readonly fiat_currency?: string;
	readonly location_region?: string;
	/** Comma-separated list of payment methods. Matches any of. */
	readonly payment_methods?: string;
	/** Only include orders posted by accounts with ≥N received
	 *  feedback rows. Use 0 (or omit) to include all. */
	readonly min_trades?: number;
	/** Sort mode. Default 'recent' preserves behavior; 'rating'
	 *  surfaces highest-weighted-rating first; 'trades'
	 *  surfaces most-experienced traders first. */
	readonly sort?: 'recent' | 'rating' | 'trades';
	/** Opaque cursor from a previous response; omit for first page. */
	readonly cursor?: string;
	/** 1..100, default 50. */
	readonly limit?: number;
}

export interface OrderbookResponse {
	readonly items: readonly OrderRecord[];
	readonly next_cursor: string | null;
	readonly indexed_block: number;
}

// ─── Featured orderbook ───────────────────────────────────────────
//
// Phase 5 item 5 — featured-slot auction. Up to 5 concurrently
// active featured slots; `max_slots` surfaces the hard cap so
// clients can render "N of 5 slots filled" UX without guessing.

export interface FeaturedBid {
	/** Hours the bidder paid for. 1..168. */
	readonly hours_requested: number;
	/** Total BLURT paid for this bid, stringified NUMERIC. */
	readonly blurt_paid: string;
	/** Effective per-hour rate, used for rank-sort ties. */
	readonly blurt_per_hour: string;
	readonly effective_at: string;
	readonly expires_at: string;
}

export interface FeaturedSlot {
	readonly order: OrderRecord;
	readonly bid: FeaturedBid;
}

export interface FeaturedOrderbookResponse {
	readonly featured: readonly FeaturedSlot[];
	/** Currently 5; the indexer's hard cap. Exposed in the
	 *  response so the client doesn't have to hard-code it. */
	readonly max_slots: number;
}

// ─── Clearing-price history (featured-slot auction) ────────────────

/** Single day's clearing-price summary.  See
 *  apps/indexer/src/api/clearingPriceHistory.ts for the
 *  definition of "clearing price" — short version: the rate
 *  the lowest-ranked currently-visible bid was paying, i.e.
 *  the price you'd need to beat to displace someone visible.
 *
 *  When fewer than `max_slots` bids are active, the slot is
 *  under-filled and the clearing price is reported as 0
 *  (anyone with a positive bid would be visible). */
export interface ClearingPricePoint {
	/** Calendar day in UTC, formatted YYYY-MM-DD. */
	readonly day: string;
	/** Clearing rate in BLURT/hour; 0 when under-filled. */
	readonly clearing_blurt_per_hour: number;
	/** How many of the max_slots positions were filled this
	 *  day. 0..max_slots. */
	readonly active_visible_count: number;
	/** Currently 5; mirrors max_slots from the parent response
	 *  so per-point rendering doesn't need to look up. */
	readonly max_slots: number;
}

export interface ClearingPriceHistoryResponse {
	readonly points: readonly ClearingPricePoint[];
	/** Echo of the requested window: 7, 30, or 90. */
	readonly window_days: number;
	/** Currently 5; same as in FeaturedOrderbookResponse. */
	readonly max_slots: number;
}

// ─── Bid history (featured-slot auction) ───────────────────────────

/** A single bid placed by some account on one of their orders.
 *  Returned by /v1/orderbook/featured/bids?account=X.  Part 122
 *  cp17 — gives a bidder context on their own recent activity
 *  ("what did I pay last time, how did it perform"). */
export interface FeaturedBidHistoryEntry {
	/** Permlink of the bidder's own order that this bid promoted. */
	readonly order_permlink: string;
	readonly hours_requested: number;
	/** Total BLURT paid, stringified NUMERIC. */
	readonly blurt_paid: string;
	readonly blurt_per_hour: string;
	readonly effective_at: string;
	readonly expires_at: string;
	/** True if the bid is currently in the top-N visible
	 *  featured set.  When false but `expires_at` is still in
	 *  the future, the bid is "outranked" — paid for but not
	 *  visible because higher bidders occupy all slots. */
	readonly is_visible: boolean;
	/** Status of the underlying order at query time.  When the
	 *  order is no longer 'live' (cancelled / completed), the
	 *  bid won't appear in featured orderbook even if it would
	 *  rank — important UX context. */
	readonly order_status: string;
	/** Part 122 cp18 — number of anti-snipe extensions applied
	 *  to this bid.  Zero on a normally-elapsed bid; non-zero
	 *  if a later bidder triggered the soft-close extension
	 *  while this bid was in the top-MAX_SLOTS and expiring
	 *  within the snipe window. */
	readonly extension_count: number;
	/** ISO timestamp of the most-recent extension, or null if
	 *  never extended.  Part 122 cp18. */
	readonly last_extended_at: string | null;
}

export interface FeaturedBidHistoryResponse {
	readonly account: string;
	readonly bids: readonly FeaturedBidHistoryEntry[];
	/** Mirrors MAX_SLOTS so the client renders "ranked X / 5"
	 *  consistently with the rest of the auction UI. */
	readonly max_slots: number;
}

// ─── Orders by account ─────────────────────────────────────────────

export interface AccountOrdersResponse {
	readonly items: readonly OrderRecord[];
	readonly next_cursor: string | null;
}

// ─── Profiles ──────────────────────────────────────────────────────

export interface ProfileResponse {
	readonly account: string;
	readonly display_name: string;
	readonly json_metadata: unknown;
	readonly source_block_num: number;
	readonly updated_at: string;
}

/** Response shape for `GET /v1/profiles?accounts=alice,bob,...`.
 *  Keyed by account so callers can do `response.profiles[account]`
 *  directly. Accounts that don't have a profile row are silently
 *  absent — the caller uses `in` / optional chaining to distinguish.
 *
 *  Max batch size is enforced server-side at 100 accounts per call
 *  (see apps/indexer/src/api/profiles.ts and
 *  docs/BATCH-PROFILES-DESIGN.md). Over-limit requests return 400
 *  with code `bad_request`. */
export interface BatchProfilesResponse {
	readonly profiles: Readonly<Record<string, ProfileResponse>>;
}

// ─── Feedback ──────────────────────────────────────────────────────

export interface FeedbackRecord {
	readonly id: number;
	readonly reviewer: string;
	readonly subject: string;
	readonly rating: 1 | 2 | 3 | 4 | 5;
	readonly comment: string | null;
	readonly order_permlink: string | null;
	readonly created_at: string;
	/** The trx_id of the original feedback op. Needed when the
	 *  subject wants to publish a `morphit_feedback_response_v1`
	 *  op referring back to this feedback — the on-chain op
	 *  references its parent by trx_id, not by the indexer's
	 *  internal numeric id. */
	readonly source_trx_id: string;
	/** True iff the (reviewer, subject) pair is flagged in
	 *  suspicious_reciprocity or related_accounts.  The summary's
	 *  weighted_rating + count already exclude these, so the per-
	 *  row flag is what the frontend uses to render a clear visual
	 *  treatment so the displayed list reconciles with the summary
	 *  (Finding R15 from the feedback/reputation audit).
	 *  Optional for back-compat with pre-R15 indexers; absent means
	 *  "treat as not suppressed" — which is also the correct
	 *  behavior for indexers that haven't run the signal detectors
	 *  yet on a fresh DB. */
	readonly suppressed?: boolean;
	/** ADR-0014 verified-chat badge.  True iff the (reviewer,
	 *  subject) pair satisfied the bidirectional-chat conformance
	 *  at the time the feedback was signed:
	 *    - ≥2 messages from each side
	 *    - ≥15 minutes between earliest and latest pair message
	 *    - no suspicious_reciprocity flag on the pair
	 *  The badge is a "conversation looks real" signal, NOT a
	 *  proof of distinct identity.  Optional for back-compat
	 *  with pre-v26 indexers; absent means "the indexer is too
	 *  old to compute this — frontends render no badge."
	 *  Frontends should NOT treat absent as `false` in any
	 *  prominent way; an unrendered badge is the right UX. */
	readonly has_verified_chat?: boolean;
	readonly responses: readonly FeedbackResponseRecord[];
}

export interface FeedbackResponseRecord {
	readonly responder: string;
	readonly comment: string;
	readonly created_at: string;
}

export interface FeedbackSidedRating {
	readonly count: number;
	readonly weighted_rating: number | null; // null when count = 0
}

export interface FeedbackSummary {
	readonly count: number;
	readonly weighted_rating: number; // 0..5, 2-decimal precision
	readonly by_rating: Readonly<Record<'1' | '2' | '3' | '4' | '5', number>>;
	// cp124 H5: separate weighted_rating + count for buy-side and
	// sell-side trades.  Useful when a trader's experience differs
	// dramatically by role (great buyer, careless seller, or vice
	// versa).  Each leaf is null when count on that side is 0.
	readonly by_side: {
		readonly buy: FeedbackSidedRating;
		readonly sell: FeedbackSidedRating;
	};
	// cp124 H6: ISO-8601 timestamp of the account's most recent
	// trade-relevant activity (verified-fee order posted OR
	// feedback received).  Null when the account has neither.
	// Readers see "last traded N days/months/years ago" — informs
	// trust without changing the numeric score.
	readonly last_traded_at: string | null;
}

export interface AccountFeedbackResponse {
	readonly summary: FeedbackSummary;
	readonly items: readonly FeedbackRecord[];
	readonly next_cursor: string | null;
}

/** cp124 H4: Reputation receipt — the "show your work" endpoint.
 *
 *  Returns the FULL set of feedback rows about an account (including
 *  excluded ones, with reasons), plus the computed weighted_rating
 *  and the formula used.  A third party with access to the chain
 *  can re-derive the score independently and verify it matches.
 *
 *  Privacy posture: receipt for account X exposes which (X, Y) pairs
 *  are flagged by the signal tables.  This information is already
 *  implicit in the missing rows of X's published aggregate, so no
 *  new privacy leak.
 *
 *  Honest limitations: the `as_of` parameter pins the wall-clock
 *  used for decay-weight computation, but signal-table flags are
 *  always evaluated at REQUEST time (no historical flag-state
 *  reconstruction). */
export type ReputationExclusionReason =
	| null
	| 'no_order_permlink'
	| 'suspicious_reciprocity'
	| 'related_accounts'
	| 'one_way_pile_on'
	| 'review_concentration';

export interface ReputationReceiptRow {
	readonly source_trx_id: string;
	readonly reviewer: string;
	readonly rating: number; // 1..5 integer
	readonly created_at: string; // ISO-8601
	readonly order_permlink: string | null;
	readonly age_days: number; // 2-decimal precision
	readonly decay_weight: number; // 5-decimal precision, in (0, 1]
	readonly included: boolean;
	readonly excluded_reason: ReputationExclusionReason;
}

export interface ReputationReceiptResponse {
	readonly account: string;
	readonly as_of: string; // ISO-8601 — wall-clock used for decay
	readonly decay_half_life_days: number; // canonical: 365
	readonly formula: string; // human-readable formula description
	readonly summary: {
		readonly count_total: number;
		readonly count_included: number;
		readonly count_excluded: number;
		readonly weight_sum: number;
		readonly weighted_rating: number | null;
	};
	readonly rows: readonly ReputationReceiptRow[];
}

/** Response shape for `/v1/accounts/:account/feedback-given` —
 *  feedback this account has *left* for other accounts. Unlike
 *  AccountFeedbackResponse there's no summary: weighted-rating
 *  numbers don't make sense for "reviews I've given" (they'd
 *  just tell you how generous this reviewer is, not their
 *  reputation). If a display needs a count it can use
 *  `items.length` on a full fetch or run a separate HEAD-ish
 *  endpoint in the future. */
export interface AccountFeedbackGivenResponse {
	readonly items: readonly FeedbackRecord[];
	readonly next_cursor: string | null;
}

// ─── Release discovery ─────────────────────────────────────────────

export interface ReleaseResponse {
	readonly version: string;
	readonly hash_manifest: unknown;
	readonly endpoints: unknown;
	readonly signer: string;
	readonly source_trx_id: string;
	readonly source_block_num: number;
	readonly created_at: string;
}

// ─── Chat ciphertext ───────────────────────────────────────────────

export interface ChatMessageRecord {
	readonly id: number;
	readonly sender: string;
	readonly recipient: string;
	readonly ciphertext: string; // base64 opaque
	readonly header: unknown; // ECIES envelope header (ephemeral_pub, nonce, client_tag — opaque to indexer; see ADR-0015)
	readonly created_at: string;
}

export interface ChatHistoryResponse {
	readonly items: readonly ChatMessageRecord[];
	readonly next_cursor: string | null;
}

// ─── Operators (Phase 5b scaffolding) ──────────────────────────────
// Shape-stable types — the wire contract is independent of the
// open ADR-0013 questions (fee amount, referrer mechanism, split
// %). Those questions govern *how* rows are populated, not what
// columns are returned.

/** Denormalized per-operator earnings, included only when the
 *  operator has attracted at least one attributed order. */
export interface OperatorStats {
	readonly cumulative_blurt_earned: number;
	readonly total_orders_attributed: number;
}

/** One operator in the public directory. Fields correspond 1:1
 *  with the `operators` table + a lazily-joined stats object. */
export interface OperatorRecord {
	readonly account: string;
	readonly tag: string;
	readonly display_name: string;
	readonly contact_url: string | null;
	readonly registered_at: string;
	readonly is_active: boolean;
	readonly stats?: OperatorStats;
}

export interface OperatorsResponse {
	readonly operators: readonly OperatorRecord[];
}

// ─── Chat identity (ADR-0015) ──────────────────────────────────────

/** Response from GET /v1/chat-identity/:account.
 *
 *  Published X25519 chat public key for an account, derived per
 *  ADR-0015 (BLAKE2b(posting_priv, info="morphit-chat-v1/identity/...")
 *  then X25519-clamped). Senders use this to encrypt messages to
 *  the account via ECIES-style per-message keys.
 *
 *  The `source_block_num` and `source_trx_id` fields identify the
 *  on-chain `morphit_chat_identity_v1` op that established this
 *  pubkey. Clients implementing the chain-anchored TOFU defense
 *  (ADR-0015 §S2) pin this triple per peer and re-verify the op
 *  directly against a Blurt RPC if the indexer ever returns a
 *  different reference, defending against an indexer that swaps
 *  chat_pub values to MITM chat content. */
export interface ChatIdentityResponse {
	readonly account: string;
	/** Base64-encoded 32-byte X25519 public key. */
	readonly chat_pub: string;
	readonly source_block_num: number;
	readonly source_trx_id: string;
	readonly updated_at: string;
}

// ─── Conversations list ────────────────────────────────────────────

/** One peer the account has a chat history with. */
export interface ConversationSummary {
	readonly peer: string;
	readonly last_message_at: string;
	readonly message_count: number;
	/** Whether the account has ever sent a message to `peer`.
	 *  False means this conversation is inbound-only — the peer
	 *  has messaged us but we haven't yet replied. Frontend uses
	 *  this to partition the inbox into "Messages" and
	 *  "Requests" tabs (the latter holds first-contact threads
	 *  admitted via Finding H layer 2's stranger-fee path). */
	readonly has_user_sent: boolean;
}

/** Response from GET /v1/conversations/:account. Items sorted by
 *  `last_message_at` descending — most recent conversation first.
 *
 *  Unread tracking: for cross-device correctness clients should
 *  merge this response with GET /v1/chat-read-state/:account
 *  (the on-chain read receipts). Offline-first fallback is local
 *  `readState` (localStorage). */
export interface ConversationsResponse {
	readonly account: string;
	readonly items: readonly ConversationSummary[];
}

// ─── Chat read state (on-chain read receipts, Phase B inbox) ─────

/** One (peer, last_read_at) pair for a given reader, derived from
 *  the reader's `morphit_chat_read_v1` op history. A message with
 *  `created_at <= last_read_at` is considered read. */
export interface ChatReadStateEntry {
	readonly peer: string;
	readonly last_read_at: string;
}

/** Response from GET /v1/chat-read-state/:account. Items sorted
 *  by `last_read_at` descending (most recently-read conversations
 *  first). See `apps/web/src/lib/chat/readState.ts` on the client
 *  for the offline-first companion. */
export interface ChatReadStateResponse {
	readonly account: string;
	readonly items: readonly ChatReadStateEntry[];
}

// ─── Block list (Finding H layer 1) ───────────────────────────────
// One entry per account the owner has currently blocked. Rows with
// state='unblocked' are omitted server-side; this type represents
// the CURRENT block list, not an audit history.

export interface BlockEntry {
	/** Account the owner has blocked. */
	readonly blocked: string;
	/** Blurt block number where the ORIGINAL block decision
	 *  landed. Stays fixed across unblock/re-block cycles. */
	readonly since_block_num: number;
	/** Blurt transaction id of the ORIGINAL block decision.
	 *  Usable as `blocks.blurtwallet.com/tx/<trx_id>` for audit. */
	readonly since_trx_id: string;
	/** Block time of the original block decision. ISO 8601. */
	readonly created_at: string;
	/** Block time of the most-recent state change. ISO 8601. */
	readonly updated_at: string;
}

export interface BlocksResponse {
	readonly account: string;
	readonly items: readonly BlockEntry[];
}

// ─── Chat admission (Finding H layer 2) ───────────────────────────
// Derived state for the frontend's "can I message this person?"
// check when opening a new conversation.

export type ChatAdmissionReason = 'prior_exchange' | 'fee_paid' | 'none';

export interface ChatAdmissionResponse {
	readonly me: string;
	readonly peer: string;
	readonly admitted: boolean;
	readonly reason: ChatAdmissionReason;
}

// ─── Attestor eligibility (Finding I) ─────────────────────────────
// Fee-attestation gating to prevent sybil self-verification of
// BTC/XMR orders. An attestor must meet loyalty + age thresholds
// under the active phase rule.

export type AttestorEligibilityReason =
	// eligible outcomes
	| 'loyalty'
	| 'age'
	| 'both'
	// ineligible outcomes
	| 'insufficient_loyalty_and_young_account'
	| 'insufficient_loyalty'
	| 'young_account'
	| 'account_not_found';

export interface AttestorEligibilityResponse {
	readonly account: string;
	readonly phase: 'launch' | 'steady';
	readonly eligible: boolean;
	readonly reason: AttestorEligibilityReason;
	readonly loyalty_blurt: number;
	readonly age_days: number;
	readonly missing_loyalty_blurt: number;
	readonly days_until_eligible: number | null;
}

// ─── Stranger-fee quote ────────────────────────────────────────────
// Pre-quote endpoint that the frontend calls when opening the
// pay-to-message modal. The price is per-sender and escalates
// (doubles) for each first-contact fee paid in the last 5
// minutes, capped at 128× base (= 640 BLURT). Frontend uses the
// multiplier + recent_count to render a warning banner so the
// user knows the cost BEFORE they sign.
export interface StrangerFeeQuoteResponse {
	readonly account: string;
	/** Base price in BLURT — the floor every sender starts at.
	 *  Provided so the UI can show "doubled from 5 BLURT because
	 *  you've messaged N strangers recently." */
	readonly base_price_blurt: number;
	/** Current price the sender's NEXT first-contact fee will
	 *  cost, in BLURT. */
	readonly price_blurt: number;
	/** 1, 2, 4, ..., 128. */
	readonly multiplier: number;
	/** How many of the sender's stranger-fee payments fall in
	 *  the sliding window. */
	readonly recent_count: number;
	/** Length of the sliding window in minutes. */
	readonly window_minutes: number;
	/** True iff the multiplier has reached its ceiling. */
	readonly capped: boolean;
	/** The ceiling itself, for context. */
	readonly max_multiplier: number;
}

// ─── Error envelope ────────────────────────────────────────────────
// Every non-2xx response from the indexer returns this shape.

export interface ErrorResponse {
	readonly status: 'error';
	readonly code: ErrorCode;
	readonly message: string;
}

export type ErrorCode =
	| 'not_found'
	| 'bad_request'
	| 'rate_limited'
	| 'internal'
	| 'service_starting'; // indexer still doing initial sync

// ─── Instance branding (Phase D) ───────────────────────────────────

/** /v1/instance response.  Returns this Morphit instance's
 *  per-operator branding for the frontend to display.  All
 *  fields are nullable — the frontend has hardcoded fallbacks
 *  for unbranded instances.  Cached client-side for 5 minutes.*/
export interface InstanceResponse {
	readonly name: string | null;
	readonly tagline: string | null;
	readonly contact_url: string | null;
	readonly alt_networks: {
		readonly tor: string | null;
		readonly lokinet: string | null;
		/** I2P long-form b32 address (`<base32>.b32.i2p`). */
		readonly i2p_b32: string | null;
		/** I2P human-readable name (`something.i2p`). */
		readonly i2p_name: string | null;
		/** Deprecated legacy single field.  Pre-2026-05 indexers
		 *  populated this; post-2026-05 indexers leave it `null`
		 *  in favor of the explicit two-field form.  Kept on the
		 *  wire for one release cycle so this client can talk to
		 *  legacy indexers. */
		readonly i2p?: string | null;
		readonly nostr: string | null;
	};
	readonly fee_recipient: string;
	readonly relay_account: string;
	/** REVISIT-LIST item 5 — operator earnings.  When non-null,
	 *  the frontend includes this on every order op as
	 *  `operator_tag`, and the indexer credits 90% of BLURT-paid
	 *  listing fees to the operator who registered this tag.
	 *  When null (unbranded instance), orders go out without
	 *  attribution and the treasury keeps 100%.  Optional in
	 *  the response — older indexer builds (pre-v27 schema) omit
	 *  the field, in which case the frontend treats it as null. */
	readonly operator_tag?: string | null;
	/** Optional SEO override (task #4).  All fields nullable;
	 *  null means "use bundled i18n default."  Operators with
	 *  curated audiences set these to override homepage SEO
	 *  copy without forking the frontend. */
	readonly seo?: {
		readonly title: string | null;
		readonly description: string | null;
		readonly keywords: string | null;
		/** cp119-A4: optional Twitter/X handle for twitter:site
		 *  card attribution.  Older indexer builds (pre-cp119) omit
		 *  the field; frontend treats absence as null. */
		readonly twitter_site?: string | null;
	};
	/** Frontend chat-link URL templates (Part 109).  Optional —
	 *  older indexer builds (pre-Part-109) omit the field; in that
	 *  case the frontend uses its bundled defaults (mempool.space
	 *  for BTC, xmrchain.net for XMR).  When present, each field
	 *  is either a `https://…/{txid}…` template or null (meaning
	 *  "use the bundled default for this asset"). */
	readonly chat_link_urls?: {
		readonly btc: string | null;
		readonly xmr: string | null;
		/** Part 122 cp21 — BCH chat-link explorer URL override.
		 *  Optional; older indexer builds (pre-Part-122-cp21) omit
		 *  the field.  When present, either an `https://…/{txid}…`
		 *  template (operator override) or null (use bundled
		 *  blockchair.com/bitcoin-cash default). */
		readonly bch?: string | null;
		/** Part 122 cp24 — LTC chat-link explorer URL override.
		 *  Same pattern as BCH.  Bundled default:
		 *  litecoinspace.org.  Optional for back-compat with pre-
		 *  cp24 indexers.
		 *
		 *  CP33 NOTE: this field was MISSING from the indexer-
		 *  client mirror until cp33 — cp24 shipped the indexer-
		 *  side InstanceResponse with `ltc: string | null` but
		 *  never extended this mirror.  cp31-DD's "4 canonical
		 *  wire-format surface" sweep caught the USDT analog
		 *  (cp30-DD CODE-3) but didn't notice LTC.  Closed in
		 *  cp33 as CODE-4. */
		readonly ltc?: string | null;
		/** Part 122 cp27 — DASH chat-link explorer URL override.
		 *  Same pattern as BCH/LTC.  Bundled default:
		 *  insight.dash.org.  Optional for back-compat with
		 *  pre-cp27 indexers.
		 *
		 *  CP33 NOTE: same wire-format-asymmetry as LTC above —
		 *  cp27 shipped the indexer side without extending this
		 *  mirror.  Closed in cp33 as CODE-4. */
		readonly dash?: string | null;
		/** Part 122 cp33 — DOGE chat-link explorer URL override.
		 *  Same pattern as BCH/LTC/DASH (single-network mainnet).
		 *  Bundled default: blockchair.com/dogecoin.  Optional
		 *  for back-compat with pre-cp33 indexers. */
		readonly doge?: string | null;
		/** Part 122 cp39 — ZEC chat-link explorer URL override.
		 *  Same pattern as BCH/LTC/DASH/DOGE (single-network
		 *  mainnet).  Bundled default:
		 *  mainnet.zcashexplorer.app.  Optional for back-compat
		 *  with pre-cp39 indexers. */
		readonly zec?: string | null;
		readonly arrr?: string | null;
		readonly dcr?: string | null;
		readonly sol?: string | null;
		readonly eth?: string | null;
		readonly xrp?: string | null;
		/** Part 121 — USDT per-network explorer URL overrides.
		 *  Optional sub-map; older indexer builds (pre-Part-121)
		 *  omit this field, in which case the frontend uses its
		 *  bundled defaults from `lib/assets/networks.ts`.  Each
		 *  per-network field is either a `https://…/{txid}…`
		 *  template (operator override) or null (use bundled
		 *  default for that network). */
		readonly usdt?: {
			readonly erc20: string | null;
			readonly trc20: string | null;
			readonly spl: string | null;
			readonly bep20: string | null;
		};
		/** Part 122 cp30 — USDC per-network explorer URL overrides.
		 *  Same shape as USDT above with USDC's 4-network set
		 *  (erc20/spl/base/polygon).  BEP-20 intentionally absent
		 *  per ADR-0028 §1 (Binance-Peg + 18-decimal divergence).
		 *  Older indexer builds (pre-cp30) omit this field; frontend
		 *  defensive-fallback supplies a 4-network null sub-map. */
		readonly usdc?: {
			readonly erc20: string | null;
			readonly spl: string | null;
			readonly base: string | null;
			readonly polygon: string | null;
		};
		/** Part 122 cp31 — DAI per-network explorer URL overrides.
		 *  4 networks (all EVM-family): ERC-20 (Ethereum native),
		 *  Polygon, Base, Arbitrum.  No SPL/TRC-20/BEP-20 per
		 *  ADR-0029 §1 (no canonical Maker-issued DAI on those
		 *  chains).  Older indexer builds (pre-cp31) omit this
		 *  field; frontend defensive-fallback supplies a 4-network
		 *  null sub-map. */
		readonly dai?: {
			readonly erc20: string | null;
			readonly polygon: string | null;
			readonly base: string | null;
			readonly arbitrum: string | null;
		};
	};
	/** Trade-only assets this instance has DISABLED via the
	 *  `MORPHIT_INDEXER_DISABLED_ASSETS` env var (Memory #25).
	 *  Wire format: array of uppercase asset tickers (e.g.
	 *  `['USDT']` or `['USDT', 'ARRR']` — both are real working
	 *  ticker values as of cp41).  Empty array = this
	 *  instance accepts every asset in the canonical registry.
	 *
	 *  Optional in the response — older indexer builds
	 *  (pre-Part-121 cp6) omit the field entirely, in which
	 *  case clients should default to an empty array (assume
	 *  no operator-side asset disabling).  Federation
	 *  visibility lets `/run-a-node` and `/operators` surfaces
	 *  render the instance's asset-policy stance so prospective
	 *  users can self-select. */
	readonly disabled_assets?: readonly string[];
	/** Canonical payment-method keys the operator has disabled on
	 *  this instance (e.g. "barter_goods").  The picker + orderbook
	 *  filter hide these; the indexer refuses orders whose methods
	 *  are ALL disabled.  Absent on older indexers → treat as []. */
	readonly disabled_payment_methods?: readonly string[];
	/** Part 121 cp9 — public Matrix room alias for user→operator
	 *  contact (format: `#room:server`).  Optional for back-compat
	 *  with pre-cp9 indexers — older instances omit the field
	 *  entirely; clients should treat absent === null === "operator
	 *  did not configure a Matrix contact surface" and hide the
	 *  link.
	 *
	 *  CRITICAL: this field carries a ROOM alias only (#-prefixed).
	 *  It NEVER carries the operator's private alert MXID
	 *  (@-prefixed) — that lives only in the operator's
	 *  matrix-bot env (MORPHIT_MATRIX_BOT_ALERT_MXID) and is not
	 *  API-exposed.  See OPERATIONS.md §16 routing-alerts-elsewhere
	 *  + Memory's @user:server vs #room:server rule. */
	readonly operator_matrix_room?: string | null;
}

// ─── Federation directory (Phase D.5) ──────────────────────────────

/** Status of a federation peer at last probe. */
export type InstanceProbeStatus =
	| 'good'         // healthy, recent activity (or new-grace)
	| 'quiet'        // healthy but no orderbook activity in 7d
	| 'syncing'      // reachable + health 'ok' but chain-lag over threshold (catching up)
	| 'stale'        // /v1/health degraded or malformed (a real problem)
	| 'unreachable'  // HTTP fetch failed
	| 'mismatch'     // origin reachable but relay_account mismatched
	| 'never';       // queued but probe scheduler hasn't run yet

/** One entry in /v1/instances response. */
export interface InstanceDirectoryEntry {
	readonly origin: string;
	readonly operator_account: string;
	readonly operator_tag: string | null;
	readonly operator_display_name: string | null;
	readonly name: string | null;
	readonly tagline: string | null;
	readonly contact_url: string | null;
	readonly alt_networks: {
		readonly tor: string | null;
		readonly lokinet: string | null;
		/** I2P long-form b32 address (`<base32>.b32.i2p`). */
		readonly i2p_b32: string | null;
		/** I2P human-readable name (`something.i2p`). */
		readonly i2p_name: string | null;
		/** Deprecated legacy single field.  Frontends should
		 *  prefer i2p_b32 + i2p_name; this is preserved for
		 *  one release cycle. */
		readonly i2p: string | null;
		readonly nostr: string | null;
	} | null;
	readonly status: InstanceProbeStatus;
	readonly registered_at: string;
	readonly last_probed_at: string | null;
	readonly indexed_block: number | null;
	readonly chain_lag_sec: number | null;
	readonly consecutive_failures: number;
}

/** /v1/instances response — the federation directory. */
export interface InstanceDirectoryResponse {
	readonly version: 1;
	readonly directory_updated_at: string;
	readonly instances: readonly InstanceDirectoryEntry[];
}
