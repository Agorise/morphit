-- Morphit indexer — schema v1
-- Applied by src/db/migrations.ts on first boot.
-- See docs/PHASE-3b-DESIGN.md for the design rationale.

-- ─── Schema version tracking ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT NOT NULL
);

-- ─── Indexer progress tracking ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS indexer_state (
    id INT PRIMARY KEY CHECK (id = 1),
    last_applied_block BIGINT NOT NULL,
    last_applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    chain_id TEXT NOT NULL
);

-- ─── Event log: every morphit op we've seen ─────────────────────────
-- Append-only. Never updated, never deleted. Audit surface + basis
-- for materialized-view rebuilds.
CREATE TABLE IF NOT EXISTS ops (
    block_num BIGINT NOT NULL,
    trx_in_block INT NOT NULL,
    op_in_trx INT NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    trx_id TEXT NOT NULL,
    signer TEXT NOT NULL,
    op_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
    reject_reason TEXT,
    PRIMARY KEY (block_num, trx_in_block, op_in_trx)
);
CREATE INDEX IF NOT EXISTS ops_signer_idx ON ops (signer, block_num DESC);
CREATE INDEX IF NOT EXISTS ops_op_id_idx ON ops (op_id, block_num DESC);

-- ─── Profiles ──────────────────────────────────────────────────────
-- Latest profile per account. Replaced in place by new profile ops;
-- full history lives in the `ops` table.
CREATE TABLE IF NOT EXISTS profiles (
    account TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    json_metadata JSONB NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
-- ILIKE-friendly index for display name lookup.
CREATE INDEX IF NOT EXISTS profiles_display_name_idx
    ON profiles (LOWER(display_name));

-- ─── Orders ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    account TEXT NOT NULL,
    permlink TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    asset TEXT NOT NULL,
    fiat_currency TEXT NOT NULL,
    amount_min NUMERIC,
    amount_max NUMERIC,
    price_model JSONB NOT NULL,
    location_region TEXT,
    payment_methods TEXT[] NOT NULL,
    terms TEXT,
    status TEXT NOT NULL CHECK (status IN ('live', 'cancelled', 'expired')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    PRIMARY KEY (account, permlink)
);
-- Partial index tuned for the orderbook read path.
CREATE INDEX IF NOT EXISTS orders_live_idx
    ON orders (status, asset, side, updated_at DESC)
    WHERE status = 'live';
CREATE INDEX IF NOT EXISTS orders_account_idx ON orders (account, updated_at DESC);

-- ─── Feedback ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
    id BIGSERIAL PRIMARY KEY,
    reviewer TEXT NOT NULL,
    subject TEXT NOT NULL,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    order_permlink TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE,
    -- One review per (reviewer, subject, order). If order_permlink is
    -- NULL we still constrain (reviewer, subject) — Postgres NULL
    -- semantics in UNIQUE require special handling; using a partial
    -- unique index for the NULL case.
    UNIQUE (reviewer, subject, order_permlink)
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_reviewer_subject_null_order_idx
    ON feedback (reviewer, subject)
    WHERE order_permlink IS NULL;
CREATE INDEX IF NOT EXISTS feedback_subject_idx ON feedback (subject, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_reviewer_idx ON feedback (reviewer, created_at DESC);

-- ─── Feedback responses ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback_responses (
    id BIGSERIAL PRIMARY KEY,
    feedback_id BIGINT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    responder TEXT NOT NULL,
    comment TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS feedback_responses_feedback_id_idx
    ON feedback_responses (feedback_id, created_at DESC);

-- ─── Releases ──────────────────────────────────────────────────────
-- Every release-discovery op, whether the signature validates or not.
-- `valid = true` means signed by the pinned MORPHIT_OFFICIAL_POSTING_PUBKEY.
CREATE TABLE IF NOT EXISTS releases (
    id BIGSERIAL PRIMARY KEY,
    version TEXT NOT NULL,
    hash_manifest JSONB NOT NULL,
    endpoints JSONB NOT NULL,
    signature TEXT NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE,
    signer TEXT NOT NULL,
    valid BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS releases_valid_idx
    ON releases (valid, created_at DESC)
    WHERE valid = true;

-- ─── Chat messages (ciphertext only) ──────────────────────────────
-- The indexer stores opaque ciphertext; only the two participants
-- can decrypt it with their memo keys.
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    header JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    source_trx_id TEXT NOT NULL UNIQUE
);
-- Canonical-order index so /v1/chat/a/b and /v1/chat/b/a hit the
-- same index.
CREATE INDEX IF NOT EXISTS chat_pair_idx ON chat_messages (
    LEAST(sender, recipient), GREATEST(sender, recipient), created_at DESC
);

-- ─── Record this migration ────────────────────────────────────────
INSERT INTO schema_migrations (version, description)
VALUES (1, 'initial schema')
ON CONFLICT (version) DO NOTHING;
