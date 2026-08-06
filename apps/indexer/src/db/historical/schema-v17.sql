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
