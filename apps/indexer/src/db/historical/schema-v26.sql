-- Migration 26 — feedback.has_verified_chat
--
-- ADR-0014 verified-chat badge.  At feedback intake, the
-- handler runs a conformance query against chat_messages +
-- suspicious_reciprocity to decide whether the
-- reviewer↔subject pair had a "verified chat" — meaning a
-- bidirectional conversation that looks like genuine trade
-- coordination, not a sock-puppet flood.  The result is
-- stored in this column at intake time so subsequent reads
-- of the feedback row are O(1) and don't have to re-evaluate
-- the conformance against potentially-stale chat history.
--
-- Criteria for has_verified_chat = TRUE (must hold at the
-- time the feedback was signed; see REVISIT-LIST §G ratings-
-- tying-to-chat-sessions for the full rationale):
--   1. ≥2 chat_messages from reviewer to subject before
--      feedback.created_at
--   2. ≥2 chat_messages from subject to reviewer before
--      feedback.created_at
--   3. ≥15 minutes elapsed between the pair's earliest and
--      latest chat_message before feedback.created_at
--   4. NO suspicious_reciprocity row for the pair (LEAST/
--      GREATEST canonicalized account pair)
--
-- What the badge claims: "these accounts had a conversation
-- that looks like real trade coordination."  What it does
-- NOT claim: "these are two distinct people."  A patient
-- attacker with two coordinated accounts can satisfy the
-- criteria; the badge is a correlation signal, not an
-- identity proof.
--
-- Backfill posture: NOT done.  The conformance query at
-- intake uses ctx.blockTime as the cutoff (not NOW()), so
-- pre-v26 feedback rows would need a per-row replay against
-- chat history at their original block time.  This is
-- expensive and has limited value (old feedback's badge
-- status won't influence current decisions much).  All
-- pre-v26 rows stay at the DEFAULT FALSE; new rows compute
-- and store the boolean at intake.  An offline backfill
-- job is documented in OPERATIONS.md if an operator wants
-- to retroactively populate.
--
-- Index strategy: no new index.  Reads of feedback rows
-- already filter by (subject) or (reviewer) which the
-- existing feedback_subject_idx + feedback_reviewer_idx
-- support.  has_verified_chat is a flag column, not a
-- query predicate, so a dedicated index would just bloat
-- write paths.

ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS has_verified_chat BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN feedback.has_verified_chat IS
    'ADR-0014 verified-chat badge: true iff the reviewer↔subject pair satisfied the bidirectional-chat conformance criteria at the time the feedback was signed. Computed once at intake; never recomputed on read.';
