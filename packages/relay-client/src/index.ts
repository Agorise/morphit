/**
 * @morphit/relay-client — shared TypeScript types for the Morphit
 * relay HTTP API.
 *
 * Both the relay itself (to validate its own response shapes) and
 * the frontend (to type its fetch wrappers) import from this
 * package.  Keeping the types in one place means a contract
 * mismatch fails type-check at compile time rather than at runtime
 * inside a user's signup flow.
 *
 * Mirrors the @morphit/indexer-client pattern.  This module exports
 * types only — no runtime code.  Do not add helpers here; they
 * belong in the consuming app.
 *
 * **The relay endpoints, in summary:**
 *
 *   POST /v1/account/invite       → issue a short-lived invite token
 *                                    or surface an altcha challenge
 *   POST /v1/account/create       → broadcast the create_claimed_account
 *                                    op via the relay's posting key
 *   GET  /v1/account/availability → check whether a candidate username
 *                                    is structurally valid AND not
 *                                    already on-chain (best-effort)
 *   GET  /v1/health               → liveness/readiness probe; verbose
 *                                    fields only when verboseHealth=true
 *                                    in the operator's config
 *
 * Part 122 cp6 — created to close the standing "PHASE F first
 * contract layer" REVISIT item.
 */

// ─── Error codes ───────────────────────────────────────────────────

/**
 * Every error code the relay can emit in a `code: '...'` field of a
 * `{ status: 'rejected', code: <RelayErrorCode> }` JSON body.
 *
 * Grouped by originating endpoint for readability — but the wire
 * format does NOT promise which endpoint emits which code (a code
 * may be emitted by multiple endpoints).  Consumers should treat
 * the union as flat.
 *
 * Client-local error codes (network-unreachable, altcha-unsolvable)
 * are NOT in this union — they're emitted by the client code itself,
 * never by the relay over the wire.  See `signupClient.ts`'s
 * `SignupErrorCode` which extends `RelayErrorCode` with the local
 * codes.
 */
export type RelayErrorCode =
	// /v1/account/invite — gate codes
	| 'signups_disabled'
	| 'daily_ceiling_reached'
	| 'invite_rate_limited'
	// /v1/account/invite — altcha codes
	| 'altcha_bad_solution'
	| 'altcha_bad_signature'
	| 'altcha_expired'
	| 'altcha_malformed'
	| 'altcha_replayed'
	// /v1/account/create — gate codes
	| 'rate_limited'
	| 'rate_limited_daily'
	| 'spacing_cooldown'
	| 'relay_out_of_funds'
	| 'invite_required'
	| 'invite_malformed'
	| 'invite_bad_signature'
	| 'invite_expired'
	| 'invite_ip_mismatch'
	| 'invite_already_used'
	| 'malformed_operation'
	| 'name_not_allowed'
	| 'name_high_value'
	| 'name_sequential_pattern'
	| 'invalid_pubkey'
	| 'duplicate_submission'
	| 'already_registered'
	| 'chain_unavailable'
	| 'broadcast_failed';

/**
 * Common shape of every rejection body.  All endpoints follow this
 * envelope.  Optional fields are populated case-by-case (e.g.
 * `retry_after_minutes` for spacing_cooldown, `resets_at` for
 * daily_ceiling_reached).
 */
export interface RelayRejection {
	readonly status: 'rejected';
	readonly code: RelayErrorCode;
	/** Minutes until the client may safely retry.  Present on
	 *  rate-limit and cooldown rejections. */
	readonly retry_after_minutes?: number;
	/** ISO 8601 datetime at which a daily ceiling rolls over.
	 *  Present on `daily_ceiling_reached`. */
	readonly resets_at?: string;
}

// ─── /v1/account/invite ────────────────────────────────────────────

/** Altcha proof-of-work challenge issued by the relay when the
 *  invite endpoint requires one.  Opaque to the type system —
 *  the client's `solveAltcha` accepts this shape and produces a
 *  matching `AltchaSolution`. */
export interface AltchaChallenge {
	readonly algorithm: string;
	readonly challenge: string;
	readonly salt: string;
	readonly signature: string;
	readonly maxnumber?: number;
}

/** Successful invite issuance. */
export interface RelayInviteIssued {
	readonly status: 'issued';
	readonly invite_token: string;
	readonly expires_at?: string;
}

/** Invite endpoint is gating signups behind altcha. The client must
 *  solve the PoW and retry the request with `altcha_solution` in
 *  the body. */
export interface RelayInviteAltchaRequired {
	readonly status: 'altcha_required';
	readonly challenge: AltchaChallenge;
}

/** All possible response shapes for `POST /v1/account/invite`. */
export type RelayInviteResponse =
	| RelayInviteIssued
	| RelayInviteAltchaRequired
	| RelayRejection;

// ─── /v1/account/create ────────────────────────────────────────────

/** Successful broadcast.  block_num and trx_id come from the Blurt
 *  RPC node's broadcast response. */
export interface RelayCreateBroadcast {
	readonly status: 'broadcast';
	readonly block_num: number;
	readonly trx_id: string;
}

/** All possible response shapes for `POST /v1/account/create`. */
export type RelayCreateResponse = RelayCreateBroadcast | RelayRejection;

// ─── /v1/account/availability ──────────────────────────────────────

/** Name is structurally valid AND not present on-chain (best-effort:
 *  the chain check is a fast non-blocking lookup; the authoritative
 *  check is at broadcast time).  Client should treat this as a
 *  hint, not a guarantee. */
export interface RelayAvailabilityAvailable {
	readonly name: string;
	readonly available: true;
}

/** Name is structurally invalid OR already registered.  The `reason`
 *  is a stable string code suitable for direct i18n lookup. */
export interface RelayAvailabilityUnavailable {
	readonly name: string;
	readonly available: false;
	readonly reason: string;
}

/** All possible response shapes for `GET /v1/account/availability`. */
export type RelayAvailabilityResponse =
	| RelayAvailabilityAvailable
	| RelayAvailabilityUnavailable
	| RelayRejection;

// ─── /v1/health ────────────────────────────────────────────────────

/** Minimal health body returned when the operator has NOT enabled
 *  `verboseHealth`.  This is the production default — operators
 *  opt in to verbose for monitoring dashboards. */
export interface RelayHealthMinimal {
	readonly status: 'ok';
}

/** Verbose health body returned when `verboseHealth: true` is set in
 *  the relay config.  All extended fields are optional on the wire
 *  because individual fields may be absent depending on the relay's
 *  initialization state (e.g. signup_stats is absent until the
 *  ceiling has been wired in). */
export interface RelayHealthVerbose extends RelayHealthMinimal {
	readonly version?: string;
	readonly uptime_sec?: number;
	readonly node_version?: string;
	readonly blurt_balance?: string | number;
	readonly pending_claimed_accounts?: number;
	readonly last_refresh_unix?: number;
	readonly stale?: true;
	readonly signup_stats?: RelaySignupStats;
}

/** Signup-drain-prevention statistics included in verbose health.
 *  Used by monitoring dashboards to track ceiling utilization,
 *  rate-of-signup, and anomaly thresholds. */
export interface RelaySignupStats {
	readonly enabled: boolean;
	readonly daily_ceiling: number;
	readonly successful_today: number;
	readonly current_hour_count: number;
	readonly peak_hour_count: number;
	readonly peak_other_hours: number;
	readonly resets_at: string;
}

/** All possible response shapes for `GET /v1/health`. */
export type RelayHealthResponse = RelayHealthMinimal | RelayHealthVerbose;
