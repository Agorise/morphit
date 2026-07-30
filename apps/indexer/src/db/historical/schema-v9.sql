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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Order-permlink foreign key is intentionally NOT declared here —
-- at MVP we want bids against orders that have since been
-- cancelled or expired to remain in the audit table (for
-- refund-tracking and anti-abuse analysis). The query-time
-- predicate "AND order is still live" handles visibility.

CREATE INDEX ix_featured_bids_active
    ON featured_slot_bids (blurt_per_hour DESC, block_time_at ASC)
    WHERE cancelled = FALSE;

CREATE INDEX ix_featured_bids_bidder
    ON featured_slot_bids (bidder, block_time_at DESC);

CREATE INDEX ix_featured_bids_order
    ON featured_slot_bids (order_permlink, expires_at DESC);

-- Query pattern: "what are the top 5 currently featured
-- orders?" — covered by ix_featured_bids_active with an
-- additional WHERE on expires_at > NOW() and a JOIN to
-- orders for liveness. Not materialized in its own table:
-- the predicate "expires_at > NOW()" changes every second,
-- so a materialized cache would thrash.
