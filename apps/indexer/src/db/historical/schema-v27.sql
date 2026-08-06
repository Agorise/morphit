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
-- Two append-only audit tables ensure the pipeline is
-- end-to-end auditable: every attribution lands a row in
-- operator_attribution_events; every payout enqueue lands a
-- row in operator_payouts referencing the relay row.

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

-- ─── 2. operator_payouts ───────────────────────────────────────
-- Append-only: one row per relay-transfer enqueue.  In the
-- immediate-payout model, this is 1:1 with attribution events
-- where operator_share_blurt > 0 (sub-precision events that
-- floor to zero don't queue a transfer — see operatorEarnings.ts).
--
-- Each row references the relay_pending_transfers row that
-- carries the actual broadcast.  The relay drainer fills in
-- broadcast_at / broadcast_trx_id on the relay row; this table
-- is purely the audit trail of payout intent.
--
-- The reference to operator_attribution_events lets us join
-- "which attribution caused this payout" cheaply.
CREATE TABLE IF NOT EXISTS operator_payouts (
    id                       BIGSERIAL PRIMARY KEY,
    operator_account         TEXT NOT NULL
        REFERENCES operators(account) ON DELETE CASCADE,
    attribution_event_id     BIGINT NOT NULL
        REFERENCES operator_attribution_events(id) ON DELETE CASCADE,
    amount_blurt             NUMERIC NOT NULL CHECK (amount_blurt > 0),
    relay_pending_transfer_id BIGINT NOT NULL
        REFERENCES relay_pending_transfers(id) ON DELETE RESTRICT,
    queued_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (attribution_event_id)
);

CREATE INDEX IF NOT EXISTS operator_payouts_operator_idx
    ON operator_payouts (operator_account, queued_at DESC);

-- ─── 3. operator_earnings: add lifetime_paid_blurt ──────────────
-- In the immediate-payout model, cumulative_blurt_earned (from
-- v7) tracks lifetime credit. lifetime_paid_blurt is the
-- mirror: lifetime BLURT actually queued for transfer.
-- They're equal in the current model but separated to allow
-- future model divergence (e.g., if a partial-payout scheme
-- is introduced where credits accumulate before queuing).
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
