-- Morphit indexer — migration v13.
--
-- chat_identities table for morphit_chat_v1 ECIES crypto per
-- ADR-0015. Each account publishes its 32-byte X25519 public
-- chat key via morphit_chat_identity_v1; this table records
-- the latest publication per account.
--
-- Retention: latest-only. Key rotation overwrites the row in
-- place. The full event log retains history if ever needed.
--
-- Access pattern: single-row lookup by account, used when a
-- sender's client needs to encrypt a new message. Web clients
-- will typically hit this endpoint once per conversation (the
-- key doesn't change mid-conversation barring explicit rotation)
-- so lookup volume is low.
--
-- Storage: BYTEA for chat_pub — 32 raw bytes rather than base64'd
-- text. The endpoint converts to base64 for the JSON response.
-- This saves ~50% disk for the bulk of the table and avoids
-- round-tripping on every read.
--
-- Size bound: one row per active chatting account. 100k accounts
-- × ~80 bytes/row ≈ 8 MB. Trivial.

CREATE TABLE IF NOT EXISTS chat_identities (
    account TEXT PRIMARY KEY,
    chat_pub BYTEA NOT NULL CHECK (octet_length(chat_pub) = 32),
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE chat_identities IS
    'Published X25519 chat public key per account (ADR-0015).';
COMMENT ON COLUMN chat_identities.chat_pub IS
    '32-byte X25519 public key. Raw bytes, not base64.';
