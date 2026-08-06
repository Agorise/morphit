-- Morphit indexer — migration v11.
--
-- Phase 5 — syndication (ADR Q3 ratified: Option A, user-signed).
--
-- Adds two columns to `orders`:
--   syndicate_opt_in: set TRUE at order-creation time when the user
--     checks the "Syndicate my order" box on the post form. The
--     order handler will consume this from the op payload's optional
--     `syndicate` field (order handler modification is a separate
--     migration-adjacent code change shipping after this schema).
--   syndicated_trx_id: the Blurt trx_id of the announcement post
--     once it's published. Null until then. Prevents duplicate
--     announcements if the user opens the "pending announcement"
--     banner twice.
--
-- Both columns are nullable-or-defaulted-safe for existing rows:
--   - syndicate_opt_in defaults to FALSE (existing orders opted
--     out implicitly since the checkbox didn't exist when they
--     were created)
--   - syndicated_trx_id is nullable; null is the correct value
--     for any order that hasn't been announced yet
--
-- IF NOT EXISTS is used for defensive replay — the migration
-- tracker already prevents double-application, but belt-and-
-- suspender in case of manual intervention.
--
-- Why these belong on `orders` rather than a separate table:
--   - The 1:1 relationship with orders (each order is syndicated
--     once or not at all) makes a separate table pure overhead.
--   - Queries filtering for "orders awaiting syndication" are
--     simple WHERE clauses, no JOIN needed.
--   - Schema stability: these are the only two syndication-related
--     columns the order row needs. No further growth expected.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS syndicate_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS syndicated_trx_id VARCHAR(64);

-- No index needed. The only predicate-level read pattern is
-- "find orders where I opted in but haven't published yet" and
-- that's scoped to a specific account via existing orders_account
-- index, not a global scan.
