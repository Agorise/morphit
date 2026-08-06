-- Morphit indexer — migration v7.
--
-- Phase 5b — operator incentives: data-layer scaffolding.
--
-- This migration lands the shape-stable parts of Phase 5b: the
-- tables that will hold operator identities and their earnings
-- tallies. The op handlers that will populate them (registration
-- op, referrer-tracking op, payout op) are gated on ADR-0013
-- resolution and NOT part of this migration.
--
-- Why land the tables now, before ADR-0013 is accepted? Two
-- reasons:
--   1. The column set here covers only policy-independent
--      attributes: who the operator is, what tag they use, when
--      they registered, what they've earned in aggregate. The
--      open questions (fee amount, split percentage, pull vs
--      push) determine *rules that operate on these rows*, not
--      the row shape itself.
--   2. Shipping the tables early lets the /operators directory
--      page be tested end-to-end (with zero rows) without having
--      to land the whole feature at once.
--
-- If ADR-0013 ultimately chooses a drastically different model
-- (e.g., operators as SBTs minted on another chain), these tables
-- become dead code — but the cost is cheap: two empty tables and
-- three indexes. No data migration headache.

-- 1. operators — one row per registered operator. The natural
-- key is the Blurt account that registered; `tag` is a display/
-- attribution label (chosen by the operator, subject to ADR-0013
-- Q5's registry-governance rules once those exist).
--
-- Columns whose presence is shape-stable:
--   account: the Blurt account owning the operator identity.
--   tag: a short unique handle used in referrer tracking. The
--        UNIQUE constraint enforces the collision-free invariant
--        regardless of how disputes are resolved by policy.
--   display_name: human-readable name for the directory page.
--   contact_url: operator's contact URL (their own site, an
--                onion service, an @username on social, etc).
--   registered_in_block: chain block where registration
--                        completed; lets an indexer reconcile
--                        or replay if state is lost.
--   is_active: cheap flag so suspension/offboarding (an eventual
--              policy question under ADR-0013 Q5) doesn't need
--              a row delete.
--
-- Columns deliberately NOT included (gated on ADR-0013):
--   registration_fee_paid_blurt: depends on Q1
--   referrer_mechanism_version: depends on Q2
--   fee_split_percent_override: depends on Q3
CREATE TABLE IF NOT EXISTS operators (
    account TEXT PRIMARY KEY,
    tag TEXT NOT NULL,
    display_name TEXT NOT NULL,
    contact_url TEXT,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registered_in_block BIGINT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    -- Forward-compat: JSONB extras so we can stash ADR-0013
    -- decisions (once accepted) without a v8 migration just for
    -- adding a column. Contents are NOT authoritative — every
    -- policy-relevant datum lands in a proper column once decided.
    extras JSONB NOT NULL DEFAULT '{}'::JSONB,
    UNIQUE (tag)
);

-- Index for directory-page sort (recently-registered first) and
-- is_active filtering.
CREATE INDEX IF NOT EXISTS operators_active_registered_idx
    ON operators (is_active, registered_at DESC);

-- 2. operator_earnings — running tally of per-operator revenue.
-- Updated by the indexer as orders land that carry a tag
-- attribution (referrer mechanism from ADR-0013 Q2). Shape is
-- stable because the *fact* of a running tally per operator is
-- independent of how the tally is sourced.
--
-- Rows are created lazily on first attributed order — an operator
-- with zero earnings has no row here, which keeps "total registered"
-- (operators rowcount) distinct from "has earned anything".
CREATE TABLE IF NOT EXISTS operator_earnings (
    account TEXT PRIMARY KEY REFERENCES operators(account) ON DELETE CASCADE,
    cumulative_blurt_earned NUMERIC NOT NULL DEFAULT 0
        CHECK (cumulative_blurt_earned >= 0),
    total_orders_attributed BIGINT NOT NULL DEFAULT 0
        CHECK (total_orders_attributed >= 0),
    last_payout_at TIMESTAMPTZ,
    last_payout_blurt NUMERIC
        CHECK (last_payout_blurt IS NULL OR last_payout_blurt >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. operator_registration_events — audit trail of all
-- registration-adjacent ops. Separate from operators so that
-- reconstitution from the event log (rebuild-materialized mode)
-- is natural. This is the table the indexer handler will INSERT
-- into; operators + operator_earnings are derived from this
-- table per the class-2 materialization pattern.
--
-- kind vocabulary is open-ended for forward-compat with ADR-0013:
--   'register': operator came online
--   'deactivate': operator suspended/offboarded
--   'reactivate': operator returned
--   'tag_changed': operator changed display tag (subject to policy)
-- Additional kinds land without a migration once decided.
CREATE TABLE IF NOT EXISTS operator_registration_events (
    id BIGSERIAL PRIMARY KEY,
    account TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    observed_in_block BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operator_registration_events_account_idx
    ON operator_registration_events (account, observed_at DESC);
