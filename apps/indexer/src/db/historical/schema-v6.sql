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
