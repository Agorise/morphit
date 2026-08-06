-- Morphit indexer — migration v20.
--
-- BLURT-native fee refactor: drop the unused
-- `amount_usd_equivalent` column from `stranger_fees`.
--
-- Background: when stranger-fees were USD-denominated (anchor
-- $0.01 doubling per first-contact within 5 min, capped at
-- $1.28), the column recorded what the client quoted at send-
-- time using the live price feed.  After the refactor, fees
-- are denominated directly in BLURT (5 BLURT base, doubling
-- to a 640 BLURT cap).  The amount_blurt column already
-- records what was actually transferred; the USD echo was
-- never authoritative and is now redundant.
--
-- Operationally: the column had a NOT NULL CHECK > 0
-- constraint, which both go away.  No data migration needed
-- for a fresh deploy; for any future seed/test fixtures this
-- is purely a column drop.

ALTER TABLE stranger_fees
    DROP COLUMN IF EXISTS amount_usd_equivalent;
