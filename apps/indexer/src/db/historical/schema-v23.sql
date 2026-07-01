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
