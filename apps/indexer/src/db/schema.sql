-- Morphit indexer — canonical schema (v1-v27 collapsed, May 2026 audit)
--
-- Pre-launch collapse: this single file represents the cumulative
-- effect of migration versions 1 through 27.  It is applied as a
-- single transaction on a fresh database; the migration runner
-- inserts (1, 2, 3, ..., 27) into schema_migrations after running
-- so historical version-tracking semantics are preserved.
--
-- The original per-version files are archived under
-- apps/indexer/src/db/historical/ — kept for archaeology, never
-- read by the runtime migration runner.
--
-- If you need to know what each version did, see
-- apps/indexer/src/db/migrations.ts — every Migration entry has a
-- `description` field listing what that version added.
--
-- ────────────────────────────────────────────────────────────────


-- ─── v1 (initial schema) ────────────────────────────────────────────
-- Morphit indexer — schema v1
-- Applied by src/db/migrations.ts on first boot.
-- See docs/PHASE-3b-DESIGN.md for the design rationale.

-- ─── Schema version tracking ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT NOT NULL
);

-- ─── Indexer progress tracking ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS indexer_state (
    id INT PRIMARY KEY CHECK (id = 1),
    last_applied_block BIGINT NOT NULL,
    last_applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    chain_id TEXT NOT NULL
);

-- ─── Event log: every morphit op we've seen ─────────────────────────
-- Append-only. Never updated, never deleted. Audit surface + basis
-- for materialized-view rebuilds.
CREATE TABLE IF NOT EXISTS ops (
    block_num BIGINT NOT NULL,
    trx_in_block INT NOT NULL,
    op_in_trx INT NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    trx_id TEXT NOT NULL,
    signer TEXT NOT NULL,
    op_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
    reject_reason TEXT,
    PRIMARY KEY (block_num, trx_in_block, op_in_trx)
);
CREATE INDEX IF NOT EXISTS ops_signer_idx ON ops (signer, block_num DESC);
CREATE INDEX IF NOT EXISTS ops_op_id_idx ON ops (op_id, block_num DESC);

