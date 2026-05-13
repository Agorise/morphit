-- Phase D.5 — Federation auto-discovery.
--
-- Two changes here:
--
-- 1. Add `origin` column to `operators`.  v2 of the operator-register
--    op (see operatorRegister.ts handler) accepts an optional origin
--    URL.  When the origin is set we persist it here, treating it as
--    canonical: "the on-chain record claims this operator's instance
--    is reachable at this origin."
--
-- 2. New `known_instances` table.  Operational state for the
--    federation directory: one row per origin we've heard about,
--    with cached probe status from the indexer's liveness scanner.
--    Driven entirely by chain replay (registrations populate it)
--    and the probe scheduler (probes update status), so no manual
--    curation.
--
-- Backwards-compatible: old register ops without origin still
-- work (origin column is nullable; v2 schema is a strict
-- superset of v1 in payload validation).

ALTER TABLE operators
	ADD COLUMN IF NOT EXISTS origin TEXT;

CREATE TABLE IF NOT EXISTS known_instances (
	-- Canonical key: the origin URL exactly as registered on-chain.
	-- Stored normalized (no trailing slash, lowercase scheme/host).
	origin                TEXT PRIMARY KEY,

	-- The on-chain account that claimed this origin via a register
	-- op.  Single source of truth for "@alice claims X" — the probe
	-- layer cross-checks by hitting X/v1/instance and verifying the
	-- relay_account field matches.  Mismatch → 'mismatch' status.
	operator_account      TEXT NOT NULL,

	-- Block + time at which the registration op landed.  Used for
	-- the new-instance grace period (newer than 7 days → exempt
	-- from "no orders" probe failure).
	registered_at_block   BIGINT NOT NULL,
	registered_at_time    TIMESTAMPTZ NOT NULL,

	-- Last time the probe scheduler reached out to this origin.
	-- NULL → never probed (just-discovered, queued for first probe).
	last_probed_at        TIMESTAMPTZ,

	-- Status of the most recent probe.  Values:
	--   'never'        — table entry exists but probe hasn't run yet
	--   'good'         — all checks passed (see api/instances.ts)
	--   'quiet'        — alive but no orderbook activity in last 7d
	--                    AND >7d old (newer instances graceful)
	--   'stale'        — /v1/health returned 'degraded', or chain lag
	--                    > 30 blocks at last probe
	--   'unreachable'  — HTTP fetch failed (timeout, refused, DNS, TLS)
	--   'mismatch'     — origin reachable but /v1/instance.relay_account
	--                    doesn't match the operator_account from chain
	last_probe_status     TEXT,

	-- Operator-readable error string from the last unsuccessful probe.
	-- Examples: "HTTP 503", "connect ETIMEDOUT", "TLS expired",
	-- "operator_account mismatch: chain says @alice, instance says @bob"
	last_probe_error      TEXT,

	-- Cached snapshot of the last successful /v1/instance + /v1/health
	-- response.  Lets /v1/instances serve from DB without fan-out
	-- fetches per request.  Updated only on a successful probe; stale
	-- data is fine (probe runs every 10min for healthy instances).
	cached_name           TEXT,
	cached_tagline        TEXT,
	cached_contact_url    TEXT,
	cached_alt_networks   JSONB,
	cached_indexed_block  BIGINT,
	cached_chain_lag_sec  INT,

	-- Counter for the back-off + drop logic.  Resets to 0 on any
	-- successful probe.  Once it hits the 7-day-failure ceiling
	-- (≈168 hourly probes), the row is deleted and would only
	-- re-appear if a fresh registration op lands.
	consecutive_failures  INT NOT NULL DEFAULT 0
);

-- Index for the common "give me everything still good" query
-- served by /v1/instances?status=good.
CREATE INDEX IF NOT EXISTS idx_known_instances_status
	ON known_instances (last_probe_status)
	WHERE last_probe_status IN ('good', 'quiet');

-- Index for the probe scheduler picking what's next to probe.
-- Probes are due when last_probed_at < now() - interval, where
-- interval is status-dependent (10min for good, 1hr for stale).
-- The scheduler scans this table by last_probed_at ASC NULLS FIRST,
-- so the index supports the bulk probe-due lookup.
CREATE INDEX IF NOT EXISTS idx_known_instances_probe_due
	ON known_instances (last_probed_at NULLS FIRST);
