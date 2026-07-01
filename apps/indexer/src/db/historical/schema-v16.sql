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

    -- What the client quoted as the USD equivalent at op time.
    -- The indexer doesn't re-verify this (it just records what
    -- the client claimed); the price-feed check happens in the
    -- handler, which validates amount_blurt against the live
    -- price with a tolerance window.
    amount_usd_equivalent     NUMERIC(10,4) NOT NULL,

    PRIMARY KEY (sender, recipient),

    -- Self-payment is nonsense and the handler rejects it, but
    -- a CHECK here is a cheap second line of defense.
    CHECK (sender <> recipient),

    -- Paid amounts should be positive. Bounds are generous —
    -- we don't want to reject a user who over-paid the fee
    -- (their choice); we just want to reject pathological
    -- values (zero, negative, overflow).
    CHECK (amount_blurt > 0),
    CHECK (amount_usd_equivalent > 0)
);

-- Reverse-index for "what pairs has this sender paid for?"
-- Supports a future UX where a user can see a list of accounts
-- they've paid to message. PK prefix gives us free lookup on
-- `WHERE sender = $X AND recipient = $Y`; this index adds
-- fast `WHERE sender = $X` scans.
CREATE INDEX IF NOT EXISTS stranger_fees_sender_idx
    ON stranger_fees (sender, paid_at DESC);
