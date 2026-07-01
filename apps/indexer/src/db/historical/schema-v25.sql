-- Migration 25 — chat_messages.order_permlink
--
-- Adds an optional plaintext `order_permlink` column to
-- chat_messages so that engagement counts per order can be
-- computed without a full ciphertext scan.  The on-wire
-- field was added in Q11 (apps/indexer/src/indexer/handlers/
-- chat.ts) for the stranger-fee bypass; this migration just
-- makes that field durable in the DB so the orderbook can
-- show "N people are messaging this seller about this order"
-- without re-scanning chain history every time.
--
-- Privacy note: the field is plaintext on chain (Q11 design)
-- so persisting it does NOT expose data the chain doesn't
-- already expose.  Anyone scraping Blurt can already derive
-- "user A messaged user B about order X" by parsing the
-- chat ops.  The indexer is one of many such observers.
--
-- Nullable on purpose: pre-Q11 messages and ANY first-DM
-- (non-order chat) messages legitimately have no order
-- attribution.  Storing NULL is correct and not a "missing
-- data" concern.
--
-- Index strategy: hot path is "count distinct senders for
-- this order in last 24h" (orderbook engagement signal).
-- A partial index `WHERE order_permlink IS NOT NULL` keeps
-- the index small (only the subset of messages that name
-- an order) while serving the count query.  Lookup uses
-- (order_permlink, created_at) so a 24h-windowed
-- COUNT(DISTINCT sender) is fast.
--
-- Backfill: not done.  The field is forward-only; pre-v25
-- messages stay NULL and are excluded from engagement
-- counts.  This is fine because engagement is a "right
-- now" signal — anything more than 24h old wouldn't be
-- counted regardless.

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS order_permlink TEXT;

CREATE INDEX IF NOT EXISTS chat_messages_order_engagement_idx
    ON chat_messages (order_permlink, created_at DESC, sender)
    WHERE order_permlink IS NOT NULL;

COMMENT ON COLUMN chat_messages.order_permlink IS
    'Optional plaintext order permlink the message was sent in response to (Q11 stranger-fee bypass + orderbook engagement counter). NULL for non-order DMs and pre-Q11 messages.';
