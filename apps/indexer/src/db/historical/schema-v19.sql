-- Morphit indexer — migration v19.
--
-- Finding N23 follow-up (signup/welcome-bonus audit): defend
-- against the rare double-broadcast window in the relay
-- queue drainer.
--
-- Scenario: drainer broadcasts a transfer to chain
-- (succeeds), then the post-success "UPDATE broadcast_at"
-- query fails for some transient PG reason — the savepoint
-- around the row rolls back, and the next drain cycle picks
-- up the same row and broadcasts again.  Result: bonus
-- recipient gets paid twice; relay's BLURT balance drains
-- twice.
--
-- Defense: a `broadcast_attempt_at` timestamp written BEFORE
-- the chain broadcast.  If the row has broadcast_attempt_at
-- set but broadcast_at NULL, that's evidence we already
-- attempted; the next drain cycle skips it for a 10-minute
-- cool-off so transient failures clear, with longer-stuck
-- rows surfacing in operator dashboards for manual review.
--
-- Backwards-compatibility: nullable column.  Existing rows
-- have NULL, which the drainer's selectPending query treats
-- as "never attempted, eligible for first try."

ALTER TABLE relay_pending_transfers
    ADD COLUMN broadcast_attempt_at TIMESTAMPTZ;

COMMENT ON COLUMN relay_pending_transfers.broadcast_attempt_at IS
'Set by the relay drainer immediately before issuing the chain broadcast for this row. If non-NULL but broadcast_at is NULL, the row is in a "we tried, outcome unknown" state — the drainer holds off auto-retry for 10 minutes so transient failures recover and stuck rows surface for operator review. Closes a residual double-broadcast window from Finding N23.';
