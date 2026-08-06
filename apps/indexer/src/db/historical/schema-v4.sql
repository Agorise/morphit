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
