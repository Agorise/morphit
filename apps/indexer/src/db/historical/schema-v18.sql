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
