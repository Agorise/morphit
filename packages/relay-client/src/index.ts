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
 * **Middleware-level rejections can preempt any endpoint.**  Origin
 * enforcement, content-type validation, and chunked-transfer rejection
 * all run BEFORE the handler.  Their responses use envelopes other
 * than `'rejected'` (`'bad_request'` for chunked-encoding; the same
 * `'rejected'` shape for origin/content-type; `'error'` for the
 * onError catch-all).  Each endpoint's response union therefore
 * includes the full middleware/internal rejection shapes alongside
 * the domain-success shapes.
 *
 * Part 122 cp6 — initial package landing.
 * Part 122 cp7 — deep-deep audit closed seven contract gaps:
 *   F16 ghost code `invite_required` removed (relay never emits it)
 *   F17 chunked_unsupported (security middleware) added
 *   F18 malformed_request (content-type + availability + security) added
 *   F19 origin_required + origin_not_allowed (origin enforcement) added
 *   F20 internal (onError catch-all) added
 *   F21 status: 'bad_request' | 'error' | 'not_found' shapes added
 *   F22 message?: string field on rejections added
 *
 * The `contract-symmetry-smoke.ts` runner verifies this contract
 * stays in sync with the relay code; any future drift fails CI.
 */

// ─── Error codes ───────────────────────────────────────────────────

/**
 * Every error code the relay can emit in a `code: '...'` field of a
 * JSON body, across ALL response envelopes (`'rejected'`,
 * `'bad_request'`, `'error'`).
 *
 * Grouped by originating subsystem for readability — but the wire
 * format does NOT promise which endpoint or middleware emits which
 * code (a code may be emitted by multiple paths).  Consumers should
 * treat the union as flat.
 *
 * Client-local error codes (network-unreachable, altcha-unsolvable)
 * are NOT in this union — they're emitted by the client code itself,
 * never by the relay over the wire.  See `signupClient.ts`'s
 * `SignupErrorCode` which extends `RelayErrorCode` with the local
 * codes.
 */
export type RelayErrorCode =
	// ─── /v1/account/invite — gate codes ───
	| 'signups_disabled'
	| 'daily_ceiling_reached'
	| 'invite_rate_limited'
	// ─── /v1/account/invite — altcha codes (apps/relay/src/policy/altcha.ts) ───
	| 'altcha_bad_solution'
	| 'altcha_bad_signature'
	| 'altcha_expired'
	| 'altcha_malformed'
	| 'altcha_replayed'
	// ─── /v1/account/create — gate codes ───
	| 'rate_limited'
	| 'rate_limited_daily'
	| 'spacing_cooldown'
	| 'relay_out_of_funds'
	// ─── /v1/account/create — invite-token codes (apps/relay/src/policy/inviteToken.ts) ───
	| 'invite_malformed'
	| 'invite_bad_signature'
	| 'invite_expired'
	| 'invite_ip_mismatch'
	| 'invite_already_used'
	// ─── /v1/account/create — op validation codes ───
	| 'malformed_operation'
	| 'name_not_allowed'
	| 'name_high_value'
	| 'name_sequential_pattern'
	| 'invalid_pubkey'
	| 'duplicate_submission'
	| 'already_registered'
	| 'chain_unavailable'
	| 'broadcast_failed'
	// ─── Middleware (preempts handler — apps/relay/src/middleware/) ───
	/** Chunked transfer-encoding rejected; client must send
	 *  Content-Length. (security.ts) */
	| 'chunked_unsupported'
	/** Content-Type missing/wrong, or JSON body unparseable.
	 *  (content_type.ts + availability.ts + security.ts) */
	| 'malformed_request'
	/** No Origin header on a write endpoint that requires one.
	 *  (origin_enforcement.ts) */
	| 'origin_required'
	/** Origin header present but not in operator's allowlist.
	 *  (origin_enforcement.ts) */
	| 'origin_not_allowed'
	// ─── Catch-all (apps/relay/src/main.ts onError) ───
	/** Unhandled exception in the handler.  Returned with HTTP 500
	 *  and `status: 'error'`.  Stack traces never leak over the
	 *  wire (logged internally only). */
	| 'internal';

// ─── Rejection envelopes ───────────────────────────────────────────

/**
 * Common shape of `status: 'rejected'` bodies emitted by both the
 * endpoint handlers (domain rejections) and the origin/content-type
 * middleware.  All endpoints follow this envelope for their domain
 * rejections.  Optional fields are populated case-by-case (e.g.
 * `retry_after_minutes` for spacing_cooldown, `resets_at` for
 * daily_ceiling_reached, `message` for middleware rejections).
 */
export interface RelayRejection {
	readonly status: 'rejected';
	readonly code: RelayErrorCode;
	/** Human-readable error message.  Populated by middleware
	 *  rejections (origin, content-type) and by some endpoint
	 *  rejections.  Domain rejections may omit it; consumers
	 *  should i18n by `code` and treat `message` as a debug
	 *  hint, not user-facing copy. */
	readonly message?: string;
	/** Minutes until the client may safely retry.  Present on
	 *  rate-limit and cooldown rejections. */
	readonly retry_after_minutes?: number;
	/** ISO 8601 datetime at which a daily ceiling rolls over.
	 *  Present on `daily_ceiling_reached`. */
	readonly resets_at?: string;
}

/**
 * `status: 'bad_request'` envelope — currently used by the security
 * middleware for chunked transfer-encoding rejection (HTTP 411).
 * Distinct from `'rejected'` because the relay treats this as a
 * pre-domain HTTP-level failure, not a business-logic rejection.
 */
export interface RelayBadRequest {
	readonly status: 'bad_request';
	readonly code: 'chunked_unsupported' | 'malformed_request';
	readonly message?: string;
}

/**
 * `status: 'error'` envelope — emitted ONLY by the main.ts onError
 * catch-all when a handler throws.  HTTP 500.  Stack traces never
 * leak over the wire (logged internally only).
 */
export interface RelayInternalError {
	readonly status: 'error';
	readonly code: 'internal';
}

/**
 * `status: 'not_found'` envelope — emitted by the Hono notFound()
 * handler for unmatched routes.  HTTP 404.  No `code` field.
 */
export interface RelayNotFound {
	readonly status: 'not_found';
}

/**
 * Union of every "the request didn't get a domain-success response"
 * envelope.  Every endpoint's response union includes this so
 * consumers can handle middleware preemption and internal errors
 * uniformly.
 */
export type RelayGenericFailure =
	| RelayRejection
	| RelayBadRequest
	| RelayInternalError
	| RelayNotFound;

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
	| RelayGenericFailure;

// ─── /v1/account/create ────────────────────────────────────────────

/** Successful broadcast.  block_num and trx_id come from the Blurt
 *  RPC node's broadcast response. */
export interface RelayCreateBroadcast {
	readonly status: 'broadcast';
	readonly block_num: number;
	readonly trx_id: string;
}

/** All possible response shapes for `POST /v1/account/create`. */
export type RelayCreateResponse = RelayCreateBroadcast | RelayGenericFailure;

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
	| RelayGenericFailure;

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

/** All possible response shapes for `GET /v1/health`.  Health
 *  doesn't sit behind origin-enforcement middleware (it's a public
 *  liveness probe), but it CAN return RelayInternalError if the
 *  handler throws, or RelayNotFound if the path is wrong. */
export type RelayHealthResponse =
	| RelayHealthMinimal
	| RelayHealthVerbose
	| RelayInternalError
	| RelayNotFound;
