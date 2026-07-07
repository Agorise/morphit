-- Migration 24 — instance_payment_methods
--
-- Batch L (ADR-0021): operator-instance payment-method additions.
-- Operators broadcast `morphit_payment_method_addition_v1` ops to
-- extend the canonical registry with region-specific methods (e.g.
-- a Thailand operator adds "PromptPay").  Additions render in the
-- picker alongside canonical entries with a "(this instance only)"
-- badge.  Operators can NOT remove canonical entries — federation
-- safety requires the canonical list to be globally consistent.
--
-- Only the configured operator account can write to this table.
-- The frontend reads from `/v1/instance/payment-methods` (a
-- dedicated public endpoint) on app boot to populate the picker.
--
-- Keys:
--   - `key`: the operator-supplied identifier ([a-z0-9_]+, 3-24
--     chars).  Stored on chain in orders' `payment_methods` array
--     prefixed `@instance:<key>`.  The handler validates that the
--     key does NOT collide with any canonical key from
--     apps/web/src/lib/payments/registry.ts (the indexer keeps a
--     hardcoded list of reserved keys; see handler).
--   - `name`: display name (≤64 chars, NFC-normalized).
--   - `description`: ≤300 chars, sanitized for bidi/zero-width.
--   - `category`: one of 'crypto', 'in_person', 'online'.
--   - `state`: 'active' or 'removed'.  Removed entries stay in
--     the table for audit trail but the API filters them out.

CREATE TABLE instance_payment_methods (
    operator               varchar(16)  NOT NULL,
    key                    varchar(24)  NOT NULL,
    name                   varchar(64)  NOT NULL,
    description            text         NOT NULL DEFAULT '',
    category               varchar(16)  NOT NULL CHECK (category IN ('crypto', 'in_person', 'online')),
    url                    text,
    state                  varchar(10)  NOT NULL CHECK (state IN ('active', 'removed')),
    -- since_* anchors the current state's establishing op.
    since_block_num        bigint       NOT NULL,
    since_trx_id           varchar(64)  NOT NULL,
    last_action_block_num  bigint       NOT NULL,
    created_at             timestamptz  NOT NULL,
    updated_at             timestamptz  NOT NULL,
    PRIMARY KEY (operator, key),
    CHECK (length(description) <= 300),
    CHECK (key ~ '^[a-z][a-z0-9_]+$')
);

-- Hot path: "list this instance's active additions for the picker."
CREATE INDEX instance_payment_methods_active_idx
    ON instance_payment_methods (operator, state, category, name)
    WHERE state = 'active';