-- ─── Profiles ──────────────────────────────────────────────────────
-- Latest profile per account. Replaced in place by new profile ops;
-- full history lives in the `ops` table.
CREATE TABLE IF NOT EXISTS profiles (
    account TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    json_metadata JSONB NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
-- ILIKE-friendly index for display name lookup.
CREATE INDEX IF NOT EXISTS profiles_display_name_idx
    ON profiles (LOWER(display_name));

-- ─── Orders ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    account TEXT NOT NULL,
    permlink TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    asset TEXT NOT NULL,
    fiat_currency TEXT NOT NULL,
    amount_min NUMERIC,
    amount_max NUMERIC,
    price_model JSONB NOT NULL,
    location_region TEXT,
    payment_methods TEXT[] NOT NULL,
    terms TEXT,
    status TEXT NOT NULL CHECK (status IN ('live', 'cancelled', 'expired')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    PRIMARY KEY (account, permlink)
);
-- Partial index tuned for the orderbook read path.
CREATE INDEX IF NOT EXISTS orders_live_idx
    ON orders (status, asset, side, updated_at DESC)
    WHERE status = 'live';
CREATE INDEX IF NOT EXISTS orders_account_idx ON orders (account, updated_at DESC);

-- ─── Feedback ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
    id BIGSERIAL PRIMARY KEY,
    reviewer TEXT NOT NULL,
    subject TEXT NOT NULL,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    order_permlink TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE,
    -- One review per (reviewer, subject, order). If order_permlink is
    -- NULL we still constrain (reviewer, subject) — Postgres NULL
    -- semantics in UNIQUE require special handling; using a partial
    -- unique index for the NULL case.
    UNIQUE (reviewer, subject, order_permlink)
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_reviewer_subject_null_order_idx
    ON feedback (reviewer, subject)
    WHERE order_permlink IS NULL;
CREATE INDEX IF NOT EXISTS feedback_subject_idx ON feedback (subject, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_reviewer_idx ON feedback (reviewer, created_at DESC);

-- ─── Feedback responses ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback_responses (
    id BIGSERIAL PRIMARY KEY,
    feedback_id BIGINT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    responder TEXT NOT NULL,
    comment TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS feedback_responses_feedback_id_idx
    ON feedback_responses (feedback_id, created_at DESC);

-- ─── Releases ──────────────────────────────────────────────────────
-- Every release-discovery op, whether the signature validates or not.
-- `valid = true` means signed by the pinned MORPHIT_OFFICIAL_POSTING_PUBKEY.
CREATE TABLE IF NOT EXISTS releases (
    id BIGSERIAL PRIMARY KEY,
    version TEXT NOT NULL,
    hash_manifest JSONB NOT NULL,
    endpoints JSONB NOT NULL,
    signature TEXT NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE,
    signer TEXT NOT NULL,
    valid BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS releases_valid_idx
    ON releases (valid, created_at DESC)
    WHERE valid = true;

-- ─── Chat messages (ciphertext only) ──────────────────────────────
-- The indexer stores opaque ciphertext; only the two participants
-- can decrypt it with their memo keys.
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    header JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE
);
-- Canonical-order index so /v1/chat/a/b and /v1/chat/b/a hit the
-- same index.
CREATE INDEX IF NOT EXISTS chat_pair_idx ON chat_messages (
    LEAST(sender, recipient), GREATEST(sender, recipient), created_at DESC
);

-- ─── Record this migration ────────────────────────────────────────
INSERT INTO schema_migrations (version, description)
VALUES (1, 'initial schema')
ON CONFLICT (version) DO NOTHING;

-- ─── v2 ────────────────────────────────────────────
-- Morphit indexer — migration v2.
--
-- Adds the fee verification + self-trade detection tables per
-- ADR-0009. See docs/adr/0009-phase3c-order-posting.md for the
-- architectural rationale.

-- ─── fee_transfers ────────────────────────────────────────────────
-- Every BLURT transfer op targeting the fee-collection account that
-- we've observed. Rows are append-only; we never rewrite them even
-- if an order they're attached to is later cancelled (the transfer
-- itself was still real).
--
-- memo_permlink is parsed from transfer memos matching
-- `morphit-fee:<permlink>`; NULL when the memo doesn't parse,
-- which means someone sent BLURT to the fee account without
-- specifying an order. We index those too for operational
-- visibility (did someone accidentally send fees? an audit needs
-- the record).
CREATE TABLE fee_transfers (
    id             BIGSERIAL PRIMARY KEY,
    block_num      BIGINT NOT NULL,
    trx_in_block   INTEGER NOT NULL,
    op_in_trx      INTEGER NOT NULL,
    block_time     TIMESTAMPTZ NOT NULL,
    trx_id         TEXT NOT NULL,
    sender         TEXT NOT NULL,
    amount_blurt   NUMERIC(18, 3) NOT NULL,
    memo           TEXT NOT NULL,
    memo_permlink  TEXT, -- parsed from `morphit-fee:<permlink>`, NULL if unparseable
    UNIQUE (block_num, trx_in_block, op_in_trx)
);

-- Looking up a fee transfer by the permlink it paid for is the
-- order handler's hot path.
CREATE INDEX fee_transfers_permlink_idx ON fee_transfers (sender, memo_permlink)
    WHERE memo_permlink IS NOT NULL;

-- Listing all fees paid by one account (for Sybil counting).
CREATE INDEX fee_transfers_sender_time_idx ON fee_transfers (sender, block_time DESC);

-- ─── orders.fee_status ────────────────────────────────────────────
-- One of:
--   unverified  — default on insert; the handler hasn't checked yet
--                 (current block doesn't contain a fee transfer we
--                  could match; set when the fee could arrive later
--                  in a subsequent handler run)
--   verified    — a matching transfer with the expected amount was
--                 observed in the same transaction
--   missing     — no matching transfer in the same transaction
--   underpaid   — a matching transfer exists but the amount is
--                 below the tolerance band
--
-- Only 'verified' orders are served by the orderbook endpoint.
ALTER TABLE orders ADD COLUMN fee_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (fee_status IN ('unverified', 'verified', 'missing', 'underpaid'));

-- Partial index for the orderbook's hot query: only verified
-- live orders appear in the public orderbook.
CREATE INDEX orders_verified_live_idx
    ON orders (asset, side, updated_at DESC)
    WHERE status = 'live' AND fee_status = 'verified';

-- ─── related_accounts ─────────────────────────────────────────────
-- Self-trade Signal A — two accounts flagged as likely belonging
-- to the same person based on creation + timing patterns.
-- Bidirectional: (a, b) and (b, a) are stored as a single row with
-- account_a < account_b lexically.
CREATE TABLE related_accounts (
    account_a       TEXT NOT NULL,
    account_b       TEXT NOT NULL,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason          TEXT NOT NULL, -- e.g. 'same_creator_close_timing'
    evidence        JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (account_a, account_b),
    CHECK (account_a < account_b)
);

CREATE INDEX related_accounts_b_idx ON related_accounts (account_b);

-- ─── suspicious_reciprocity ───────────────────────────────────────
-- Self-trade Signal B — two accounts exchanging many mutual
-- high-star reviews in a short window with no other counterparties.
-- Same bidirectional (a, b) canonical-order convention.
CREATE TABLE suspicious_reciprocity (
    account_a       TEXT NOT NULL,
    account_b       TEXT NOT NULL,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    mutual_review_count INTEGER NOT NULL,
    avg_rating      NUMERIC(3, 2) NOT NULL,
    PRIMARY KEY (account_a, account_b),
    CHECK (account_a < account_b)
);

CREATE INDEX suspicious_reciprocity_b_idx ON suspicious_reciprocity (account_b);

-- ─── v3 ────────────────────────────────────────────
-- Morphit indexer — migration v3.
--
-- Adds the accounts table per ADR-0009 §5, needed to support
-- Signal A (related-accounts detection). We record one row per
-- Blurt account whose `account_create`-family op we observe while
-- indexing. Accounts that predate our startBlock never get a row,
-- which means they're never candidates for Signal A — acceptable,
-- since the signal is about *new* accounts sharing a creator.
--
-- `first_activity_at` is populated lazily: initially NULL when we
-- record the creation op, then set the first time we see a morphit
-- op (profile, order, feedback, etc.) from this account. This
-- two-phase population lets the detector find pairs whose
-- creation timing AND first-Morphit-activity timing are both
-- close.

CREATE TABLE accounts (
    name                TEXT PRIMARY KEY,
    creator             TEXT NOT NULL,
    -- Block metadata for the account_create op that introduced
    -- this account. Used to find accounts created in close
    -- temporal proximity by the same creator.
    created_block_num   BIGINT NOT NULL,
    created_block_time  TIMESTAMPTZ NOT NULL,
    created_trx_id      TEXT NOT NULL,
    -- First observed morphit-op time for this account. NULL
    -- until we see such an op. Indexed for Signal A's
    -- temporal-proximity query.
    first_activity_at   TIMESTAMPTZ
);

-- Creator-grouped queries are the Signal A hot path.
CREATE INDEX accounts_creator_idx ON accounts (creator, created_block_time);

-- For looking up an account's creator when it posts an order.
-- (The primary-key lookup already covers this, but keeping the
-- pattern explicit.)

-- For Signal A's temporal-proximity predicate on first activity.
CREATE INDEX accounts_first_activity_idx
    ON accounts (first_activity_at)
    WHERE first_activity_at IS NOT NULL;

-- ─── v4 ────────────────────────────────────────────
-- Morphit indexer — migration v4.
--
-- Extends the schema for Phase 4 sub-phase 4a (MVP of ADR-0011
-- dynamic fee model + ADR-0010 key custody implementation).
--
-- Four additions, all additive (no ALTER ... DROP, no data
-- rewrites):
--   1. accounts.first_buy_waived_at — tracks one-time use of
--      the free first-BUY-order waiver per account.
--   2. accounts.first_trade_complete_at — triggers the delayed
--      welcome bonus. Set when the first counterparty feedback
--      submission on an order this account posted lands.
--   3. relay_pending_transfers — queue of BLURT transfers the
--      relay should broadcast on its next active-key session.
--      Populated by the indexer when trigger conditions are met.
--      Drained by the relay.
--   4. witness_fee_history — observed history of the Blurt
--      chain's account_creation_fee. Appended when the witness-
--      fee poller observes a change. Used for auditing the
--      dynamic-fee model's behavior over time.
--
-- The account_loyalty table for cumulative BLURT tracking
-- (ADR-0011 sub-phase 4c) is NOT added here. It arrives in
-- migration v5 when the loyalty rewards actually ship.

-- ─── 1 + 2: accounts columns ───────────────────────────────────
-- first_buy_waived_at: NULL means the account has not yet used
-- its free first BUY order. When the order handler processes an
-- order with fee_method='waived_first_buy' and all preconditions
-- pass, it sets this to the block time. Subsequent attempts see
-- the non-NULL value and reject.
ALTER TABLE accounts
    ADD COLUMN first_buy_waived_at TIMESTAMPTZ;

-- first_trade_complete_at: NULL means no counterparty feedback
-- has yet identified this account as a trade participant. When
-- a morphit_feedback_v1 op from a counterparty (not the account
-- itself) is processed against one of this account's orders,
-- the dispatcher sets this to the block time AND writes a row
-- to relay_pending_transfers so the welcome bonus goes out.
ALTER TABLE accounts
    ADD COLUMN first_trade_complete_at TIMESTAMPTZ;

-- Index for the "is this user a new trader?" query. The sprout
-- icon on orderbook rows filters on this.
CREATE INDEX IF NOT EXISTS accounts_new_trader_idx
    ON accounts (name)
    WHERE first_trade_complete_at IS NULL;

-- ─── Orders.fee_method ────────────────────────────────────────
-- ADR-0011: each order records how its listing fee was paid.
-- Default 'blurt' for back-compat with ADR-0009 rows. BTC/XMR
-- values are reserved for sub-phase 4b but allowed by the CHECK
-- so a single ALTER TABLE doesn't need to be revisited then.
ALTER TABLE orders
    ADD COLUMN fee_method TEXT NOT NULL DEFAULT 'blurt'
    CHECK (fee_method IN ('blurt', 'waived_first_buy', 'btc', 'xmr'));

-- ─── 3: relay_pending_transfers queue ─────────────────────────
-- The relay holds the only active key. The indexer identifies
-- users who should receive bonus transfers (welcome bonus,
-- dust refill, loyalty milestones in the future) and writes
-- rows here. On its next active-key session (typically the
-- same passphrase-at-boot window the operator opens for weekly
-- ACT minting, per ADR-0010), the relay selects unbroadcast
-- rows, signs the transfers, and marks them broadcast.
--
-- kind='liquid' → transfer op (plain BLURT transfer).
-- kind='vesting' → transfer_to_vesting op (power-up BLURT to
-- BP in the recipient's account).
--
-- reason is free-form text but has common values:
--   'welcome_bonus_liquid'       10 BLURT welcome
--   'welcome_bonus_vesting'      10 BP welcome
--   'dust_refill'                1 BLURT low-balance refill
--   'signup_dust'                1 BLURT at account creation
--   'loyalty_milestone_vesting'  BP reward at milestone
-- The relay doesn't interpret reason — it's purely for audit.
CREATE TABLE IF NOT EXISTS relay_pending_transfers (
    id              BIGSERIAL PRIMARY KEY,
    recipient       TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('liquid', 'vesting')),
    amount_blurt    NUMERIC NOT NULL CHECK (amount_blurt > 0),
    reason          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    broadcast_at    TIMESTAMPTZ,
    broadcast_trx_id TEXT,
    -- If a broadcast attempt fails, we record the error and
    -- leave the row unbroadcast so the next session retries.
    last_error      TEXT,
    last_error_at   TIMESTAMPTZ,
    error_count     INTEGER NOT NULL DEFAULT 0
);

-- Partial index tuned for the relay's "give me all the
-- pending work" query. Orders by created_at so the oldest
-- queued transfer goes out first (FIFO fairness).
CREATE INDEX IF NOT EXISTS relay_pending_transfers_unbroadcast_idx
    ON relay_pending_transfers (created_at)
    WHERE broadcast_at IS NULL;

-- ─── 4: witness_fee_history ───────────────────────────────────
-- Record the chain's account_creation_fee each time the poller
-- observes a change. First row is written at indexer startup
-- (baseline). Subsequent rows only on value changes. This table
-- is append-only; rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS witness_fee_history (
    observed_at                     TIMESTAMPTZ NOT NULL PRIMARY KEY,
    account_creation_fee_blurt      NUMERIC NOT NULL CHECK (account_creation_fee_blurt >= 0),
    -- Context: why the observation was recorded. 'initial' =
    -- first observation at indexer start; 'change' = value
    -- changed from previous observation. The poller only writes
    -- on 'initial' or 'change' — not on every poll.
    observation_kind TEXT NOT NULL CHECK (observation_kind IN ('initial', 'change'))
);

-- ─── v5 ────────────────────────────────────────────
-- Morphit indexer — migration v5.
--
-- Extends the schema for Phase 4 sub-phase 4b (multi-asset fee
-- verification via morphit_fee_attest_v1 and pending_external
-- fee_status).
--
-- Two changes, both additive:
--   1. orders.fee_status CHECK constraint extended to include
--      'pending_external' and 'verified_by_attestation'.
--   2. New fee_attestations table recording each observation of
--      a morphit_fee_attest_v1 op. Two distinct-account rows on
--      the same order trigger the verified_by_attestation flip
--      (enforced in the handler, not by schema).

-- 1. Extend orders.fee_status. Postgres can't modify a CHECK in
-- place; drop and re-add. The re-add validates existing rows —
-- safe because the new values are strictly additive.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fee_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_fee_status_check CHECK (
    fee_status IN (
        'unverified',
        'verified',
        'missing',
        'underpaid',
        'pending_external',
        'verified_by_attestation'
    )
);

-- 2. fee_attestations: one row per morphit_fee_attest_v1 op we've
-- applied. Used by the handler to count distinct attestors on
-- an order and decide whether to promote its fee_status.
--
-- Uniqueness: (order_account, order_permlink, attestor) prevents
-- the same account from attesting twice. An attestor CAN be the
-- order poster, but the handler enforces that at least one
-- attestation must come from a DIFFERENT account before the
-- order flips — two rows from the same attestor would never do
-- that anyway, but uniqueness guarantees we don't silently count
-- duplicates.
CREATE TABLE IF NOT EXISTS fee_attestations (
    id BIGSERIAL PRIMARY KEY,
    order_account TEXT NOT NULL,
    order_permlink TEXT NOT NULL,
    attestor TEXT NOT NULL,
    observed_in_block BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trx_id TEXT,
    UNIQUE (order_account, order_permlink, attestor)
);

-- Index for the handler's "count attestations on this order"
-- read. Not strictly needed for correctness (the UNIQUE index
-- already covers the lookup) but makes the EXPLAIN plan
-- obvious.
CREATE INDEX IF NOT EXISTS fee_attestations_order_idx
    ON fee_attestations (order_account, order_permlink);

-- ─── v6 ────────────────────────────────────────────
-- Morphit indexer — migration v6.
--
-- Sub-phase 4c: loyalty BP milestones.
--
-- Three additions, all additive:
--   1. account_loyalty — one row per account, tracks cumulative
--      BLURT fees paid and last milestone reward triggered.
--   2. account_loyalty_milestones — audit row per milestone
--      triggered, with UNIQUE (account, milestone_blurt) so
--      re-processing never double-rewards.
--   3. relay_pending_transfers — extended to support
--      kind='delegation' and a nullable amount_bp column for BP
--      delegations (since BP is denominated differently from
--      liquid/vesting BLURT).

-- 1. account_loyalty — materialized aggregation of verified
-- BLURT fees. Updated by the order handler atomically with
-- each order that lands with fee_status='verified' and
-- fee_method='blurt'. Rows are created lazily on first fee.
CREATE TABLE IF NOT EXISTS account_loyalty (
    account TEXT PRIMARY KEY,
    cumulative_blurt_paid NUMERIC NOT NULL DEFAULT 0
        CHECK (cumulative_blurt_paid >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. account_loyalty_milestones — one row per milestone crossed
-- by each account. UNIQUE constraint guarantees the handler's
-- "try to record, ignore unique violation" idempotency pattern.
-- The milestone_blurt column uses the exact numeric threshold
-- (100, 500, 2000, 10000) — this is the canonical identifier.
CREATE TABLE IF NOT EXISTS account_loyalty_milestones (
    id BIGSERIAL PRIMARY KEY,
    account TEXT NOT NULL,
    milestone_blurt NUMERIC NOT NULL,
    bp_rewarded NUMERIC NOT NULL CHECK (bp_rewarded > 0),
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    triggered_in_block BIGINT NOT NULL,
    UNIQUE (account, milestone_blurt)
);

-- 3. Extend relay_pending_transfers to support delegations.
-- Postgres can't modify a CHECK in place; drop + re-add.
-- The re-add validates existing rows, which all have
-- kind IN ('liquid', 'vesting') per 4a, so validation passes.
ALTER TABLE relay_pending_transfers
    DROP CONSTRAINT IF EXISTS relay_pending_transfers_kind_check;
ALTER TABLE relay_pending_transfers
    ADD CONSTRAINT relay_pending_transfers_kind_check CHECK (
        kind IN ('liquid', 'vesting', 'delegation')
    );

-- amount_blurt has a CHECK amount_blurt > 0 which we keep; for
-- delegation rows we add amount_bp as the canonical amount field
-- and set amount_blurt = 0 sentinel. Since amount_blurt's CHECK
-- is > 0, we need to relax that too — switch to ≥ 0.
ALTER TABLE relay_pending_transfers
    DROP CONSTRAINT IF EXISTS relay_pending_transfers_amount_blurt_check;
ALTER TABLE relay_pending_transfers
    ADD CONSTRAINT relay_pending_transfers_amount_blurt_check CHECK (
        amount_blurt >= 0
    );

-- Add amount_bp column for delegation rows. NULL for
-- liquid/vesting rows (we could add a CHECK that kind + amount
-- fields are consistent, but the relay's broadcast code is the
-- single source of truth and a malformed row would fail to
-- broadcast rather than corrupt state).
ALTER TABLE relay_pending_transfers
    ADD COLUMN IF NOT EXISTS amount_bp NUMERIC
        CHECK (amount_bp IS NULL OR amount_bp > 0);

-- For delegation rows we need to know an optional "cap" — the
-- BP amount to delegate TO (absolute level), since BP delegations
-- SET the level rather than add. The relay uses this directly.
-- For milestone rewards, the cap equals amount_bp (start from
-- zero); if we later implement re-delegations after an earlier
-- reward, the relay needs to SET the new cumulative cap, not
-- just the increment.
-- Deferred: for 4c we always SET amount_bp directly because
-- previous rewards are recorded in account_loyalty_milestones
-- and we can compute the cumulative cap at queue time. No
-- schema change needed for now.

-- ─── v7 ────────────────────────────────────────────
-- Morphit indexer — migration v7.
--
-- Phase 5b — operator incentives: data-layer scaffolding.
--
-- This migration lands the shape-stable parts of Phase 5b: the
-- tables that will hold operator identities and their earnings
-- tallies. The op handlers that will populate them (registration
-- op, referrer-tracking op, payout op) are gated on ADR-0013
-- resolution and NOT part of this migration.
--
-- Why land the tables now, before ADR-0013 is accepted? Two
-- reasons:
--   1. The column set here covers only policy-independent
--      attributes: who the operator is, what tag they use, when
--      they registered, what they've earned in aggregate. The
--      open questions (fee amount, split percentage, pull vs
--      push) determine *rules that operate on these rows*, not
--      the row shape itself.
--   2. Shipping the tables early lets the /operators directory
--      page be tested end-to-end (with zero rows) without having
--      to land the whole feature at once.
--
-- If ADR-0013 ultimately chooses a drastically different model
-- (e.g., operators as SBTs minted on another chain), these tables
-- become dead code — but the cost is cheap: two empty tables and
-- three indexes. No data migration headache.

-- 1. operators — one row per registered operator. The natural
-- key is the Blurt account that registered; `tag` is a display/
-- attribution label (chosen by the operator, subject to ADR-0013
-- Q5's registry-governance rules once those exist).
--
-- Columns whose presence is shape-stable:
--   account: the Blurt account owning the operator identity.
--   tag: a short unique handle used in referrer tracking. The
--        UNIQUE constraint enforces the collision-free invariant
--        regardless of how disputes are resolved by policy.
--   display_name: human-readable name for the directory page.
--   contact_url: operator's contact URL (their own site, an
--                onion service, an @username on social, etc).
--   registered_in_block: chain block where registration
--                        completed; lets an indexer reconcile
--                        or replay if state is lost.
--   is_active: cheap flag so suspension/offboarding (an eventual
--              policy question under ADR-0013 Q5) doesn't need
--              a row delete.
--
-- Columns deliberately NOT included (gated on ADR-0013):
--   registration_fee_paid_blurt: depends on Q1
--   referrer_mechanism_version: depends on Q2
--   fee_split_percent_override: depends on Q3
CREATE TABLE IF NOT EXISTS operators (
    account TEXT PRIMARY KEY,
    tag TEXT NOT NULL,
    display_name TEXT NOT NULL,
    contact_url TEXT,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registered_in_block BIGINT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    -- Forward-compat: JSONB extras so we can stash ADR-0013
    -- decisions (once accepted) without a v8 migration just for
    -- adding a column. Contents are NOT authoritative — every
    -- policy-relevant datum lands in a proper column once decided.
    extras JSONB NOT NULL DEFAULT '{}'::JSONB,
    UNIQUE (tag)
);

-- Index for directory-page sort (recently-registered first) and
-- is_active filtering.
CREATE INDEX IF NOT EXISTS operators_active_registered_idx
    ON operators (is_active, registered_at DESC);

-- 2. operator_earnings — running tally of per-operator revenue.
-- Updated by the indexer as orders land that carry a tag
-- attribution (referrer mechanism from ADR-0013 Q2). Shape is
-- stable because the *fact* of a running tally per operator is
-- independent of how the tally is sourced.
--
-- Rows are created lazily on first attributed order — an operator
-- with zero earnings has no row here, which keeps "total registered"
-- (operators rowcount) distinct from "has earned anything".
CREATE TABLE IF NOT EXISTS operator_earnings (
    account TEXT PRIMARY KEY REFERENCES operators(account) ON DELETE CASCADE,
    cumulative_blurt_earned NUMERIC NOT NULL DEFAULT 0
        CHECK (cumulative_blurt_earned >= 0),
    total_orders_attributed BIGINT NOT NULL DEFAULT 0
        CHECK (total_orders_attributed >= 0),
    last_payout_at TIMESTAMPTZ,
    last_payout_blurt NUMERIC
        CHECK (last_payout_blurt IS NULL OR last_payout_blurt >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. operator_registration_events — audit trail of all
-- registration-adjacent ops. Separate from operators so that
-- reconstitution from the event log (rebuild-materialized mode)
-- is natural. This is the table the indexer handler will INSERT
-- into; operators + operator_earnings are derived from this
-- table per the class-2 materialization pattern.
--
-- kind vocabulary is open-ended for forward-compat with ADR-0013:
--   'register': operator came online
--   'deactivate': operator suspended/offboarded
--   'reactivate': operator returned
--   'tag_changed': operator changed display tag (subject to policy)
-- Additional kinds land without a migration once decided.
CREATE TABLE IF NOT EXISTS operator_registration_events (
    id BIGSERIAL PRIMARY KEY,
    account TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    observed_in_block BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operator_registration_events_account_idx
    ON operator_registration_events (account, observed_at DESC);

-- ─── v8 ────────────────────────────────────────────
-- Migration v8 — recorded no-op (kept for migration-numbering continuity).
--
-- Originally introduced in Phase 5c to scaffold the chat_messages
-- table with an order_permlink-scoped design.  By the time chat
-- shipped (post-ADR-0014 sub-Q resolutions), the design had pivoted
-- to general-purpose DM and chat_messages was defined in schema.sql
-- (the v1 base) with a different column set and a UNIQUE
-- source_trx_id dedupe constraint.  schema-v25.sql later added back
-- order_permlink as nullable.
--
-- Rather than retroactively delete this file (which would shift
-- every subsequent migration number), v8 stays as a recorded no-op.
-- Pre-launch we have no deployed instances — see REVISIT-LIST item
-- "collapse migration history" for the v1.0.0 cleanup.
SELECT 1;

-- ─── v9 ────────────────────────────────────────────
-- Morphit indexer — migration v9.
--
-- Phase 5 item 5: featured-slot auction.
--
-- A "featured" slot is an order the user has paid extra BLURT to
-- surface above the normal orderbook results. Mechanics (chosen
-- for MVP simplicity):
--
--   - Continuous auction; at any moment at most 5 concurrent
--     slots are active.
--   - Bidders sign `morphit_feature_bid_v1` ops whose payload
--     names a target order_permlink and an `hours_requested`
--     value. They accompany the op with a transfer of
--     (feature_fee_blurt_per_hour × hours_requested) BLURT to
--     @morphit-fees.
--   - The indexer records every bid. When ranking slots at
--     query time, the top 5 non-expired bids by
--     (blurt_paid / hours_requested) win. Ties break by
--     earliest block_time_at (first-bidder wins ties).
--   - The featured order surfaces on the homepage and at the
--     top of /orderbook with a badge. No other site behavior
--     changes — the same trading rules apply.
--
-- Why this shape over alternatives:
--   - First-price-sealed-bid auctions need a committed
--     tallying window; they're elegant in theory but require
--     users to coordinate around auction boundaries. Rolling
--     continuous is trader-friendly.
--   - Dutch auctions (falling price over time) are engaging
--     but add a "when do I bid?" cognitive tax. MVP prefers
--     transparency — anyone can see the current bottom bid
--     and beat it.
--   - Per-slot fixed prices (tier-A at 100 BLURT/hr, tier-B
--     at 50 BLURT/hr, etc.) create artificial scarcity that
--     auction mechanics handle more honestly.

-- featured_slot_bids — append-only audit log of every bid op.
-- A rejected bid (fee mismatch, expired order, etc.) does NOT
-- land here; rejections go to event_log like every other op.
CREATE TABLE featured_slot_bids (
    bid_id BIGSERIAL PRIMARY KEY,
    bidder TEXT NOT NULL,
    order_permlink TEXT NOT NULL,
    hours_requested INT NOT NULL CHECK (hours_requested >= 1 AND hours_requested <= 168),
    -- Total BLURT paid for this bid. Denormalized from the
    -- associated transfer op (referenced by trx_id) for
    -- constant-time rank sort without a join.
    blurt_paid NUMERIC(20, 3) NOT NULL CHECK (blurt_paid > 0),
    -- Derived at insert time for the rank sort. Denormalized
    -- because "price per hour" is the queried predicate.
    blurt_per_hour NUMERIC(20, 6) NOT NULL,
    -- When the bid takes effect. Always block_time_at of the
    -- op — featured slots start immediately and are not
    -- pre-schedulable.
    effective_at TIMESTAMPTZ NOT NULL,
    -- effective_at + (hours_requested * INTERVAL '1 hour').
    -- Denormalized so "active now" predicate is a single
    -- column comparison instead of arithmetic.
    expires_at TIMESTAMPTZ NOT NULL,
    -- Transaction id of the op; unique index ensures a replayed
    -- op doesn't double-credit a bidder.
    trx_id TEXT NOT NULL UNIQUE,
    block_num BIGINT NOT NULL,
    block_time_at TIMESTAMPTZ NOT NULL,
    -- Cancelled means the bidder rescinded (future feature);
    -- for MVP always FALSE.
    cancelled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Part 122 cp18 — anti-snipe extension tracking.
    -- When a new bid arrives that would push someone out of the
    -- top-MAX_SLOTS, AND any current top-MAX_SLOTS bid expires
    -- within SNIPE_WINDOW_MINUTES, those expiring bids get their
    -- expires_at extended by SNIPE_EXTENSION_MINUTES.  Cap at
    -- MAX_EXTENSIONS to prevent indefinite auction-drag.
    --
    -- extension_count: how many times this bid's expires_at has
    --   been extended.  When it reaches MAX_EXTENSIONS the bid
    --   stops being extendable.
    -- last_extended_at: audit-trail timestamp of the most recent
    --   extension, useful for operators investigating disputes
    --   ("did my bid really get extended at 3am?").  NULL if
    --   never extended.
    extension_count INT NOT NULL DEFAULT 0
        CHECK (extension_count >= 0 AND extension_count <= 100),
    last_extended_at TIMESTAMPTZ
);

-- Order-permlink foreign key is intentionally NOT declared here —
-- at MVP we want bids against orders that have since been
-- cancelled or expired to remain in the audit table (for
-- refund-tracking and anti-abuse analysis). The query-time
-- predicate "AND order is still live" handles visibility.

-- v33.3a — idempotent backfill for upgrades from cp17 and earlier.
-- Fresh installs already have the columns from the CREATE above.
ALTER TABLE featured_slot_bids
    ADD COLUMN IF NOT EXISTS extension_count INT NOT NULL DEFAULT 0;
ALTER TABLE featured_slot_bids
    ADD COLUMN IF NOT EXISTS last_extended_at TIMESTAMPTZ;

CREATE INDEX ix_featured_bids_active
    ON featured_slot_bids (blurt_per_hour DESC, block_time_at ASC)
    WHERE cancelled = FALSE;

CREATE INDEX ix_featured_bids_bidder
    ON featured_slot_bids (bidder, block_time_at DESC);

CREATE INDEX ix_featured_bids_order
    ON featured_slot_bids (order_permlink, expires_at DESC);

-- Part 122 cp18 — anti-snipe extension lookup.  The handler
-- needs to find "active bids in the top-MAX_SLOTS whose
-- expires_at is within SNIPE_WINDOW_MINUTES of NOW()".  The
-- existing ix_featured_bids_active partial index covers the
-- rank part; this index supports the expires_at range filter.
CREATE INDEX IF NOT EXISTS ix_featured_bids_expires
    ON featured_slot_bids (expires_at, bid_id)
    WHERE cancelled = FALSE;

-- Query pattern: "what are the top 5 currently featured
-- orders?" — covered by ix_featured_bids_active with an
-- additional WHERE on expires_at > NOW() and a JOIN to
-- orders for liveness. Not materialized in its own table:
-- the predicate "expires_at > NOW()" changes every second,
-- so a materialized cache would thrash.

-- ─── v10 ────────────────────────────────────────────
-- Morphit schema v10
--
-- Adds `invalid_reason` to the releases table. When a release op
-- is recorded with valid=false, we now preserve the specific
-- reason it was rejected. Enables operators investigating a
-- potential key compromise to distinguish:
--
--   - 'signer_not_official_account' (phishing / impersonation; no
--     real key compromise — someone broadcast from an account
--     that claims to be @morphit but isn't)
--
--   - 'signer_no_single_posting_key' (on-chain posting authority
--     has multi-key or account-auth setup — unusual but not
--     necessarily malicious)
--
--   - 'pubkey_mismatch' (signer account matches, but the on-chain
--     posting pubkey doesn't match the pinned value — this is
--     the signal that the pinned key should be rotated
--     immediately, since it means somebody valid-signed a release
--     from the right account with the wrong key)
--
-- Backward-compat: column is nullable. Historical rows from v1-v9
-- keep `invalid_reason IS NULL` and their valid/invalid status is
-- unchanged.
--
-- Ref: Finding J in docs/REVISIT-LIST.md §F.

ALTER TABLE releases
	ADD COLUMN IF NOT EXISTS invalid_reason TEXT;

COMMENT ON COLUMN releases.invalid_reason IS
	'When valid=false: the specific rejection reason '
	'(signer_not_official_account / signer_no_single_posting_key '
	'/ pubkey_mismatch). NULL when valid=true.';

-- ─── v11 ────────────────────────────────────────────
-- Morphit indexer — migration v11.
--
-- Phase 5 — syndication (ADR Q3 ratified: Option A, user-signed).
--
-- Adds two columns to `orders`:
--   syndicate_opt_in: set TRUE at order-creation time when the user
--     checks the "Syndicate my order" box on the post form. The
--     order handler will consume this from the op payload's optional
--     `syndicate` field (order handler modification is a separate
--     migration-adjacent code change shipping after this schema).
--   syndicated_trx_id: the Blurt trx_id of the announcement post
--     once it's published. Null until then. Prevents duplicate
--     announcements if the user opens the "pending announcement"
--     banner twice.
--
-- Both columns are nullable-or-defaulted-safe for existing rows:
--   - syndicate_opt_in defaults to FALSE (existing orders opted
--     out implicitly since the checkbox didn't exist when they
--     were created)
--   - syndicated_trx_id is nullable; null is the correct value
--     for any order that hasn't been announced yet
--
-- IF NOT EXISTS is used for defensive replay — the migration
-- tracker already prevents double-application, but belt-and-
-- suspender in case of manual intervention.
--
-- Why these belong on `orders` rather than a separate table:
--   - The 1:1 relationship with orders (each order is syndicated
--     once or not at all) makes a separate table pure overhead.
--   - Queries filtering for "orders awaiting syndication" are
--     simple WHERE clauses, no JOIN needed.
--   - Schema stability: these are the only two syndication-related
--     columns the order row needs. No further growth expected.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS syndicate_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS syndicated_trx_id VARCHAR(64);

-- No index needed. The only predicate-level read pattern is
-- "find orders where I opted in but haven't published yet" and
-- that's scoped to a specific account via existing orders_account
-- index, not a global scan.

-- ─── v12 ────────────────────────────────────────────
-- Morphit indexer — migration v12.
--
-- Phase 5d cleanup — drop dead syndication columns from `orders`.
--
-- v11 added these columns for a syndication design that was later
-- revised before shipping. The current implementation uses a
-- different mechanism (see docs/SYNDICATION-CHECKPOINT.md + Post A/B
-- patterns in the frontend) that does not consult either column.
-- Neither column is read or written anywhere in the current code:
--
--   - `syndicate_opt_in`: was intended as a boolean flag set when
--     the user opted into order-level syndication. The opt-in is now
--     a client-side boolean stored in a localStorage flag and a
--     per-order comment post, not an order-row column.
--
--   - `syndicated_trx_id`: was intended to memoize the trx_id of an
--     announcement post to prevent double-broadcast. The current
--     design uses a deterministic account-keyed permlink so duplicate
--     broadcasts are chain-idempotent (they become edits, not new
--     posts), making the memoization unnecessary.
--
-- IF EXISTS is defensive. The migration tracker prevents double-
-- application, but this guard makes the migration safe to replay
-- manually against a partially-reverted database.
--
-- Reversibility: trivial. If someone ever wants these columns back,
-- they can be re-added by re-applying v11's DDL. The columns held
-- no data worth preserving (values were the defaults everywhere).

ALTER TABLE orders DROP COLUMN IF EXISTS syndicate_opt_in;
ALTER TABLE orders DROP COLUMN IF EXISTS syndicated_trx_id;

-- ─── v13 ────────────────────────────────────────────
-- Morphit indexer — migration v13.
--
-- chat_identities table for morphit_chat_v1 ECIES crypto per
-- ADR-0015. Each account publishes its 32-byte X25519 public
-- chat key via morphit_chat_identity_v1; this table records
-- the latest publication per account.
--
-- Retention: latest-only. Key rotation overwrites the row in
-- place. The full event log retains history if ever needed.
--
-- Access pattern: single-row lookup by account, used when a
-- sender's client needs to encrypt a new message. Web clients
-- will typically hit this endpoint once per conversation (the
-- key doesn't change mid-conversation barring explicit rotation)
-- so lookup volume is low.
--
-- Storage: BYTEA for chat_pub — 32 raw bytes rather than base64'd
-- text. The endpoint converts to base64 for the JSON response.
-- This saves ~50% disk for the bulk of the table and avoids
-- round-tripping on every read.
--
-- Size bound: one row per active chatting account. 100k accounts
-- × ~80 bytes/row ≈ 8 MB. Trivial.

CREATE TABLE IF NOT EXISTS chat_identities (
    account TEXT PRIMARY KEY,
    chat_pub BYTEA NOT NULL CHECK (octet_length(chat_pub) = 32),
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE chat_identities IS
    'Published X25519 chat public key per account (ADR-0015).';
COMMENT ON COLUMN chat_identities.chat_pub IS
    '32-byte X25519 public key. Raw bytes, not base64.';

-- ─── v14 ────────────────────────────────────────────
-- Morphit indexer — migration v14.
--
-- chat_read_state table for on-chain chat read receipts (Phase B
-- of the inbox design — see docs/REVISIT-LIST.md §D and the
-- accompanying design in docs/CHAT-READ-RECEIPTS-DESIGN.md).
--
-- Each row records that `reader_account` has acknowledged reading
-- their conversation with `peer_account` up through `last_read_at`.
-- Any message in the chat_messages table with created_at <=
-- last_read_at is "read" from reader_account's perspective.
--
-- Acks arrive via the morphit_chat_read_v1 custom_json op (new
-- handler). The handler writes or updates the row for the
-- (reader, peer) pair, with a monotonic guard: a later ack with
-- an earlier timestamp than the current last_read_at is rejected
-- (out-of-order / replay defense). This keeps read state strictly
-- advancing.
--
-- Retention: latest-only per (reader, peer). Full history is
-- recoverable from on-chain ops if ever needed; this table is
-- a derived read-state cache for fast API queries.
--
-- Access patterns:
--   1. "Give me all my read state" — bulk fetch by reader_account.
--      Used by the /chat inbox to compute unread counts per peer.
--      Index: chat_read_state(reader_account) implicit in PK.
--   2. Point lookup for (reader, peer) — used by the /chat/[peer]
--      view to confirm whether a specific conversation is fully
--      read. PK lookup.
--
-- Size: one row per (reader, peer) pair ever ack'd. For 100k
-- accounts × ~50 chat partners each × 100 bytes/row ≈ 500 MB.
-- Reasonable. Can be pruned later if needed (remove rows where
-- peer hasn't sent a message in > N days).

CREATE TABLE IF NOT EXISTS chat_read_state (
    reader_account TEXT NOT NULL,
    peer_account TEXT NOT NULL,
    last_read_at TIMESTAMPTZ NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (reader_account, peer_account),
    CHECK (reader_account <> peer_account)
);

COMMENT ON TABLE chat_read_state IS
    'Per-(reader, peer) chat read-ack state (Phase B inbox read receipts). See v39: re-keyed per discussion.';
COMMENT ON COLUMN chat_read_state.last_read_at IS
    'Timestamp through which reader has acknowledged reading peer''s messages. Strictly advances — later acks with earlier timestamps are rejected at handler intake.';
COMMENT ON COLUMN chat_read_state.source_trx_id IS
    'trx_id of the morphit_chat_read_v1 op that wrote this row. For forensic trace.';

-- No secondary index needed — PK covers both bulk-fetch by reader
-- (prefix of composite PK) and point lookup by (reader, peer).

-- ─── v15 ────────────────────────────────────────────
-- Morphit indexer — migration v15.
--
-- Adds the `blocks` table for per-recipient block lists. Chat
-- handler consults this table on every incoming message; if a
-- row exists with state='blocked' where recipient is `blocker`
-- and sender is `blocked`, the message is rejected with
-- `recipient_blocked_sender` without storing the ciphertext.
--
-- Part of ADR-0014 chat-scoping decisions (Finding H — chat
-- anti-spam triad, belt-and-suspenders (b) + (c)). This
-- migration covers the "block list" layer; the stranger-fee
-- and rate-limit layers arrive in later migrations.
--
-- Schema rationale:
--   * Composite PK (blocker, blocked) — at most one active
--     relationship per pair. Unblock doesn't delete the row;
--     it flips `state`, preserving a minimal audit trail in
--     `updated_at` / `last_action_block_num` so operators can
--     see "this user blocked and unblocked the same account
--     three times in a week" if that ever matters.
--   * (since_block_num, since_trx_id) anchor the ORIGINAL
--     block decision to the Blurt chain. On unblock + re-block,
--     `since_*` rewinds to the new block op.
--   * `state` as a TEXT CHECK constraint rather than an enum
--     so future states (e.g. "muted" for soft suppression) can
--     be added with a plain ALTER.
--
-- Frontend behavior the handler assumes:
--   * A user can block anyone (no counterparty precheck).
--   * A user can unblock anyone they previously blocked.
--   * Blocking does NOT notify the blocked account (the op
--     is public on-chain, so anyone scraping can learn it,
--     but Morphit's UI deliberately doesn't surface
--     "you've been blocked by @x" — that's an anti-harassment
--     call, not a privacy one).

CREATE TABLE IF NOT EXISTS blocks (
    -- The account doing the blocking. Stored as Blurt account
    -- name (3..16 chars, lowercase, hyphens + dots + digits).
    blocker                  VARCHAR(16) NOT NULL,

    -- The account being blocked. Same constraints.
    blocked                  VARCHAR(16) NOT NULL,

    -- 'blocked' — active relationship; chat handler rejects.
    -- 'unblocked' — relationship was once blocked but the
    --   blocker has since reversed. Row is kept for audit.
    state                    TEXT        NOT NULL
        CHECK (state IN ('blocked', 'unblocked')),

    -- Block number on the Blurt chain where the ORIGINAL
    -- block decision landed. Does not move when the state
    -- flips — this anchors "when did this relationship start?"
    since_block_num          BIGINT      NOT NULL,

    -- Transaction id of the original block decision. Useful
    -- for audit / dispute ("can you prove I blocked them on
    -- 2025-11-14?") — the user can present this trx_id on
    -- blocks.blurtwallet.com and see the raw op.
    since_trx_id             VARCHAR(40) NOT NULL,

    -- Block number where the MOST RECENT action landed
    -- (including re-blocks and unblocks). Moves with every
    -- op that touches this row.
    last_action_block_num    BIGINT      NOT NULL,

    -- Blurt block time of the FIRST block decision. Fixed.
    created_at               TIMESTAMPTZ NOT NULL,

    -- Blurt block time of the LATEST state change. Moves.
    updated_at               TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (blocker, blocked),

    -- Self-block is nonsense; the handler rejects it too, but
    -- a CHECK here is a cheap second line of defense.
    CHECK (blocker <> blocked)
);

-- Fast lookup for the chat handler's hot path: "does `sender`
-- appear in any recipient's block list?" The handler queries
-- `WHERE blocker = $recipient AND blocked = $sender AND
-- state = 'blocked'`, which is already covered by the PK. But
-- the Settings "Blocked accounts" page lists all accounts a
-- user has blocked, which wants `WHERE blocker = $me AND
-- state = 'blocked'`. The PK prefix covers that too.
--
-- A separate index on `blocked` would help "who has blocked
-- me?" — but surfacing that answer contradicts the explicit
-- UX decision not to tell blocked users they're blocked. We
-- deliberately don't add that index to avoid normalizing a
-- query pattern that shouldn't exist.

-- ─── v16 ────────────────────────────────────────────
-- Morphit indexer — migration v16.
--
-- Adds the `stranger_fees` table for Finding H layer 2 — the
-- stranger-fee gate on first-contact chat messages. Once a
-- sender has paid the fee for a given recipient (via a
-- morphit_stranger_fee_v1 op accompanied by a Blurt transfer
-- to @morphit-fees), the pair is fee-free forever.
--
-- Schema rationale:
--   * Composite PK (sender, recipient) — one row per pair.
--     Re-submitted fee ops against the same pair collide on
--     the PK; the handler translates the collision into an
--     idempotent success (no double-billing, no double-
--     admission).
--   * paid_block_num + paid_trx_id anchor the payment to the
--     Blurt chain for dispute resolution.
--   * amount_blurt is the raw BLURT amount the user actually
--     transferred; amount_usd_equivalent is what the client
--     quoted at send-time using the live price feed. Both are
--     recorded for transparency — the user can always answer
--     "what did I pay and what was it worth?" without trusting
--     the current price.
--
-- Layer 2 is deliberately additive to layers 1 (block list)
-- and 3 (rate limits). A blocked sender's stranger-fee is
-- accepted by this handler (the handler doesn't re-check
-- blocks — that's the chat handler's job), but their chat
-- messages still won't reach the blocked recipient. This
-- separation is intentional: fees are pair-level bookkeeping,
-- not admission.

CREATE TABLE IF NOT EXISTS stranger_fees (
    -- Account that paid the fee. Blurt account name.
    sender                    VARCHAR(16) NOT NULL,

    -- Account the sender paid to contact.
    recipient                 VARCHAR(16) NOT NULL,

    -- Block number where the morphit_stranger_fee_v1 op landed.
    paid_block_num            BIGINT      NOT NULL,

    -- Trx id of the op (which carried the sibling transfer).
    -- Usable as `blocks.blurtwallet.com/tx/<trx_id>` for audit.
    paid_trx_id               VARCHAR(40) NOT NULL,

    -- Blurt block time of payment.
    paid_at                   TIMESTAMPTZ NOT NULL,

    -- Exact BLURT amount the sender transferred to
    -- @morphit-fees. Stored for dispute / audit. NUMERIC with
    -- enough precision for Blurt's 3-decimal-place amounts.
    amount_blurt              NUMERIC(20,3) NOT NULL,

    -- NOTE (cp175 F-005): the legacy `amount_usd_equivalent` column
    -- (a USD echo from the pre-BLURT-denomination fee model) is
    -- intentionally absent. It was created-then-dropped via a v20
    -- ALTER in earlier revisions of this collapsed baseline; since
    -- this is the pre-launch baseline (never deployed), the column is
    -- simply not declared. The handler's INSERT does not provide it.
    -- amount_blurt is the authoritative recorded value.

    PRIMARY KEY (sender, recipient),

    -- Self-payment is nonsense and the handler rejects it, but
    -- a CHECK here is a cheap second line of defense.
    CHECK (sender <> recipient),

    -- Paid amounts should be positive. Bounds are generous —
    -- we don't want to reject a user who over-paid the fee
    -- (their choice); we just want to reject pathological
    -- values (zero, negative, overflow).
    CHECK (amount_blurt > 0)
);

-- Reverse-index for "what pairs has this sender paid for?"
-- Supports a future UX where a user can see a list of accounts
-- they've paid to message. PK prefix gives us free lookup on
-- `WHERE sender = $X AND recipient = $Y`; this index adds
-- fast `WHERE sender = $X` scans.
CREATE INDEX IF NOT EXISTS stranger_fees_sender_idx
    ON stranger_fees (sender, paid_at DESC);

-- ─── v17 ────────────────────────────────────────────
-- Morphit indexer — migration v17.
--
-- Widens the orderbook's hot-path partial index to include
-- orders whose fee_status is 'verified_by_attestation' (the
-- Finding I completion path — community-attested BTC/XMR fee
-- payments). Previously the index only matched 'verified'
-- (native BLURT transfer to @morphit-fees), which meant that
-- attestation-verified orders would appear in the orderbook
-- endpoint via a full sequential scan rather than the indexed
-- hot path.
--
-- Postgres partial indexes' predicates are immutable, so we
-- DROP + recreate rather than ALTER. The migration system
-- wraps each migration in a transaction for atomicity, which
-- means we can't use CREATE INDEX CONCURRENTLY here — but the
-- orders table is small enough (indexer-scale, not
-- exchange-scale) that the blocking recreate runs in a few
-- seconds at most.
--
-- Rename the index (orders_verified_live_idx →
-- orders_live_established_idx) so its name matches the new
-- predicate. Anyone inspecting the schema will see the scope
-- correctly — the old name lies about what the index covers.

DROP INDEX IF EXISTS orders_verified_live_idx;

CREATE INDEX orders_live_established_idx
    ON orders (asset, side, updated_at DESC)
    WHERE status = 'live'
      AND fee_status IN ('verified', 'verified_by_attestation');

-- ─── v18 ────────────────────────────────────────────
-- Morphit indexer — migration v18.
--
-- Finding O19 (order-placement audit): record external_tx_id on
-- BTC/XMR orders + enforce uniqueness so a single off-chain
-- payment cannot be reused across multiple listings.
--
-- Threat: attacker pays one BTC fee, then broadcasts N
-- morphit_order_v1 ops each claiming the same external_tx_id.
-- Each verification runs independently against the explorer,
-- sees the legitimate payment, and marks each order verified.
-- One fee paid, N listings free.
--
-- Defense: write external_tx_id alongside the row.  A unique
-- partial index on (fee_method, external_tx_id) WHERE
-- external_tx_id IS NOT NULL prevents subsequent claims.  The
-- handler also pre-checks for reuse before invoking the verifier
-- (saves an explorer round-trip when reuse is detected) and
-- inserts the rejected order with fee_status='reused' so the
-- payer can see why their listing didn't go live.
--
-- Composite key on (fee_method, external_tx_id):
--   - BTC and XMR txid namespaces are formally distinct
--     (different lengths, different formats), so collisions
--     are implausible — but pinning by fee_method makes the
--     intent explicit and defends against future fee_methods.
--   - 'blurt' / 'waived_first_buy' rows have external_tx_id
--     NULL and are excluded by the WHERE filter.
--
-- Backwards-compatibility: existing rows have external_tx_id
-- NULL.  All current ADR-0009 BLURT-path orders are unaffected.
-- Sub-phase 4b BTC/XMR orders that were already in the DB at
-- migration time would also be NULL — those orders won't have
-- their reuse-detection retrofitted, but going forward all new
-- btc/xmr orders are protected.

ALTER TABLE orders
    ADD COLUMN external_tx_id TEXT;

COMMENT ON COLUMN orders.external_tx_id IS
'For btc/xmr fee_method orders, the off-chain transaction id that paid the fee. NULL for blurt/waived. Indexed UNIQUE per fee_method to prevent reuse across orders (Finding O19).';

-- Unique partial index. PG enforces uniqueness only over the
-- subset matching the WHERE clause, so the abundance of NULL-
-- valued blurt rows costs us nothing.
CREATE UNIQUE INDEX IF NOT EXISTS orders_external_tx_id_uniq
    ON orders (fee_method, external_tx_id)
    WHERE external_tx_id IS NOT NULL;

-- Extend fee_status CHECK to include 'reused' — set when the
-- handler's pre-check detects a prior order claiming the same
-- (fee_method, external_tx_id).  Same DROP-and-readd pattern
-- v5 used to add 'pending_external' and 'verified_by_attestation'.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fee_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_fee_status_check CHECK (
    fee_status IN (
        'unverified',
        'verified',
        'missing',
        'underpaid',
        'pending_external',
        'verified_by_attestation',
        'reused'
    )
);

-- ─── v19 ────────────────────────────────────────────
-- Morphit indexer — migration v19.
--
-- Finding N23 follow-up (signup/welcome-bonus audit): defend
-- against the rare double-broadcast window in the relay
-- queue drainer.
--
-- Scenario: drainer broadcasts a transfer to chain
-- (succeeds), then the post-success "UPDATE broadcast_at"
-- query fails for some transient PG reason — the savepoint
-- around the row rolls back, and the next drain cycle picks
-- up the same row and broadcasts again.  Result: bonus
-- recipient gets paid twice; relay's BLURT balance drains
-- twice.
--
-- Defense: a `broadcast_attempt_at` timestamp written BEFORE
-- the chain broadcast.  If the row has broadcast_attempt_at
-- set but broadcast_at NULL, that's evidence we already
-- attempted; the next drain cycle skips it for a 10-minute
-- cool-off so transient failures clear, with longer-stuck
-- rows surfacing in operator dashboards for manual review.
--
-- Backwards-compatibility: nullable column.  Existing rows
-- have NULL, which the drainer's selectPending query treats
-- as "never attempted, eligible for first try."

ALTER TABLE relay_pending_transfers
    ADD COLUMN broadcast_attempt_at TIMESTAMPTZ;

COMMENT ON COLUMN relay_pending_transfers.broadcast_attempt_at IS
'Set by the relay drainer immediately before issuing the chain broadcast for this row. If non-NULL but broadcast_at is NULL, the row is in a "we tried, outcome unknown" state — the drainer holds off auto-retry for 10 minutes so transient failures recover and stuck rows surface for operator review. Closes a residual double-broadcast window from Finding N23.';

-- ─── v20 ────────────────────────────────────────────
-- Morphit indexer — migration v20.
--
-- BLURT-native fee refactor: the `amount_usd_equivalent` column on
-- `stranger_fees` (a USD echo from the pre-BLURT-denomination fee
-- model) is no longer used.
--
-- Background: when stranger-fees were USD-denominated (anchor
-- $0.01 doubling per first-contact within 5 min, capped at
-- $1.28), the column recorded what the client quoted at send-
-- time using the live price feed.  After the refactor, fees
-- are denominated directly in BLURT (5 BLURT base, doubling
-- to a 640 BLURT cap).  The amount_blurt column already
-- records what was actually transferred; the USD echo was
-- never authoritative and is now redundant.
--
-- cp175 F-005: in this collapsed pre-launch baseline the column is
-- simply never declared (see the stranger_fees CREATE TABLE above),
-- so the historical DROP is a harmless no-op kept only for
-- version-tracking parity with the archived per-version migrations.
-- `IF EXISTS` makes it safe on the fresh baseline where the column
-- was never created.

ALTER TABLE stranger_fees
    DROP COLUMN IF EXISTS amount_usd_equivalent;

-- ─── v21 ────────────────────────────────────────────
-- Phase D.5 — Federation auto-discovery.
--
-- Two changes here:
--
-- 1. Add `origin` column to `operators`.  v2 of the operator-register
--    op (see operatorRegister.ts handler) accepts an optional origin
--    URL.  When the origin is set we persist it here, treating it as
--    canonical: "the on-chain record claims this operator's instance
--    is reachable at this origin."
--
-- 2. New `known_instances` table.  Operational state for the
--    federation directory: one row per origin we've heard about,
--    with cached probe status from the indexer's liveness scanner.
--    Driven entirely by chain replay (registrations populate it)
--    and the probe scheduler (probes update status), so no manual
--    curation.
--
-- Backwards-compatible: old register ops without origin still
-- work (origin column is nullable; v2 schema is a strict
-- superset of v1 in payload validation).

ALTER TABLE operators
	ADD COLUMN IF NOT EXISTS origin TEXT;

CREATE TABLE IF NOT EXISTS known_instances (
	-- Canonical key: the origin URL exactly as registered on-chain.
	-- Stored normalized (no trailing slash, lowercase scheme/host).
	origin                TEXT PRIMARY KEY,

	-- The on-chain account that claimed this origin via a register
	-- op.  Single source of truth for "@alice claims X" — the probe
	-- layer cross-checks by hitting X/v1/instance and verifying the
	-- relay_account field matches.  Mismatch → 'mismatch' status.
	operator_account      TEXT NOT NULL,

	-- Block + time at which the registration op landed.  Used for
	-- the new-instance grace period (newer than 7 days → exempt
	-- from "no orders" probe failure).
	registered_at_block   BIGINT NOT NULL,
	registered_at_time    TIMESTAMPTZ NOT NULL,

	-- Last time the probe scheduler reached out to this origin.
	-- NULL → never probed (just-discovered, queued for first probe).
	last_probed_at        TIMESTAMPTZ,

	-- Status of the most recent probe.  Values:
	--   'never'        — table entry exists but probe hasn't run yet
	--   'good'         — all checks passed (see api/instances.ts)
	--   'quiet'        — alive but no orderbook activity in last 7d
	--                    AND >7d old (newer instances graceful)
	--   'stale'        — /v1/health returned 'degraded', or chain lag
	--                    > 30 blocks at last probe
	--   'unreachable'  — HTTP fetch failed (timeout, refused, DNS, TLS)
	--   'mismatch'     — origin reachable but /v1/instance.relay_account
	--                    doesn't match the operator_account from chain
	last_probe_status     TEXT,

	-- Operator-readable error string from the last unsuccessful probe.
	-- Examples: "HTTP 503", "connect ETIMEDOUT", "TLS expired",
	-- "operator_account mismatch: chain says @alice, instance says @bob"
	last_probe_error      TEXT,

	-- Cached snapshot of the last successful /v1/instance + /v1/health
	-- response.  Lets /v1/instances serve from DB without fan-out
	-- fetches per request.  Updated only on a successful probe; stale
	-- data is fine (probe runs every 10min for healthy instances).
	cached_name           TEXT,
	cached_tagline        TEXT,
	cached_contact_url    TEXT,
	cached_alt_networks   JSONB,
	cached_indexed_block  BIGINT,
	cached_chain_lag_sec  INT,

	-- Counter for the back-off + drop logic.  Resets to 0 on any
	-- successful probe.  Once it hits the 7-day-failure ceiling
	-- (≈168 hourly probes), the row is deleted and would only
	-- re-appear if a fresh registration op lands.
	consecutive_failures  INT NOT NULL DEFAULT 0
);

-- Index for the common "give me everything still good" query
-- served by /v1/instances?status=good.
CREATE INDEX IF NOT EXISTS idx_known_instances_status
	ON known_instances (last_probe_status)
	WHERE last_probe_status IN ('good', 'quiet');

-- Index for the probe scheduler picking what's next to probe.
-- Probes are due when last_probed_at < now() - interval, where
-- interval is status-dependent (10min for good, 1hr for stale).
-- The scheduler scans this table by last_probed_at ASC NULLS FIRST,
-- so the index supports the bulk probe-due lookup.
CREATE INDEX IF NOT EXISTS idx_known_instances_probe_due
	ON known_instances (last_probed_at NULLS FIRST);

-- ─── v22 ────────────────────────────────────────────
-- Phase G prep / task #14 — private viewcounts on trade offers.
--
-- Single-counter-per-order table.  When an unsigned-in or
-- signed-in user lands on an order detail page, the frontend
-- POSTs to /v1/orders/:permlink/view and we increment count.
-- The owner of the order can then see "your offer was viewed
-- N times" — that's it.
--
-- PRIVACY DESIGN NOTES (DO NOT REGRESS):
--
--   - No IP column.  We deliberately don't track who's viewing.
--     Even the owner doesn't get IPs; they only get the count.
--   - No timestamps per view.  A timestamps column would let
--     someone with read access correlate view times against
--     external events (an order viewed exactly when a tweet
--     went out → social-graph leak).  We keep just the
--     aggregate.
--   - No per-viewer-account row.  Same rationale — knowing
--     "alice viewed your offer" defeats the purpose.
--   - Non-unique counts (same person reloading bumps the
--     counter).  This makes the metric weakly informative
--     rather than precise — which is the point.  Owners get a
--     rough signal of "is this generating interest" without
--     the metric being so detailed it becomes a surveillance
--     vector.
--   - Spam / abuse mitigation is at the reverse-proxy layer
--     (nginx limit_req zone), NOT at this layer.  If the
--     indexer were to track "X views from same IP in Y
--     seconds" it would have to log IPs, which would defeat
--     the whole privacy model.
--
-- The "owner only" gate is enforced by the GET endpoint, not
-- the table — the table is readable by the indexer process,
-- of course; the gating happens in api/orderViews.ts where the
-- request must carry a signature proving Auth as the order's
-- author.

CREATE TABLE order_views (
    permlink   text     PRIMARY KEY,
    count      bigint   NOT NULL DEFAULT 0,
    -- updated_at is here for ops debugging only (let an
    -- operator see "was this row touched in the last hour"
    -- when investigating) but it's the row's last-update
    -- time, NOT a list of when individual views occurred.
    -- Strictly aggregate.
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The increment query (`UPDATE order_views SET count = count + 1`)
-- is the hot path.  Primary-key lookup by permlink already
-- gives us O(log n) — no additional index needed.

-- ─── v23 ────────────────────────────────────────────
-- Migration 23 — operator_blocks
--
-- Item 3: operator-instance blocks.  Mirrors the user-level `blocks`
-- table but keyed on (operator, blocked) and carries an operator-
-- supplied reason string.  Only the configured operator account
-- can write to this table (handler gates on
-- ctx.signer === ctx.config.officialAccountName).
--
-- The `state` enum mirrors `blocks` so the read pattern is uniform.
-- A row with state='unblocked' is preserved (not deleted) so the
-- audit trail of "operator blocked alice on day X, unblocked on
-- day Y" stays visible.

CREATE TABLE operator_blocks (
    operator               varchar(16)  NOT NULL,
    blocked                varchar(16)  NOT NULL,
    state                  varchar(10)  NOT NULL CHECK (state IN ('blocked', 'unblocked')),
    reason                 text         NOT NULL DEFAULT '',
    -- since_* points at the chain op that established the CURRENT
    -- relationship.  block-after-unblock moves these to the new op;
    -- unblock-after-block keeps them pointing at the original block
    -- (audit trail of when the relationship started).
    since_block_num        bigint       NOT NULL,
    since_trx_id           varchar(64)  NOT NULL,
    -- last_action_block_num always points at the most recent op
    -- against this pair, even idempotent reasons-amend re-blocks.
    last_action_block_num  bigint       NOT NULL,
    -- created_at + updated_at are chain block times (NOT op
    -- self-reported ts, which a malicious operator could backdate).
    created_at             timestamptz  NOT NULL,
    updated_at             timestamptz  NOT NULL,
    -- origin distinguishes a federated, on-chain block (the
    -- morphit_operator_block_v1 op — the default for handler writes)
    -- from an INSTANCE-LOCAL block written directly by `morphit-ops
    -- block` (no posting key, never broadcast, affects only THIS
    -- instance's view, and not clobbered by chain replay).  For a
    -- local block since_trx_id is the sentinel 'local' and
    -- since_block_num is the indexer's last-applied block at write time.
    origin                 varchar(8)   NOT NULL DEFAULT 'chain'
                                        CHECK (origin IN ('chain', 'local')),
    PRIMARY KEY (operator, blocked),
    CHECK (operator <> blocked),
    CHECK (length(reason) <= 500)
);

-- Lookup index: "is account X blocked on this instance?"  Hot path
-- for orderbook view filtering and for the blocked-user banner
-- check on every page mount.  We scope by operator first because
-- the indexer typically serves a single operator's instance, so
-- (operator='morphit', blocked=$1) is the lookup pattern.
CREATE INDEX operator_blocks_blocked_state_idx
    ON operator_blocks (operator, blocked, state);

-- Audit-trail index: "list every account this operator has ever
-- acted on."  Used by the public-audit page (future) and by ops-cli
-- status reports.
CREATE INDEX operator_blocks_operator_state_idx
    ON operator_blocks (operator, state, updated_at DESC);

-- ─── v24 ────────────────────────────────────────────
-- Migration 24 — instance_payment_methods
--
-- Batch L (ADR-0021): operator-instance payment-method additions.
-- Operators broadcast `morphit_payment_method_addition_v1` ops to
-- extend the canonical registry with region-specific methods (e.g.
-- a Thailand operator adds "PromptPay").  Additions render in the
-- picker alongside canonical entries with a "(this instance only)"
-- badge.  Operators can NOT remove canonical entries — federation
-- safety requires the canonical list to be globally consistent.
--
-- Only the configured operator account can write to this table.
-- The frontend reads from `/v1/instance/payment-methods` (a
-- dedicated public endpoint) on app boot to populate the picker.
--
-- Keys:
--   - `key`: the operator-supplied identifier ([a-z0-9_]+, 3-24
--     chars).  Stored on chain in orders' `payment_methods` array
--     prefixed `@instance:<key>`.  The handler validates that the
--     key does NOT collide with any canonical key from
--     apps/web/src/lib/payments/registry.ts (the indexer keeps a
--     hardcoded list of reserved keys; see handler).
--   - `name`: display name (≤64 chars, NFC-normalized).
--   - `description`: ≤300 chars, sanitized for bidi/zero-width.
--   - `category`: one of 'crypto', 'in_person', 'online'.
--   - `state`: 'active' or 'removed'.  Removed entries stay in
--     the table for audit trail but the API filters them out.

CREATE TABLE instance_payment_methods (
    operator               varchar(16)  NOT NULL,
    key                    varchar(24)  NOT NULL,
    name                   varchar(64)  NOT NULL,
    description            text         NOT NULL DEFAULT '',
    category               varchar(16)  NOT NULL CHECK (category IN ('crypto', 'in_person', 'online')),
    url                    text,
    state                  varchar(10)  NOT NULL CHECK (state IN ('active', 'removed')),
    -- since_* anchors the current state's establishing op.
    since_block_num        bigint       NOT NULL,
    since_trx_id           varchar(64)  NOT NULL,
    last_action_block_num  bigint       NOT NULL,
    created_at             timestamptz  NOT NULL,
    updated_at             timestamptz  NOT NULL,
    PRIMARY KEY (operator, key),
    CHECK (length(description) <= 300),
    CHECK (key ~ '^[a-z][a-z0-9_]+$')
);

-- Hot path: "list this instance's active additions for the picker."
CREATE INDEX instance_payment_methods_active_idx
    ON instance_payment_methods (operator, state, category, name)
    WHERE state = 'active';

-- ─── v25 ────────────────────────────────────────────
-- Migration 25 — chat_messages.order_permlink
--
-- Adds an optional plaintext `order_permlink` column to
-- chat_messages so that engagement counts per order can be
-- computed without a full ciphertext scan.  The on-wire
-- field was added in Q11 (apps/indexer/src/indexer/handlers/
-- chat.ts) for the stranger-fee bypass; this migration just
-- makes that field durable in the DB so the orderbook can
-- show "N people are messaging this seller about this order"
-- without re-scanning chain history every time.
--
-- Privacy note: the field is plaintext on chain (Q11 design)
-- so persisting it does NOT expose data the chain doesn't
-- already expose.  Anyone scraping Blurt can already derive
-- "user A messaged user B about order X" by parsing the
-- chat ops.  The indexer is one of many such observers.
--
-- Nullable on purpose: pre-Q11 messages and ANY first-DM
-- (non-order chat) messages legitimately have no order
-- attribution.  Storing NULL is correct and not a "missing
-- data" concern.
--
-- Index strategy: hot path is "count distinct senders for
-- this order in last 24h" (orderbook engagement signal).
-- A partial index `WHERE order_permlink IS NOT NULL` keeps
-- the index small (only the subset of messages that name
-- an order) while serving the count query.  Lookup uses
-- (order_permlink, created_at) so a 24h-windowed
-- COUNT(DISTINCT sender) is fast.
--
-- Backfill: not done.  The field is forward-only; pre-v25
-- messages stay NULL and are excluded from engagement
-- counts.  This is fine because engagement is a "right
-- now" signal — anything more than 24h old wouldn't be
-- counted regardless.

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS order_permlink TEXT;

CREATE INDEX IF NOT EXISTS chat_messages_order_engagement_idx
    ON chat_messages (order_permlink, created_at DESC, sender)
    WHERE order_permlink IS NOT NULL;

COMMENT ON COLUMN chat_messages.order_permlink IS
    'Optional plaintext order permlink the message was sent in response to (Q11 stranger-fee bypass + orderbook engagement counter). NULL for non-order DMs and pre-Q11 messages.';

-- ─── v26 ────────────────────────────────────────────
-- Migration 26 — feedback.has_verified_chat
--
-- ADR-0014 verified-chat badge.  At feedback intake, the
-- handler runs a conformance query against chat_messages +
-- suspicious_reciprocity to decide whether the
-- reviewer↔subject pair had a "verified chat" — meaning a
-- bidirectional conversation that looks like genuine trade
-- coordination, not a sock-puppet flood.  The result is
-- stored in this column at intake time so subsequent reads
-- of the feedback row are O(1) and don't have to re-evaluate
-- the conformance against potentially-stale chat history.
--
-- Criteria for has_verified_chat = TRUE (must hold at the
-- time the feedback was signed; see REVISIT-LIST §G ratings-
-- tying-to-chat-sessions for the full rationale):
--   1. ≥2 chat_messages from reviewer to subject before
--      feedback.created_at
--   2. ≥2 chat_messages from subject to reviewer before
--      feedback.created_at
--   3. ≥15 minutes elapsed between the pair's earliest and
--      latest chat_message before feedback.created_at
--   4. NO suspicious_reciprocity row for the pair (LEAST/
--      GREATEST canonicalized account pair)
--
-- What the badge claims: "these accounts had a conversation
-- that looks like real trade coordination."  What it does
-- NOT claim: "these are two distinct people."  A patient
-- attacker with two coordinated accounts can satisfy the
-- criteria; the badge is a correlation signal, not an
-- identity proof.
--
-- Backfill posture: NOT done.  The conformance query at
-- intake uses ctx.blockTime as the cutoff (not NOW()), so
-- pre-v26 feedback rows would need a per-row replay against
-- chat history at their original block time.  This is
-- expensive and has limited value (old feedback's badge
-- status won't influence current decisions much).  All
-- pre-v26 rows stay at the DEFAULT FALSE; new rows compute
-- and store the boolean at intake.  An offline backfill
-- job is documented in OPERATIONS.md if an operator wants
-- to retroactively populate.
--
-- Index strategy: no new index.  Reads of feedback rows
-- already filter by (subject) or (reviewer) which the
-- existing feedback_subject_idx + feedback_reviewer_idx
-- support.  has_verified_chat is a flag column, not a
-- query predicate, so a dedicated index would just bloat
-- write paths.

ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS has_verified_chat BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN feedback.has_verified_chat IS
    'ADR-0014 verified-chat badge: true iff the reviewer↔subject pair satisfied the bidirectional-chat conformance criteria at the time the feedback was signed. Computed once at intake; never recomputed on read.';

-- ─── v27 ────────────────────────────────────────────
-- Morphit indexer — migration v27.
--
-- Operator-earnings pipeline (REVISIT-LIST item 5).
--
-- Background. The fee-attribution & payout pipeline was
-- scaffolded in schema-v7.sql (operators + operator_earnings)
-- but never wired up.  schema-v7's operator_earnings schema
-- defined `last_payout_at` and `last_payout_blurt`, anticipating
-- a periodic-batch payout model, but no code wrote to it and
-- no automation existed.
--
-- Model decision (2026-05-02): immediate per-attribution
-- payout, NOT periodic batching.  Blurt has 3-second blocks
-- and effectively no per-transfer fee (mana-based; relay
-- already handles welcome-bonus transfers without strain).
-- Periodic batching offered no real cost savings and delayed
-- operator gratification by up to a week.  Immediate model:
-- the moment an order op is indexed and attribution fires,
-- the relay transfer is queued in the same transaction.
-- The relay drainer broadcasts it on its next cycle
-- (~seconds), so an operator sees BLURT land in their wallet
-- typically within 10-15 seconds of the user's order being
-- indexed.
--
-- Practical consequence for the schema: operator_earnings's
-- `last_payout_at` and `last_payout_blurt` columns are no
-- longer meaningful as "batch boundaries", because every
-- attribution is immediately "paid" via queue insert.  We
-- KEEP those columns (don't drop — minimizes migration
-- surface) but redefine their semantic: they now mean
-- "most recent attribution event" for UI display ("earned
-- 5 BLURT 3 seconds ago").
--
-- A new lifetime_paid_blurt column tracks lifetime BLURT
-- actually queued for transfer (separate from
-- cumulative_blurt_earned to allow future model divergence).
--
-- cp408 — the operator's 90% is now paid DIRECTLY at payment
-- time (the fee split's owner leg), so there is no separate
-- relay-payout enqueue. One append-only audit table remains:
-- every attribution lands a row in operator_attribution_events.
-- (The former operator_payouts table is retired — see below.)

-- ─── 1. operator_attribution_events ────────────────────────────
-- Append-only: one row per attributed listing fee.
--
-- We record both the GROSS fee paid (audit truth — what the
-- chain transferred) and the COMPUTED operator share (90% of
-- the BLURT-fee gross at attribution time).  Storing both
-- decouples the historical record from any future split-
-- percentage policy change: if Q3 ever shifts from 90/10 to
-- some other ratio, NEW events use the new ratio while the
-- audit log of OLD events stays intact.
--
-- order_permlink + order_account uniquely identify the source
-- order across accounts (different accounts can share permlinks
-- per Finding O27).  trx_id is the order op's transaction ID;
-- UNIQUE on it prevents replay double-credit.
CREATE TABLE IF NOT EXISTS operator_attribution_events (
    id                       BIGSERIAL PRIMARY KEY,
    operator_account         TEXT NOT NULL
        REFERENCES operators(account) ON DELETE CASCADE,
    operator_tag             TEXT NOT NULL,
    order_account            TEXT NOT NULL,
    order_permlink           TEXT NOT NULL,
    fee_blurt                NUMERIC NOT NULL CHECK (fee_blurt > 0),
    operator_share_blurt     NUMERIC NOT NULL CHECK (operator_share_blurt >= 0),
    treasury_share_blurt     NUMERIC NOT NULL CHECK (treasury_share_blurt >= 0),
    split_percent_at_event   NUMERIC NOT NULL
        CHECK (split_percent_at_event >= 0 AND split_percent_at_event <= 100),
    trx_id                   TEXT NOT NULL,
    block_num                BIGINT NOT NULL,
    block_time_at            TIMESTAMPTZ NOT NULL,
    observed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (trx_id),
    UNIQUE (order_account, order_permlink)
);

CREATE INDEX IF NOT EXISTS operator_attribution_events_operator_idx
    ON operator_attribution_events (operator_account, observed_at DESC);

-- ─── 2. operator_payouts: RETIRED (cp408) ─────────────────────
-- This table recorded one row per relay-transfer enqueue in the
-- old "fee lands in a treasury, relay forwards the operator's
-- 90%" model. That model is retired: the operator's 90% is now
-- paid directly at payment time by the fee split, so no relay
-- payout is enqueued and nothing writes this table. It is removed
-- (pre-launch, no migration surface). Per-order earnings history
-- lives in operator_attribution_events; the running tally lives
-- in operator_earnings.

-- ─── 3. operator_earnings: add lifetime_paid_blurt ──────────────
-- cp408 — the operator is paid directly at payment time (the fee
-- split), so cumulative_blurt_earned (from v7) and
-- lifetime_paid_blurt are equal: what the operator earned is what
-- they were paid. The column is kept (separate from
-- cumulative_blurt_earned) to allow future model divergence.
ALTER TABLE operator_earnings
    ADD COLUMN IF NOT EXISTS lifetime_paid_blurt NUMERIC NOT NULL DEFAULT 0
        CHECK (lifetime_paid_blurt >= 0);

-- ─── 4. Sanity check: operator_earnings columns exist ──────────
-- v7 created the table with `last_payout_at` and `last_payout_blurt`
-- already.  Verify they're present so this migration's later
-- updates don't fail on a partial schema.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'operator_earnings'
          AND column_name = 'last_payout_at'
    ) THEN
        RAISE EXCEPTION 'operator_earnings.last_payout_at column missing — schema-v7.sql not applied?';
    END IF;
END $$;

-- ─── v28 ────────────────────────────────────────────
-- Morphit indexer — migration v28.
--
-- Treasury chain-pin (Part 106; Part 107 privacy correction).
-- Adds a `treasury` JSONB column to the releases table.  When
-- non-null, the column carries the canonical Morphit treasury
-- BTC + XMR addresses and amounts, authoritatively pinned by
-- the @morphit posting key via the same trust anchor that
-- already authenticates the release version + hash_manifest +
-- endpoints.
--
-- Why it exists.  Pre-Part-106, every operator's indexer
-- trusted its own MORPHIT_INDEXER_BTC_FEE_ADDRESS /
-- _XMR_FEE_ADDRESS env vars as gospel — meaning a hostile
-- fork could change those env vars to a hostile address and
-- silently divert all BTC/XMR fees from users on that
-- instance.  ADR-0011's 2026-05-09 amendment says BTC/XMR
-- fees go 100% to the @morphit-fees treasury, but there was
-- no on-chain enforcement of the addresses themselves.
-- Treasury chain-pin closes that gap: the canonical addresses
-- live in a signed release op, every federated indexer reads
-- from the same source, and the env vars become a bootstrap-
-- only fallback for fresh indexers that haven't seen a
-- release op yet.
--
-- Schema shape (Part 107 — viewkey REMOVED).  When set,
-- treasury is a JSON object with the shape:
--   {
--     "btc": { "address": "bc1q...", "satoshis": 416 } | null,
--     "xmr": { "address": "4..." | "8...",
--              "piconero": "781250000" } | null
--   }
-- Either chain may be null in the JSON object to indicate
-- "this release does not pin a treasury for this chain"
-- (operators ramp up to chain-pin one chain at a time).
-- The whole `treasury` column may also be NULL to indicate
-- "this release op pre-dates Part 106 and does not pin
-- any treasury at all" — backward-compat for old releases.
--
-- Privacy invariant (Part 107, refined Part 108++ and Part 109).
-- The Monero PRIVATE view key is NEVER part of this column.
-- The handler's validateTreasury() silently strips any
-- `viewkey` field that a release op tries to include — the
-- field never reaches the DB.
--
-- Part 108++ replaced view-key-based decryption with per-
-- payment proof verification.  Part 109 removed the
-- `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` env var entirely and
-- removed the `viewkey` field from the in-memory XmrTreasury
-- interface.  No Morphit indexer holds a view key anywhere,
-- ever.  See docs/adr/0011-dynamic-fee-model.md amendments.
--
-- Backward-compat: column is nullable.  Historical rows from
-- v1-v27 stay with treasury IS NULL and the indexer's
-- TreasurySource falls back to env-var values for them.
ALTER TABLE releases
    ADD COLUMN IF NOT EXISTS treasury JSONB;

COMMENT ON COLUMN releases.treasury IS
    'When non-null: canonical Morphit treasury address + amount '
    'pin (BTC and/or XMR), authoritative for every federated '
    'indexer.  Part 107: NEVER contains the XMR view key — the '
    'handler strips that field at write time.  See '
    'docs/OPERATIONS.md §40.  When null: this release op '
    'pre-dates Part 106 OR deliberately omits the treasury '
    'pin (env-var fallback applies).';


-- ─── Migration v29 — XMR per-payment tx_proof (Part 108++) ────────
--
-- Adds an optional `tx_proof` TEXT column to the `orders` table.
-- Used only when fee_method='xmr'; null for all other methods.
--
-- Why this column exists.  Pre-Part-108++, XMR payment
-- verification required the indexer to hold the treasury wallet's
-- private view key and decode every incoming transaction with it.
-- Part 107 already corrected the design error of broadcasting that
-- key on chain, but it left the operator-private viewkey-on-the-
-- box requirement in place — meaning canonical morphit.io was the
-- only instance that could verify XMR payments, and community
-- operators had to either run their own treasury wallet or
-- disable XMR entirely.
--
-- Part 108++ replaces that with Monero's standard `tx_proof`
-- mechanism: the user generates a per-payment proof from their
-- wallet (e.g. monero-wallet-cli `get_tx_proof`, GUI "Prove
-- transaction" dialog, Cake/Feather equivalents) and submits the
-- proof string with the order.  The indexer verifies the proof
-- against the txid + treasury address using a public explorer
-- endpoint or a local monerod RPC — NO view key required.
--
-- Privacy properties of tx_proof:
--   - Reveals only "this txid sent this amount to this address"
--     — the same information needed for verification, no more.
--   - Does NOT reveal: other payments to the address, other
--     transactions in the user's wallet, the user's other
--     addresses, or wallet metadata.
--   - One-time, per-payment.  Possessing one proof tells you
--     nothing about other payments or future inflows.
--   - User holds the proof generation key in their own wallet;
--     no privileged party (not even canonical morphit.io) ever
--     needs the treasury's view key.
--
-- Decentralization properties:
--   - EVERY indexer can verify EVERY payment independently using
--     the same public information.  No central instance required.
--   - Canonical morphit.io is one indexer among many; nothing
--     special about its verification verdict.
--   - Federation tolerates any single instance being down;
--     verification never depends on canonical's availability.
--
-- The column is nullable so existing rows from before this
-- migration (Part 108++) keep `tx_proof IS NULL`.  New XMR orders
-- after this migration MUST include a tx_proof; the order
-- handler's structural validator enforces presence + format.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS tx_proof TEXT;

COMMENT ON COLUMN orders.tx_proof IS
    'XMR per-payment proof string (Monero `get_tx_proof` output).  '
    'Required when fee_method=xmr (Part 108++); null for blurt/btc/'
    'waived_first_buy.  Verified against (txid, treasury_address) '
    'via Monero explorer or local monerod RPC — no view key needed.';

-- ─── Migration v30 — Operator-scoped payout queue (Part 111) ─────────────
--
-- Adds `operator_tag` column to `orders` and indexes it for the
-- low-balance scanner's candidate query.  Closes a federation-
-- cost gap: pre-Part-111, every operator's relay queued payouts
-- (welcome bonus, low-balance refill, operator-payout 90%
-- share, loyalty milestone BP) on EVERY morphit op it saw on
-- chain, not just ops served by their own instance.  Result:
-- N operators in the federation → N× treasury spend on every
-- payout-triggering op.
--
-- The design uses the EXISTING `operator_tag` field on the
-- order op payload (set by the frontend from each instance's
-- runtime config).  Each operator's indexer compares the op's
-- `operator_tag` against `MORPHIT_INSTANCE_OPERATOR_TAG`; only
-- the operator whose tag matches queues the payout.  Other
-- operators record the op for orderbook + audit purposes but
-- skip the queue insert.  No new on-chain field; no new
-- privacy leak; uses already-published data.
--
-- For feedback ops (welcome bonus), the gate is the CITED
-- order's `operator_tag` — looked up from the orders table.
-- A feedback op citing an order from another operator's
-- instance will not trigger this operator's welcome bonus.
--
-- For low-balance refills, the scanner's candidate selection
-- joins on `orders.operator_tag = MY tag` so an operator
-- refills only users whose orders attribute to their
-- instance.  Users active across multiple instances may be
-- refilled by each instance independently (per-instance
-- cooldown applies); this is acceptable — they ARE active
-- users of each.
--
-- Backward-compat: column is NULLABLE.  Pre-Part-111 orders
-- (none in production — zero live instances) stay NULL.  The
-- gate treats NULL as "no operator attributed" → no queue
-- insert anywhere.  Pre-launch reality means this compat is
-- for replay tests only.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS operator_tag TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_operator_tag_account_created
    ON orders (operator_tag, account, created_at);

COMMENT ON COLUMN orders.operator_tag IS
    'Operator-attribution: the tag set by the instance the user '
    'submitted the order through (e.g. "morphit", "example-'
    'community").  Same value as on operator_attribution_events. '
    'Used to gate per-operator payout queue inserts (welcome '
    'bonus, low-balance refill, operator-payout, loyalty BP) — '
    'only the operator whose MORPHIT_INSTANCE_OPERATOR_TAG '
    'matches this column queues the payout.  Migration v30 '
    '(Part 111).';

-- ─── Migration v31 — Signal C: one-way pile-on detection (Part 113) ───────
--
-- Adds the `one_way_pile_on` table for Signal C — the third self-
-- trade / reputation-attack heuristic.  Complements Signals A and B
-- (defined in ADR-0009 §5), which catch self-trade clusters
-- attempting to INFLATE reputation:
--
--   - Signal A flags accounts created by the same creator with
--     close-timed first activity → `related_accounts`.
--   - Signal B flags pairs exchanging ≥3 mutual 5-star reviews
--     within 7 days, with no third-party feedback from either
--     side → `suspicious_reciprocity`.
--
-- Signal C is the DEFLATION mirror: a pile-on of low-rating
-- feedback from multiple reviewers concentrated on a single
-- target.  Real users may give a 1-star to a real bad actor; the
-- signal needs to distinguish from coordinated reviewer-array
-- attacks where newly-created accounts coordinate to crater a
-- competitor's reputation.
--
-- Criteria (all must hold):
--   1. ≥3 distinct reviewers targeting the same subject
--   2. Each reviewer's rating(s) to that subject avg ≤2 (low)
--   3. All reviews posted within a 7-day window
--   4. All reviewer first_activity_at falls within a 14-day
--      window (newly-active cluster, vs varied real-user histories)
--   5. Each reviewer's distinct_subjects in their last 30 days of
--      activity is ≤2 (focused on this target, not diversified
--      across the marketplace)
--
-- Criterion 5 is the key false-positive guard.  A real user who
-- reviewed 5 different traders in the last month and gave one a
-- 1-star isn't a sock — distinct_subjects=5.  A sock whose only
-- Morphit feedback activity is leaving 1-star reviews on the
-- target has distinct_subjects=1.
--
-- Storage: one row per (subject, detected_at_window_id) pair,
-- with the list of attacking reviewers embedded as JSONB.  Unlike
-- Signal A/B which are pairwise, Signal C is N-to-1, so the
-- canonical-pair (a, b) shape doesn't apply — the subject is the
-- victim and there are 3+ attackers.
--
-- Effect on summary aggregates: the feedback API's summary CTE
-- (apps/indexer/src/api/feedback.ts) excludes rows where the
-- (reviewer, subject) pair appears in this table.  The list page
-- still returns these rows (so the subject can see what's being
-- alleged about them), just like Signal A/B treatment.

CREATE TABLE IF NOT EXISTS one_way_pile_on (
    id              BIGSERIAL PRIMARY KEY,
    subject         TEXT NOT NULL,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Window the pile-on was detected in: ISO date of the day
    -- the detector ran, so re-runs the same day don't insert
    -- duplicates for the same (subject, day).
    detection_date  DATE NOT NULL DEFAULT CURRENT_DATE,
    attacking_reviewers JSONB NOT NULL,
    avg_rating      NUMERIC(3, 2) NOT NULL,
    review_count    INTEGER NOT NULL,
    review_window_days INTEGER NOT NULL,
    activity_cluster_days INTEGER NOT NULL,
    -- Idempotency: the same subject can only be flagged once per
    -- detection day.  If the attackers grow over time, a new row
    -- appears the next day with the expanded set.
    UNIQUE (subject, detection_date)
);

CREATE INDEX IF NOT EXISTS one_way_pile_on_subject_idx
    ON one_way_pile_on (subject, detection_date DESC);

COMMENT ON TABLE one_way_pile_on IS
    'Signal C (Part 113): coordinated low-rating pile-on detection. '
    'Flags subjects who receive 3+ low-star reviews from reviewers '
    'with clustered first-activity timestamps and narrow review '
    'diversity.  Excluded from feedback summary aggregates the '
    'same way Signals A and B are.  Advisory not dispositive — '
    'flagged feedback still appears on the subject''s public '
    'profile list page (with the suppression chip surfaced via '
    'the API''s per-row `suppressed: true` flag, added Part 118), '
    'just doesn''t drive the numeric rating.';

-- ─────────────────────────────────────────────────────────────────
-- v32 / Part 121 — multi-network asset support (USDT)
-- ─────────────────────────────────────────────────────────────────
--
-- Adds `asset_network` column to `orders` for multi-network
-- tradable assets.  Originally USDT-only at Part 121 launch
-- (ERC-20/TRC-20/SPL/BEP-20); Part 122 cp30 added USDC as a
-- second multi-network asset (ERC-20/SPL/Base/Polygon); Part
-- 122 cp31 added DAI as a third (ERC-20/Polygon/Base/Arbitrum).
-- Single-network assets (BTC, XMR, BLURT, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP)
-- write NULL.
--
-- Pre-Part-121 rows stay NULL on this column.  Validate-time
-- gates in the order handler:
--   - asset='USDT' MUST have asset_network non-null and in
--     ('erc20', 'trc20', 'spl', 'bep20')
--   - asset='USDC' MUST have asset_network non-null and in
--     ('erc20', 'spl', 'base', 'polygon')   -- cp30 added
--   - asset='DAI' MUST have asset_network non-null and in
--     ('erc20', 'polygon', 'base', 'arbitrum')   -- cp31 added
--   - any other asset MUST have asset_network NULL
--
-- The combined constraint mirrors the registry rule:
-- `supportedNetworks` is a singleton for BTC/XMR/BLURT/BCH/LTC/
-- DASH/DOGE; a 4-element list for USDT (erc20/trc20/spl/bep20); a
-- 4-element list for USDC (erc20/spl/base/polygon); a 4-element
-- list for DAI (erc20/polygon/base/arbitrum).  The wire-format-
-- frozen `fee_method` enum stays at exactly
-- `'blurt'|'waived_first_buy'|'btc'|'xmr'` (memory #23) —
-- `asset_network` is a SEPARATE column from fee_method and never
-- conflates with it.
--
-- Index: per-network filtering on the orderbook query path
-- (`asset = 'USDT' AND asset_network = 'trc20'`, `asset =
-- 'USDC' AND asset_network = 'base'`, and `asset = 'DAI' AND
-- asset_network = 'arbitrum'` are all expected hot queries).
-- No standalone idx on asset_network because asset is always
-- specified before network in any query the frontend issues.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS asset_network TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_asset_asset_network
    ON orders (asset, asset_network)
    WHERE asset_network IS NOT NULL;

COMMENT ON COLUMN orders.asset_network IS
    'Part 121 / cp30 / cp31: sub-network identifier for multi-network '
    'assets (USDT, USDC, and DAI today).  For USDT: one of '
    '''erc20''/''trc20''/''spl''/''bep20''.  For USDC: one of '
    '''erc20''/''spl''/''base''/''polygon''.  For DAI: one of '
    '''erc20''/''polygon''/''base''/''arbitrum''.  NULL for every '
    'other asset.  Pinned at post time so cross-network sends '
    'are impossible — buyer sees the network on the order row '
    'before agreeing to trade.  Note that USDC ERC-20, Base, and '
    'Polygon addresses all share the EVM 0x[40-hex] format, and '
    'ALL FOUR DAI networks share that same format; this column '
    'is the only thing telling the sender which chain.';

-- ─────────────────────────────────────────────────────────────────
-- v33 / Part 122 cp13 — Web Push subscription storage + delivery queue
-- ─────────────────────────────────────────────────────────────────
--
-- Honors the FAQ entry `push_notifications_privacy` (user
-- chooses self-hosted / standard / off; payload E2E encrypted
-- per RFC 8291 by the web-push library; operator sees only
-- the subscription endpoint, never the message content).
--
-- Two tables:
--
--   push_subscriptions — one row per (account, endpoint) pair.
--     Endpoint is the URL the browser's push service issued to
--     the client when pushManager.subscribe() ran; the relay
--     POSTs encrypted payloads here to deliver pushes.  p256dh
--     and auth are the client's ephemeral keypair components
--     used by the web-push library to encrypt payloads (RFC 8291).
--
--     Privacy:
--       - Subscription endpoints expose which push service
--         (FCM = Google, autopush = Mozilla, web.push.apple.com
--         = Apple) the browser uses.  This is normal for Web
--         Push; the alternative is no push at all.
--       - No IP address is ever stored.
--       - Rows are deleted automatically when the push service
--         returns 410 Gone (subscription expired) or 404 Not
--         Found (subscription explicitly cancelled).
--       - User can unsubscribe explicitly via the UI, which
--         calls /v1/push/unsubscribe and removes the row.
--
--   push_pending — durable delivery queue.  When the indexer
--     detects a notify-worthy event (order filled, payment
--     marked, feedback arrived, chat message received) for an
--     account that has a live subscription, it INSERTs a row
--     here with the payload metadata.  The relay's push-sender
--     worker drains the queue, attempts delivery, and either
--     deletes (on success) or schedules a retry / deletes the
--     subscription (on terminal failure).
--
-- Naming follows the existing relay_pending_transfers pattern
-- (ADR-0011) since the relay owns the worker that drains both
-- queues from the indexer's database.

-- ─── v33.1: push_subscriptions ─────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
    -- Account the subscription belongs to.  References the chain
    -- posting-account name (e.g. 'alice') that proved ownership
    -- by signing the subscribe request with their posting key.
    account             TEXT        NOT NULL,

    -- Push service endpoint URL the browser issued at subscribe
    -- time.  Globally unique per browser/device/origin.  Used
    -- as the PRIMARY KEY's second column because one account
    -- may have multiple devices subscribed.
    endpoint            TEXT        NOT NULL,

    -- Browser-generated ephemeral P-256 public key for payload
    -- encryption (RFC 8291).  Base64url-encoded.
    p256dh              TEXT        NOT NULL,

    -- Browser-generated 16-byte client-shared secret used as the
    -- HKDF salt for payload encryption.  Base64url-encoded.
    auth                TEXT        NOT NULL,

    -- User-agent string sent at subscribe time, used for
    -- operator-side "which devices are subscribed to my account"
    -- in the Settings UI.  Truncated to 200 chars at insert
    -- time to bound row size.  Never used for tracking.
    user_agent          TEXT,

    -- The privacy mode the user chose at subscribe time.
    -- 'standard' = browser's default push service (FCM/autopush/
    -- APNS).  'self_hosted' = operator's own push server (the
    -- endpoint URL points at the operator's domain).  Recorded
    -- for the UI to show the user what mode each device is using.
    privacy_mode        TEXT        NOT NULL
        CHECK (privacy_mode IN ('standard', 'self_hosted')),

    -- When the subscription was created.  Used for the UI's
    -- "subscribed since" display and operator-side metrics
    -- ("how many subscriptions are over 90 days old / likely
    -- stale").  No IP, no fingerprinting data.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Updated on every push delivery attempt (success or failure)
    -- so operators can spot stale subscriptions before the push
    -- service returns 410.  NULL until first delivery attempt.
    last_delivery_at    TIMESTAMPTZ,

    -- Count of consecutive delivery failures.  Reset to 0 on any
    -- 2xx response from the push service.  When this exceeds
    -- MAX_CONSECUTIVE_FAILURES (default 5), the row is deleted
    -- on the next failure — the subscription is presumed dead
    -- even if the push service hasn't returned a 410 yet.
    consecutive_failures INTEGER    NOT NULL DEFAULT 0,

    -- Locale tag the user subscribed with (e.g. 'en', 'zh-CN').
    -- Used by the indexer to localize push payload title/body
    -- strings at enqueue time.  Defaults to 'en' for any
    -- subscription that didn't include a locale.  Part 122 cp14.
    locale              TEXT        NOT NULL DEFAULT 'en',

    -- Categories this device has OPTED OUT of (blocklist).  Empty
    -- '{}' means nothing muted = every category on, which is the
    -- pre-cp450 behaviour, so existing rows keep receiving all
    -- pushes until their client next re-syncs.  The push-sender
    -- skips a device whose array contains the pending row's
    -- category, so the per-category Settings toggle now governs
    -- Web Push (tab-closed) just as it already governed the
    -- in-page (tab-open) path.  cp450 GAP A (v40).
    muted_categories    TEXT[]      NOT NULL DEFAULT '{}',

    PRIMARY KEY (account, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_account_idx
    ON push_subscriptions (account);

-- Part 122 cp15 audit DD-12 — the feedback + chat handlers do
-- `WHERE account = $1 ORDER BY created_at DESC LIMIT 1` on every
-- enqueue.  The single-column account index makes WHERE fast but
-- forces a heap sort over matched rows.  A composite index with
-- DESC ordering serves the query plan in O(log n) end-to-end.
CREATE INDEX IF NOT EXISTS push_subscriptions_account_created_idx
    ON push_subscriptions (account, created_at DESC);

-- v33.1a — locale column added in Part 122 cp14 so the indexer
-- can localize push payload strings at enqueue time.  Idempotent
-- with the inline column in the CREATE TABLE above; ALTER stays
-- as a no-op on fresh cp15+ installs and runs on cp13→cp15
-- upgrades.
ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en';

COMMENT ON TABLE push_subscriptions IS
    'Part 122 cp13: Web Push subscription store.  Each row '
    'is one (account, browser device) pairing.  Operator can '
    'see WHICH push services accounts are subscribed via, but '
    'NEVER sees payload content (E2E encrypted by web-push '
    'library per RFC 8291) and NEVER stores subscriber IPs. '
    'Part 122 cp14 — `locale` column added so push titles/bodies '
    'are localized at enqueue time per the user''s most-recent '
    'subscribe locale.';

-- ─── v33.2: push_pending — delivery queue ──────────────────────
CREATE TABLE IF NOT EXISTS push_pending (
    -- Surrogate key so the worker can claim rows atomically with
    -- SELECT ... FOR UPDATE SKIP LOCKED.
    id                  BIGSERIAL   PRIMARY KEY,

    -- Account the push targets.  Worker joins to
    -- push_subscriptions on account to find all the user's
    -- devices.
    account             TEXT        NOT NULL,

    -- Notification category — order / chat / feedback.  Matches
    -- the per-category preferences toggle in the UI; the worker
    -- skips devices whose user opted-out of this category at
    -- subscribe time (the client filters before subscribing, but
    -- we re-check here for defence-in-depth).
    category            TEXT        NOT NULL
        CHECK (category IN ('order', 'chat', 'feedback')),

    -- The notification title shown to the user (the bold line
    -- of the OS notification).  Already localized at insert
    -- time by the indexer; the worker emits it as-is.
    title               TEXT        NOT NULL,

    -- The notification body (the second line of the OS
    -- notification).  May be the empty string for title-only
    -- pushes.  Already localized.
    body                TEXT        NOT NULL,

    -- An opaque URL the click handler should open when the user
    -- taps the notification.  Always relative to the instance
    -- origin (e.g. '/order/alice/buy-btc-eur-1234'); the SW
    -- prepends location.origin.
    click_path          TEXT,

    -- When the source event occurred (NOT when this row was
    -- created).  Used by the worker to drop pushes for events
    -- older than MAX_PUSH_AGE (default: 1 hour) — pushing a
    -- "your order filled" message 6 hours after the fact is
    -- worse than not pushing at all.
    event_at            TIMESTAMPTZ NOT NULL,

    -- When this row was inserted by the indexer.  Used for
    -- ordering by FIFO + age-based draining.
    enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Optional shared dedup tag matching the client's in-page
    -- notificationTag (e.g. 'morphit-trade-<permlink>').  When set,
    -- the sender emits it as the push payload's eventId, so the
    -- service worker's tag `morphit-<category>-<eventId>` is
    -- byte-identical to the in-page notification's tag and the
    -- browser collapses the two into one.  NULL for pushes with no
    -- in-page counterpart (plain chat / feedback / featured-bid) —
    -- the sender then tags on the queue-row id.  cp450.
    notification_id     TEXT
);

CREATE INDEX IF NOT EXISTS push_pending_enqueued_at_idx
    ON push_pending (enqueued_at);

CREATE INDEX IF NOT EXISTS push_pending_account_idx
    ON push_pending (account);

COMMENT ON TABLE push_pending IS
    'Part 122 cp13: durable Web Push delivery queue.  Mirrors '
    'the relay_pending_transfers pattern (ADR-0011) — indexer '
    'enqueues, relay worker drains.  Drops events older than '
    'MAX_PUSH_AGE (~1h) instead of pushing stale notifications. '
    'cp15: per-row retry was originally planned via an `attempts` '
    'column but removed — the worker deletes pending rows after '
    'fan-out (no per-event retry) and instead handles transient '
    'failures at the SUBSCRIPTION level via '
    'push_subscriptions.consecutive_failures.';

-- v33.2a — drop the dead `attempts` column from cp13.  Idempotent
-- so cp15+ fresh installs (where the column was never created)
-- and cp13→cp15 upgrades (where it WAS) both succeed.
ALTER TABLE push_pending DROP COLUMN IF EXISTS attempts;

-- ─── v34: review_concentration (cp123 H2, Signal D) ───────────
-- Closes Part 113 A4 "Signal B evasion via diversification".
-- Signal B requires distinct_subjects=1 (only reviewed the target).
-- A smart attacker reviews 2-3 throwaway third parties to evade.
-- Signal D catches the diversifying attacker:
--
--   (reviewer, dominant_subject) is flagged when ≥80% of the
--   reviewer's recent feedback rows go to the same subject AND
--   the reviewer has posted ≥5 reviews in the window AND the
--   subject is also a high-star recipient from this reviewer
--   AND the pair is mutually reviewing (subject reviews reviewer
--   back with similar high concentration).
--
-- The (reviewer, dominant_subject) pair is the unit of flagging.
-- The aggregate-exclusion logic in feedback.ts/orderbook.ts/
-- orderbookStream.ts joins on this to drop those rows from the
-- weighted_rating computation.
--
-- ON CONFLICT DO NOTHING semantics — once flagged, the pair stays
-- flagged.  False-positive recovery is operator-side (DELETE row).
CREATE TABLE IF NOT EXISTS review_concentration (
    reviewer         TEXT NOT NULL,
    dominant_subject TEXT NOT NULL,
    detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    concentration_pct NUMERIC(5, 2) NOT NULL CHECK (concentration_pct >= 0 AND concentration_pct <= 100),
    review_count     INTEGER NOT NULL CHECK (review_count >= 0),
    window_days      INTEGER NOT NULL,
    PRIMARY KEY (reviewer, dominant_subject)
);
CREATE INDEX IF NOT EXISTS review_concentration_subject_idx
    ON review_concentration (dominant_subject);

-- ─── v35: price_drift_baseline (cp127, defense B) ──────────────
-- Persisted 7-day moving baseline per (asset, denominationFiat)
-- pair.  Used by the drift monitor (apps/indexer/src/indexer/price/
-- driftMonitor.ts) to detect slow-drift attacks where each refresh-
-- cycle move is within the per-cycle smoothing cap but the
-- cumulative drift is large.
--
-- The baseline is updated on every successful price commit via an
-- exponential time-decay average (24h half-life by default).
-- `above_threshold_since` tracks when the current price first
-- entered the "diverged" band; sustained divergence beyond
-- DRIFT_ALERT_SUSTAINED_HOURS (24h) fires an alert.
--
-- Defense #7 (restart-bypass): persistence here means an indexer
-- restart doesn't reset the baseline, so an attacker can't time
-- manipulation to restarts.
--
-- B does NOT auto-correct the price — auto-correction is itself an
-- attack vector (an attacker games the baseline to force a
-- "correction" toward their target); B only makes the drift loudly
-- visible (logs + /v1/health) for operator response.  Wired in cp233.
--
-- One row per pair; the table never grows large (~10s of rows at
-- most, one per asset Morphit tracks).
CREATE TABLE IF NOT EXISTS price_drift_baseline (
    asset                  TEXT NOT NULL,
    denomination_fiat      TEXT NOT NULL,
    baseline_price         NUMERIC(38, 18) NOT NULL CHECK (baseline_price > 0),
    baseline_updated_at    TIMESTAMPTZ NOT NULL,
    above_threshold_since  TIMESTAMPTZ,
    PRIMARY KEY (asset, denomination_fiat)
);

-- ───────────────────────────────────────────────────────────────────
-- cp129 — Defense F: cross-instance peer price observations
-- ───────────────────────────────────────────────────────────────────
--
-- ADR-0041 cross-instance peer disagreement detector.
--
-- Periodically (default every 30 minutes), the indexer queries
-- each federation peer's `/v1/price/morphit-native/receipt`
-- endpoint and records what they reported.  Then it computes the
-- median across all peers in the recent window and compares
-- with its own derived price.  Sustained disagreement >25% for
-- >4 hours fires an alert in the indexer logs and surfaces on
-- /v1/health.
--
-- Why this defense matters: cp127 designed the morphit_native
-- fetcher with several manipulation defenses (sybil filtering,
-- per-trader caps, tier hierarchy).  Defense F (cp127's deferred
-- item) catches the case where an operator's *own* indexer is
-- compromised or geographically isolated and is reporting a
-- different price than the rest of the federation.  Peers in
-- aggregate provide a sanity check that no single indexer can
-- fake.
--
-- Sybil resistance for PEERS (not traders):
--   - Only `known_instances` with last_probe_status = 'good' OR
--     'quiet' are queried (the federation prober already vetted
--     them).
--   - Require ≥3 peers to fire an alert (configurable).
--   - Use MEDIAN, not mean — one outlier can't shift the result.
--
-- Different-denomination peers are excluded from the comparison
-- (we can't compare EUR-denominated peer's BLURT price to our
-- USD-denominated BLURT price without a USD/EUR oracle, which
-- would defeat the self-sovereign premise).
--
-- TTL: observations older than 7 days are cleaned up periodically.
-- Keeps the table bounded (~ peers × 1 row per 30 min × 7 days
-- ≈ a few thousand rows in steady state).
CREATE TABLE IF NOT EXISTS price_peer_observations (
    peer_origin            TEXT NOT NULL,
    asset                  TEXT NOT NULL,
    denomination_fiat      TEXT NOT NULL,
    observed_price         NUMERIC(38, 18) NOT NULL CHECK (observed_price > 0),
    observed_at            TIMESTAMPTZ NOT NULL,
    -- 'morphit_native' if peer's receipt said the price came
    -- from their morphit_native fetcher, or 'unknown' if their
    -- receipt didn't include a source tag (older peers, etc.).
    -- We only use 'morphit_native' observations for the peer
    -- median; that's the cleanest cross-instance comparison
    -- (apples to apples — both sides derived from on-platform
    -- trade data, not from external sources both of us pulled
    -- from anyway).
    source_native          TEXT NOT NULL DEFAULT 'unknown'
);

-- Median queries scan recent observations for a given (asset,
-- denomination_fiat) pair within a time window — this index
-- makes that fast.
CREATE INDEX IF NOT EXISTS price_peer_observations_by_pair_recent
ON price_peer_observations (asset, denomination_fiat, observed_at DESC);

-- Cleanup: a periodic job DELETEs WHERE observed_at < now() - 7 days.
-- Index supports the bounded scan.

-- ─── v36: accounts.posting_pubkey (cp404) ─────────────────────
-- Morphit indexer — migration v36.
--
-- Stores each account's PRIMARY posting public key (base58 "BLT…"
-- string) so order cards can show the truncated "(BLT5vw…7Bjw)"
-- identity anchor WITHOUT the frontend resolving it per-card from
-- the chain (which for a whole orderbook list would be N lookups —
-- against the tiny-footprint priority). This is DISPLAY-ONLY data;
-- signature verification still resolves keys live from the chain
-- authority (apps/indexer/src/blurt/verify.ts) and never trusts
-- this column.
--
-- Population is two-pronged (see dispatcher.ts + the startup
-- backfill in main.ts / postingKeyBackfill.ts):
--   1. On account_create ingest, the primary posting key is read
--      straight from the op's posting authority.
--   2. A bounded startup backfill fetches the key from the chain
--      (condenser_api.get_accounts) for any account still NULL —
--      covering accounts created before this migration. Keys that
--      rotate later are refreshed by the same backfill on the next
--      restart. NULL simply means "not captured yet"; the card
--      omits the posting-key line for that trader until it fills.
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS posting_pubkey TEXT;
-- ─── v37: orders.accepted_assets (cp425 barter accepted-crypto set) ───
-- A BARTER (goods/services) listing settles in one of a SET of cryptos
-- the seller accepts.  This column pins that set on the order row so
-- the orderbook can (a) show buyers which cryptos they can pay in and
-- (b) refuse a buyer's chosen crypto that isn't on the list.  NULL for
-- every crypto asset (they settle in themselves); non-empty for BARTER.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS accepted_assets TEXT[];

-- GIN index for "barter orders that accept <crypto>" containment
-- queries (accepted_assets @> ARRAY['XMR']).  Partial: only barter
-- rows have a non-null set, so the index stays tiny.
CREATE INDEX IF NOT EXISTS idx_orders_accepted_assets
    ON orders USING GIN (accepted_assets)
    WHERE accepted_assets IS NOT NULL;

COMMENT ON COLUMN orders.accepted_assets IS
    'cp425: for a BARTER (goods/services) order, the non-empty set of '
    'crypto tickers the seller accepts as settlement (e.g. '
    '{XMR,BTC,DOGE}).  Each is a real crypto ticker in ASSET_TICKERS '
    '(never BARTER itself, never a goods asset).  A buyer may only '
    'settle in a crypto on this list.  NULL for every crypto asset — '
    'those settle in themselves and have no accepted-set.';
-- ─── v38: index accounts.posting_pubkey (cp440 key-references reverse lookup) ───
-- v36 added the column but no index — it was only ever SELECTed by account
-- name (the PK).  cp440's /v1/chain/key-references union does a REVERSE lookup
-- (SELECT name WHERE posting_pubkey = ANY(...)) on every posting-key login to
-- auto-resolve pre-fork accounts the chain's account_by_key plugin misses.
-- Without this index that seq-scans the accounts table.  Partial (NOT NULL):
-- un-backfilled rows are never a lookup target, and the backfill's own
-- `WHERE posting_pubkey IS NULL` scan wants them excluded here anyway.
CREATE INDEX IF NOT EXISTS idx_accounts_posting_pubkey
    ON accounts (posting_pubkey)
    WHERE posting_pubkey IS NOT NULL;

-- ─── v39: chat read-state is per DISCUSSION, not per peer (cp446) ───
-- Ken: "if I read one thread from a user, it should not mark other threads
-- with that user as read. Think of it like email."
--
-- The key column is never NULL: it is part of the primary key, and Postgres
-- treats NULLs as DISTINCT in a unique index, so two NULL rows for the same
-- (reader, peer) would both insert and the ON CONFLICT upsert would never fire.
--
--   '*'  legacy PEER-WIDE ack — what every pre-cp446 client sent, and what an
--        old client still sends. Existing rows are peer-wide by definition, so
--        the DEFAULT backfills them correctly and nothing looks unread on
--        upgrade day.
--   ''   the thread that cites no order — a real discussion of its own.
--   else the permlink of the order the discussion is about.
--
-- Neither '*' nor '' is a legal Blurt permlink, so no thread collides with a
-- sentinel. Unread is evaluated against MAX(thread ack, peer-wide ack).
--
-- DOWNGRADE HAZARD: an indexer older than cp446 upserts with
-- `ON CONFLICT (reader_account, peer_account)`, and that constraint no longer
-- exists. Rolling the indexer back after this migration breaks chat read acks
-- until it is rolled forward again. Nothing else is affected.
ALTER TABLE chat_read_state
    ADD COLUMN IF NOT EXISTS order_permlink TEXT NOT NULL DEFAULT '*';

ALTER TABLE chat_read_state
    DROP CONSTRAINT IF EXISTS chat_read_state_pkey;

ALTER TABLE chat_read_state
    ADD PRIMARY KEY (reader_account, peer_account, order_permlink);

COMMENT ON COLUMN chat_read_state.order_permlink IS
    'The discussion this ack is for: a permlink, or '''' for the order-less thread, or ''*'' for a legacy peer-wide ack.';

-- ─── v40: push_subscriptions.muted_categories (cp450 GAP A) ───
-- The per-category Settings toggle governed the in-page (tab-open)
-- notification path but was silently ignored by Web Push (tab-closed):
-- the push-sender fanned every chat / order / feedback push out to
-- every subscribed device regardless of the account's toggles. This
-- gives each device the state the sender was missing.
--
-- BLOCKLIST, not allowlist: the array names the categories the user
-- turned OFF. Empty '{}' = nothing muted = all on = the pre-cp450
-- behaviour, so every existing subscription keeps receiving everything
-- until its client next re-syncs (no surprise silence on upgrade). It
-- is also future-proof — a new category is on by default until muted,
-- with no further migration. The push-sender skips a device whose
-- muted_categories contains the pending row's category.
--
-- Idempotent with the inline column in the push_subscriptions CREATE
-- TABLE above and with the v40 migration in migrations.ts.
ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS muted_categories TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN push_subscriptions.muted_categories IS
    'Categories this device has OPTED OUT of (blocklist). Empty = all on. The push-sender skips a device whose array contains the notification''s category.';

-- ─── v41: push_pending.notification_id (cp450 dedup tag) ───
-- An order-signal chat message fired TWO notifications for the
-- recipient with an open-but-unfocused tab: the in-page trade listener
-- and the category='order' Web Push each showed one, with different
-- tags, so the browser didn't collapse them. This column carries the
-- SAME tag id the in-page path uses ('morphit-trade-<permlink>'); the
-- sender emits it as the push eventId, making the SW tag
-- `morphit-order-morphit-trade-<permlink>` identical to the in-page
-- one → the browser shows a single notification. NULL for pushes with
-- no in-page counterpart (the sender falls back to the queue-row id).
-- Idempotent with the inline column in the push_pending CREATE TABLE
-- above and with the v41 migration in migrations.ts.
ALTER TABLE push_pending
    ADD COLUMN IF NOT EXISTS notification_id TEXT;

COMMENT ON COLUMN push_pending.notification_id IS
    'Optional shared dedup tag matching the in-page notificationTag (e.g. ''morphit-trade-<permlink>''). NULL → the sender tags on the queue-row id.';

-- ─── v42: chat_folders (encrypted chat folder organization) ───
-- t.txt (v1.4.9 #5). Per-account ENCRYPTED chat folder state: which threads
-- the user keeps in Inbox / Starred (everything else is Archived by default),
-- synced across devices. The client encrypts the thread lists with a
-- posting-key-derived key, so the indexer stores + serves OPAQUE ciphertext and
-- never learns a user's chat organization. Written ONLY by the
-- morphit_chat_folders_v1 handler; latest broadcast (by block) wins.
-- Idempotent with the v42 migration in migrations.ts.
CREATE TABLE IF NOT EXISTS chat_folders (
    account TEXT PRIMARY KEY,
    enc TEXT NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE chat_folders IS
    'Per-account ENCRYPTED chat folder organization (which threads are kept in Inbox/Starred; all others Archived). Opaque ciphertext — encrypted client-side with a posting-key-derived key, so the indexer never learns a user''s chat organization. Written only by morphit_chat_folders_v1; latest by block wins.';
