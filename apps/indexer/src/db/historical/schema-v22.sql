-- Phase G prep / task #14 — private viewcounts on trade offers.
--
-- Single-counter-per-order table.  When an unsigned-in or
-- signed-in user lands on an order detail page, the frontend
-- POSTs to /v1/orders/:permlink/view and we increment count.
-- The owner of the order can then see "your offer was viewed
-- N times" — that's it.
--
-- PRIVACY DESIGN NOTES (DO NOT REGRESS):
--
--   - No IP column.  We deliberately don't track who's viewing.
--     Even the owner doesn't get IPs; they only get the count.
--   - No timestamps per view.  A timestamps column would let
--     someone with read access correlate view times against
--     external events (an order viewed exactly when a tweet
--     went out → social-graph leak).  We keep just the
--     aggregate.
--   - No per-viewer-account row.  Same rationale — knowing
--     "alice viewed your offer" defeats the purpose.
--   - Non-unique counts (same person reloading bumps the
--     counter).  This makes the metric weakly informative
--     rather than precise — which is the point.  Owners get a
--     rough signal of "is this generating interest" without
--     the metric being so detailed it becomes a surveillance
--     vector.
--   - Spam / abuse mitigation is at the reverse-proxy layer
--     (nginx limit_req zone), NOT at this layer.  If the
--     indexer were to track "X views from same IP in Y
--     seconds" it would have to log IPs, which would defeat
--     the whole privacy model.
--
-- The "owner only" gate is enforced by the GET endpoint, not
-- the table — the table is readable by the indexer process,
-- of course; the gating happens in api/orderViews.ts where the
-- request must carry a signature proving Auth as the order's
-- author.

CREATE TABLE order_views (
    permlink   text     PRIMARY KEY,
    count      bigint   NOT NULL DEFAULT 0,
    -- updated_at is here for ops debugging only (let an
    -- operator see "was this row touched in the last hour"
    -- when investigating) but it's the row's last-update
    -- time, NOT a list of when individual views occurred.
    -- Strictly aggregate.
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The increment query (`UPDATE order_views SET count = count + 1`)
-- is the hot path.  Primary-key lookup by permlink already
-- gives us O(log n) — no additional index needed.
