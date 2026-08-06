-- Morphit indexer — migration v15.
--
-- Adds the `blocks` table for per-recipient block lists. Chat
-- handler consults this table on every incoming message; if a
-- row exists with state='blocked' where recipient is `blocker`
-- and sender is `blocked`, the message is rejected with
-- `recipient_blocked_sender` without storing the ciphertext.
--
-- Part of ADR-0014 chat-scoping decisions (Finding H — chat
-- anti-spam triad, belt-and-suspenders (b) + (c)). This
-- migration covers the "block list" layer; the stranger-fee
-- and rate-limit layers arrive in later migrations.
--
-- Schema rationale:
--   * Composite PK (blocker, blocked) — at most one active
--     relationship per pair. Unblock doesn't delete the row;
--     it flips `state`, preserving a minimal audit trail in
--     `updated_at` / `last_action_block_num` so operators can
--     see "this user blocked and unblocked the same account
--     three times in a week" if that ever matters.
--   * (since_block_num, since_trx_id) anchor the ORIGINAL
--     block decision to the Blurt chain. On unblock + re-block,
--     `since_*` rewinds to the new block op.
--   * `state` as a TEXT CHECK constraint rather than an enum
--     so future states (e.g. "muted" for soft suppression) can
--     be added with a plain ALTER.
--
-- Frontend behavior the handler assumes:
--   * A user can block anyone (no counterparty precheck).
--   * A user can unblock anyone they previously blocked.
--   * Blocking does NOT notify the blocked account (the op
--     is public on-chain, so anyone scraping can learn it,
--     but Morphit's UI deliberately doesn't surface
--     "you've been blocked by @x" — that's an anti-harassment
--     call, not a privacy one).

CREATE TABLE IF NOT EXISTS blocks (
    -- The account doing the blocking. Stored as Blurt account
    -- name (3..16 chars, lowercase, hyphens + dots + digits).
    blocker                  VARCHAR(16) NOT NULL,

    -- The account being blocked. Same constraints.
    blocked                  VARCHAR(16) NOT NULL,

    -- 'blocked' — active relationship; chat handler rejects.
    -- 'unblocked' — relationship was once blocked but the
    --   blocker has since reversed. Row is kept for audit.
    state                    TEXT        NOT NULL
        CHECK (state IN ('blocked', 'unblocked')),

    -- Block number on the Blurt chain where the ORIGINAL
    -- block decision landed. Does not move when the state
    -- flips — this anchors "when did this relationship start?"
    since_block_num          BIGINT      NOT NULL,

    -- Transaction id of the original block decision. Useful
    -- for audit / dispute ("can you prove I blocked them on
    -- 2025-11-14?") — the user can present this trx_id on
    -- blocks.blurtwallet.com and see the raw op.
    since_trx_id             VARCHAR(40) NOT NULL,

    -- Block number where the MOST RECENT action landed
    -- (including re-blocks and unblocks). Moves with every
    -- op that touches this row.
    last_action_block_num    BIGINT      NOT NULL,

    -- Blurt block time of the FIRST block decision. Fixed.
    created_at               TIMESTAMPTZ NOT NULL,

    -- Blurt block time of the LATEST state change. Moves.
    updated_at               TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (blocker, blocked),

    -- Self-block is nonsense; the handler rejects it too, but
    -- a CHECK here is a cheap second line of defense.
    CHECK (blocker <> blocked)
);

-- Fast lookup for the chat handler's hot path: "does `sender`
-- appear in any recipient's block list?" The handler queries
-- `WHERE blocker = $recipient AND blocked = $sender AND
-- state = 'blocked'`, which is already covered by the PK. But
-- the Settings "Blocked accounts" page lists all accounts a
-- user has blocked, which wants `WHERE blocker = $me AND
-- state = 'blocked'`. The PK prefix covers that too.
--
-- A separate index on `blocked` would help "who has blocked
-- me?" — but surfacing that answer contradicts the explicit
-- UX decision not to tell blocked users they're blocked. We
-- deliberately don't add that index to avoid normalizing a
-- query pattern that shouldn't exist.
