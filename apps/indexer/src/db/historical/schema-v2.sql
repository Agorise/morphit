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
