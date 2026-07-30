-- Morphit indexer — migration v3.
--
-- Adds the accounts table per ADR-0009 §5, needed to support
-- Signal A (related-accounts detection). We record one row per
-- Blurt account whose `account_create`-family op we observe while
-- indexing. Accounts that predate our startBlock never get a row,
-- which means they're never candidates for Signal A — acceptable,
-- since the signal is about *new* accounts sharing a creator.
--
-- `first_activity_at` is populated lazily: initially NULL when we
-- record the creation op, then set the first time we see a morphit
-- op (profile, order, feedback, etc.) from this account. This
-- two-phase population lets the detector find pairs whose
-- creation timing AND first-Morphit-activity timing are both
-- close.

CREATE TABLE accounts (
    name                TEXT PRIMARY KEY,
    creator             TEXT NOT NULL,
    -- Block metadata for the account_create op that introduced
    -- this account. Used to find accounts created in close
    -- temporal proximity by the same creator.
    created_block_num   BIGINT NOT NULL,
    created_block_time  TIMESTAMPTZ NOT NULL,
    created_trx_id      TEXT NOT NULL,
    -- First observed morphit-op time for this account. NULL
    -- until we see such an op. Indexed for Signal A's
    -- temporal-proximity query.
    first_activity_at   TIMESTAMPTZ
);

-- Creator-grouped queries are the Signal A hot path.
CREATE INDEX accounts_creator_idx ON accounts (creator, created_block_time);

-- For looking up an account's creator when it posts an order.
-- (The primary-key lookup already covers this, but keeping the
-- pattern explicit.)

-- For Signal A's temporal-proximity predicate on first activity.
CREATE INDEX accounts_first_activity_idx
    ON accounts (first_activity_at)
    WHERE first_activity_at IS NOT NULL;
