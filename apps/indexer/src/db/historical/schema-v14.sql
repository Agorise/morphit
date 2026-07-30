-- Morphit indexer — migration v14.
--
-- chat_read_state table for on-chain chat read receipts (Phase B
-- of the inbox design — see docs/REVISIT-LIST.md §D and the
-- accompanying design in docs/CHAT-READ-RECEIPTS-DESIGN.md).
--
-- Each row records that `reader_account` has acknowledged reading
-- their conversation with `peer_account` up through `last_read_at`.
-- Any message in the chat_messages table with created_at <=
-- last_read_at is "read" from reader_account's perspective.
--
-- Acks arrive via the morphit_chat_read_v1 custom_json op (new
-- handler). The handler writes or updates the row for the
-- (reader, peer) pair, with a monotonic guard: a later ack with
-- an earlier timestamp than the current last_read_at is rejected
-- (out-of-order / replay defense). This keeps read state strictly
-- advancing.
--
-- Retention: latest-only per (reader, peer). Full history is
-- recoverable from on-chain ops if ever needed; this table is
-- a derived read-state cache for fast API queries.
--
-- Access patterns:
--   1. "Give me all my read state" — bulk fetch by reader_account.
--      Used by the /chat inbox to compute unread counts per peer.
--      Index: chat_read_state(reader_account) implicit in PK.
--   2. Point lookup for (reader, peer) — used by the /chat/[peer]
--      view to confirm whether a specific conversation is fully
--      read. PK lookup.
--
-- Size: one row per (reader, peer) pair ever ack'd. For 100k
-- accounts × ~50 chat partners each × 100 bytes/row ≈ 500 MB.
-- Reasonable. Can be pruned later if needed (remove rows where
-- peer hasn't sent a message in > N days).

CREATE TABLE IF NOT EXISTS chat_read_state (
    reader_account TEXT NOT NULL,
    peer_account TEXT NOT NULL,
    last_read_at TIMESTAMPTZ NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (reader_account, peer_account),
    CHECK (reader_account <> peer_account)
);

COMMENT ON TABLE chat_read_state IS
    'Per-(reader, peer) chat read-ack state (Phase B inbox read receipts).';
COMMENT ON COLUMN chat_read_state.last_read_at IS
    'Timestamp through which reader has acknowledged reading peer''s messages. Strictly advances — later acks with earlier timestamps are rejected at handler intake.';
COMMENT ON COLUMN chat_read_state.source_trx_id IS
    'trx_id of the morphit_chat_read_v1 op that wrote this row. For forensic trace.';

-- No secondary index needed — PK covers both bulk-fetch by reader
-- (prefix of composite PK) and point lookup by (reader, peer).
