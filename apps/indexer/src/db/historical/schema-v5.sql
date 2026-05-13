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
