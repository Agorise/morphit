/**
 * Morphit relay — configuration loader.
 *
 * Loads the relay's runtime configuration from environment variables,
 * validates it with zod, and exposes a fully-typed Config object.
 *
 * Philosophy (same as Phase-3a Go prototype): if anything is missing or
 * out of range, refuse to start. A relay that starts with a broken
 * config and silently fails first requests is strictly worse than one
 * that fails noisily at boot.
 */

import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { looksLikeEnvelope } from '../crypto/keyEnvelope.ts';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';

/**
 * A VAPID application-server (public) key is the uncompressed P-256 public
 * point: 65 bytes, first byte 0x04, base64url-encoded (~87 chars). The
 * browser's `pushManager.subscribe()` rejects anything else — a malformed
 * value here (wrong length, a stray trailing newline that survived into
 * the served JSON, a base64-PEM blob, or the 32-byte PRIVATE key pasted by
 * mistake) surfaces to end users as a cryptic "Subscription failed" with
 * no clue why. Validating the shape lets us refuse to advertise push as
 * enabled (clients then show a clean "push disabled") and log one clear
 * operator warning instead. Accepts base64 or base64url, with/without
 * padding; rejects whitespace/PEM/hex.
 */
export function isValidVapidPublicKey(key: string | undefined | null): boolean {
	if (!key) return false;
	if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(key)) return false;
	let buf: Buffer;
	try {
		buf = Buffer.from(key, 'base64url');
	} catch {
		return false;
	}
	// 65-byte uncompressed P-256 point, leading 0x04.
	return buf.length === 65 && buf[0] === 0x04;
}

/**
 * A usable VAPID subject is a `mailto:` with an address, or an `https://` URL
 * with a real host.  A domain-less `https://` (which a tor-only node produces
 * when it has no clearnet domain) is NOT usable — web-push rejects it — so it
 * must DISABLE push, never crash the relay.  http:// (incl. .onion) is not a
 * valid VAPID subject: browser push services are clearnet-https/mailto only.
 */
export function isValidVapidSubject(subject: string | undefined | null): boolean {
	if (!subject) return false;
	const s = subject.trim();
	if (s.startsWith('mailto:')) return s.length > 'mailto:'.length;
	try {
		const u = new URL(s);
		return u.protocol === 'https:' && u.hostname.length > 0;
	} catch {
		return false;
	}
}

/**
 * Sentinels that have appeared in this repo's example .env files.
 * Boot is refused if MORPHIT_RELAY_DATABASE_URL still contains
 * any of them as the password component, which catches the
 * "operator copied the example file and never edited it" mistake.
 *
 * Keep in sync with ops/postgres/init.sql's reject list and with
 * apps/indexer/src/config/index.ts.
 */
const PLACEHOLDER_DB_PASSWORDS = [
	'CHANGEME',
	'CHANGE_ME',
	'CHANGE_ME_BEFORE_PRODUCTION',
	'__SET_BEFORE_DEPLOY__',
	'password',
	'postgres'
] as const;

/** HMAC secret schema for the invite-token + Altcha-challenge signers.
 *  Optional: if UNSET the relay generates a secure random 32-byte secret
 *  per boot (see policy/inviteToken.ts + policy/altcha.ts) — fine for most
 *  operators given the ~10-minute TTL. But if an operator DOES set one,
 *  refuse the example placeholder sentinel and any too-short value, so a
 *  careless copy of relay.env.example (where these once shipped uncommented
 *  as `__SET_BEFORE_DEPLOY__`) can't put a publicly-known HMAC secret into
 *  production — which would let an attacker forge invite tokens / Altcha
 *  solutions. This is exactly the boot-refusal the relay.env.example comment
 *  promises; the previous bare `.optional()` did NOT enforce it. Leaving the
 *  var unset remains valid (and is the secure default). */
export const hmacSecretSchema = z
	.string()
	.refine(
		(s) => !(PLACEHOLDER_DB_PASSWORDS as readonly string[]).includes(s),
		'HMAC secret is a known placeholder sentinel — generate a real random ' +
			'secret (e.g. `openssl rand -base64 32`) or remove the line entirely ' +
			'to use a secure ephemeral per-boot secret'
	)
	.refine(
		(s) => s.length >= 16,
		'HMAC secret too short (need ≥16 chars) — or remove the line entirely ' +
			'to use a secure ephemeral per-boot secret'
	)
	.optional();

const envSchema = z.object({
	// Required.
	MORPHIT_RELAY_ACCOUNT: z.string().min(3).max(16),
	MORPHIT_RELAY_ACTIVE_KEY_FILE: z.string().min(1),
	// ADR-0011: the relay shares the indexer's Postgres for the
	// relay_pending_transfers queue. Same database URL format as
	// MORPHIT_INDEXER_DATABASE_URL; typically identical value in
	// production where indexer+relay share one DB.
	MORPHIT_RELAY_DATABASE_URL: z
		.string()
		.min(1)
		.refine(
			(s) => s.startsWith('postgres://') || s.startsWith('postgresql://'),
			'database URL must start with postgres:// or postgresql://'
		)
		.refine(
			// Refuse to boot if the example placeholder is still present.
			(s) => !PLACEHOLDER_DB_PASSWORDS.some((p) => s.includes(`:${p}@`)),
			'database URL still contains a placeholder password sentinel; ' +
				'set a real password in ops/env/relay.env (see ' +
				'docs/RUN-A-MORPHIT-NODE.md step 7)'
		),

	// Optional (have defaults).
	MORPHIT_RELAY_LISTEN_HOST: z.string().default('127.0.0.1'),
	MORPHIT_RELAY_LISTEN_PORT: z.coerce.number().int().positive().default(8080),
	// cp663 #6 — MUST be set to this instance's public origin (the
	// deploy template does).  The default is a RESERVED, never-resolving
	// `.invalid` placeholder (RFC 6761) so a missing value fails loudly
	// and visibly instead of silently pointing at a plausible-looking
	// host that does not exist (the old 'https://relay.morphit.io').
	MORPHIT_RELAY_PUBLIC_ORIGIN: z.string().url().default('https://relay.invalid'),

	// Comma-separated lists — parsed below.
	// beta5 item D: default is the shared canonical set (single source
	// of truth in @morphit/operator-config), identical to the indexer's
	// fallback — no more divergent hardcoded lists.
	MORPHIT_RELAY_BLURT_RPC: z.string().default([...DEFAULT_BLURT_RPC_ENDPOINTS].join(',')),
	MORPHIT_RELAY_ALLOWED_ORIGINS: z.string().default('https://morphit.io'),

	// Rate limits.
	MORPHIT_RELAY_AVAILABILITY_RATE_PER_MIN: z.coerce.number().int().positive().default(60),
	MORPHIT_RELAY_CREATE_RATE_PER_HOUR: z.coerce.number().int().positive().default(5),
	/** ADR-0010 §4: long-window signup cap per IP. Stacked on top
	 *  of CREATE_RATE_PER_HOUR — both must pass. The per-hour
	 *  caps burst abuse; this caps sustained low-volume abuse.
	 *  Default 2/day matches the ADR. */
	MORPHIT_RELAY_CREATE_RATE_PER_DAY: z.coerce.number().int().positive().default(2),

	// ─── Signup-drain prevention ────────────────────────────────
	// Layered defenses against a third-party operator forging
	// Origin headers to bill signups to our relay:
	//   1. Operator kill-switch (halt all signups)
	//   2. Global daily ceiling (cap worst-case loss)
	//   3. Per-IP spacing (force time gap between a single IP's
	//      signups)
	//   4. Signed invite tokens (two-step flow, server-only HMAC)
	//   5. Altcha PoW challenge on 3rd+ invite per IP per day
	// See policy/globalDailyCeiling.ts, policy/inviteToken.ts,
	// policy/altcha.ts for each layer's module.

	/** Kill-switch. Set to false to halt ALL account creation
	 *  instantly — the endpoint returns signups_disabled without
	 *  touching the chain. Restart relay after flipping.
	 *
	 *  This is the blurt faucet for new account registration
	 *  where we pay the blurt fee and register new user accounts
	 *  for people. Flipping this off stops the faucet cold —
	 *  nothing gets paid, nothing gets registered — which is
	 *  exactly what you want if you're watching a drain
	 *  in progress and need to stop the bleeding immediately. */
	MORPHIT_RELAY_SIGNUP_ENABLED: z
		.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
		.default('true')
		.transform((v) => v === 'true' || v === '1' || v === 'yes' || v === 'on'),
	/** Hard global cap on successful signups per UTC day. When
	 *  hit, all further signups return daily_ceiling_reached
	 *  until next midnight UTC. Bounds worst-case drain to
	 *  (ceiling × chain fee). Default 50 — conservative for
	 *  launch; operators raise as their instance grows. */
	MORPHIT_RELAY_SIGNUP_DAILY_CEILING: z.coerce.number().int().positive().default(50),
	/** Optional path for persisting the daily-ceiling counter
	 *  across relay restarts (Audit 2026-05 Finding 5-4
	 *  hardening). Unset → counter is in-memory only (matches
	 *  the historical behavior; restart resets the bucket).
	 *  Set → file is read at boot, written on every successful
	 *  signup, holds AGGREGATE counts only (no IPs, no user
	 *  data). Recommended location: `/var/lib/morphit/relay/
	 *  daily-ceiling.json` — under the relay's data dir, mode
	 *  0600. Operator must ensure the dir exists and is writable
	 *  by the relay process user. */
	MORPHIT_RELAY_SIGNUP_CEILING_PERSIST_PATH: z.string().optional(),
	/** Data directory for runtime operator-actionable state.
	 *  Currently used for:
	 *    - kill-switch sentinel file (`SIGNUPS_DISABLED`).  Operator
	 *      under incident response touches this file and the next
	 *      signup poll (within 1s) sees the file and rejects.
	 *  Recommended location: `/var/lib/morphit/relay/`, mode 0700,
	 *  owned by the relay process user.  Operator must ensure the
	 *  dir exists and is writable.  When unset, the kill-switch
	 *  feature is disabled (env-var disable still works). */
	MORPHIT_RELAY_DATA_DIR: z.string().optional(),
	/** Minimum minutes between successful signups from the same
	 *  IP. In addition to the N-per-day cap, the two must be at
	 *  least this far apart. 60 means an IP that used 1 of 2 daily
	 *  can't consume the second until an hour has passed. */
	MORPHIT_RELAY_CREATE_SPACING_MINUTES: z.coerce.number().int().positive().default(60),
	/** After this many invites issued to an IP on the same UTC
	 *  day, subsequent invites require a valid Altcha PoW
	 *  solution. Default 3 — first two signups feel completely
	 *  frictionless; third adds a ~1s invisible PoW. */
	MORPHIT_RELAY_ALTCHA_TRIGGER_COUNT: z.coerce.number().int().positive().default(3),
	/** Altcha difficulty. Average client-side solve cost ≈
	 *  maxnumber / 2 SHA-256 operations. Default 2_000_000
	 *  ≈ ~1s on a modern browser, ~0.5-1 CPU-second on a
	 *  commodity VPS. Attackers scaling to 1000s of solves pay
	 *  this cost per invite. */
	MORPHIT_RELAY_ALTCHA_MAXNUMBER: z.coerce.number().int().positive().default(2_000_000),
	/** Optional persistent HMAC secret for signing invite
	 *  tokens. If unset, the relay generates an ephemeral
	 *  32-byte secret per boot (in-flight invites don't
	 *  survive a restart). For most operators the ephemeral
	 *  default is fine — invites have a 10-minute TTL anyway. */
	MORPHIT_RELAY_INVITE_HMAC_SECRET: hmacSecretSchema,
	/** Optional persistent HMAC secret for signing Altcha
	 *  challenges. Same ephemeral-by-default semantics as
	 *  INVITE_HMAC_SECRET. */
	MORPHIT_RELAY_ALTCHA_HMAC_SECRET: hmacSecretSchema,

	/** Layer 7 — high-value name policy.
	 *
	 *    strict   — block short, dictionary, brand, numeric and
	 *               numeric-suffix names (default — recommended)
	 *    moderate — block only enumeration patterns (numeric +
	 *               numeric-suffix); allow brand/dictionary names
	 *               through.  Pick this only if you've decided
	 *               your other defenses make brand-squatting
	 *               unprofitable.
	 *    off      — disable layer entirely (NOT recommended).
	 *
	 *  See policy/highValueName.ts for the per-category rules. */
	MORPHIT_RELAY_HIGHVALUE_NAME_POLICY: z.enum(['strict', 'moderate', 'off']).default('strict'),
	/** Names this length or shorter are classified as
	 *  "short_name" by the high-value classifier.  Default 4 —
	 *  blocks 3- and 4-char names (e.g. `abc`, `xyz0`).  Set to
	 *  3 to allow 4-char names but still block 3-char.  Set to
	 *  2 to allow 3+ chars (effectively disables short-name
	 *  detection but keeps brand/dictionary). */
	MORPHIT_RELAY_HIGHVALUE_SHORT_NAME_THRESHOLD: z.coerce.number().int().min(2).max(8).default(4),

	/** Layer 8 — sequential / similar-pattern detection.
	 *
	 *  When the same /24 (IPv4) or /64 (IPv6) IP bucket has
	 *  registered N successful signups matching a sequential
	 *  pattern (numeric suffix, alphabetical suffix, or shared
	 *  long prefix) within the rolling window, the next match
	 *  in that pattern is rejected.
	 *
	 *  enabled — true (default).  Set to false to disable
	 *            entirely if you run a service that legitimately
	 *            creates batched accounts.
	 *  windowMs — rolling window length.  Default 1 hour.  An
	 *            attacker who paces signups beyond the window
	 *            bypasses Layer 8 (but is still bounded by
	 *            global daily ceiling and per-IP spacing).
	 *  threshold — number of prior matching signups before the
	 *            next is rejected.  Default 2.  Higher = more
	 *            permissive. */
	MORPHIT_RELAY_SEQUENTIAL_DETECTOR_ENABLED: z
		.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
		.default('true')
		.transform((v) => v === 'true' || v === '1' || v === 'yes' || v === 'on'),
	MORPHIT_RELAY_SEQUENTIAL_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
	MORPHIT_RELAY_SEQUENTIAL_THRESHOLD: z.coerce.number().int().min(1).max(20).default(2),
	MORPHIT_RELAY_SEQUENTIAL_MIN_PREFIX: z.coerce.number().int().min(2).max(8).default(3),

	/** Additional trusted-proxy IPs / CIDR ranges that may set
	 *  X-Forwarded-For / X-Real-IP for this relay.  Comma-
	 *  separated.  Default empty (loopback `127.0.0.1` and
	 *  `::1` are always trusted; this var ADDS to the default).
	 *
	 *  Most operators leave this UNSET — the recommended
	 *  topology has nginx on the same host as the relay,
	 *  connecting via loopback.
	 *
	 *  Set this when:
	 *    - You run BunkerWeb in Docker — the BunkerWeb container
	 *      connects from the Docker bridge IP range (typically
	 *      `172.18.0.0/16`).  Pass that CIDR.
	 *    - You run nginx on a different host than the relay —
	 *      pass the nginx host's IP.
	 *    - You sit behind a CDN / TLS terminator (Cloudflare,
	 *      Vercel, fly.io edge proxies) — pass that provider's
	 *      proxy IP ranges.
	 *
	 *  CRITICAL: set this too broad (e.g. 0.0.0.0/0) and any
	 *  remote client can forge X-Forwarded-For to bypass per-IP
	 *  rate limits and drain the relay's BLURT.  Always pass the
	 *  NARROWEST CIDR that covers your actual proxy.  See
	 *  OPERATIONS.md §32 for deployment-specific guidance. */
	MORPHIT_RELAY_TRUSTED_PROXY_IPS: z.string().default(''),

	// Queue drainer cadence + batch (ADR-0011 §8).
	MORPHIT_RELAY_QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000), // 1 min
	MORPHIT_RELAY_QUEUE_BATCH_SIZE: z.coerce
		.number()
		.int()
		.positive()
		.max(100) // Don't drain hundreds per cycle — spreads load
		.default(20),
	/** Pause broadcasting from the queue after N consecutive errors
	 *  on the same row. Keeps a single poison-pill row from flood-
	 *  retrying and burning chain bandwidth. The row sits with
	 *  broadcast_at NULL and error_count >= threshold; an operator
	 *  dashboard surfaces it.  Default 3 — three failures spaced
	 *  by exponential backoff (1m, 2m, 4m … capped at 240m) gives
	 *  ~7 minutes of automatic recovery for transient upstream
	 *  hiccups before the row escalates to operator attention.
	 *  Operators with high-tolerance for retries can raise this
	 *  via MORPHIT_RELAY_QUEUE_MAX_RETRIES; the per-attempt
	 *  exponential backoff still caps total catch-up time. */
	MORPHIT_RELAY_QUEUE_MAX_RETRIES: z.coerce.number().int().min(1).default(3),

	// Health verbosity.
	MORPHIT_RELAY_VERBOSE_HEALTH: z
		.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
		.default('true')
		.transform((v) => v === 'true' || v === '1' || v === 'yes' || v === 'on'),

	/** Operator-tunable mirror of the Blurt chain's
	 *  account_creation_fee, in BLURT.  Set by witness consensus
	 *  on chain (currently 100 BLURT).  Used as: (1) fallback
	 *  when chain RPC is unavailable, (2) sanity threshold —
	 *  the relay refuses to broadcast if the chain's reported
	 *  fee is more than 10% above this value, protecting against
	 *  a witness emergency-raise quietly draining the relay,
	 *  and (3) read by ops-cli + setup wizard for balance
	 *  planning math.  Operators update this if witnesses ever
	 *  change the chain fee. */
	MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT: z.coerce.number().positive().default(100),

	// ── Web Push (Part 122 cp13) ───────────────────────────────
	// VAPID keypair (RFC 8292) for Web Push.  Operators generate
	// once via `bash scripts/generate-vapid-keys.sh` and add to
	// their relay config.  When ANY of the three is unset, push
	// is disabled at runtime — endpoints return 503 push_disabled
	// and the client falls back to in-tab channels.  Changing the
	// public key invalidates ALL existing subscriptions on this
	// instance (users must re-subscribe).
	MORPHIT_RELAY_VAPID_PUBLIC_KEY: z.string().trim().optional(),
	MORPHIT_RELAY_VAPID_PRIVATE_KEY: z.string().trim().optional(),
	// Identifies the operator to the push service.  MUST be a
	// mailto: or https:// URL.  Push services use this to contact
	// the operator if their pushes misbehave (per RFC 8292).
	// The VAPID subject is accepted as any optional string and NEVER fails config
	// load — an unusable value (empty, domain-less `https://` from a tor-only node,
	// or a typo) must DISABLE web push, not crash-loop the relay over an optional
	// feature. `pushEnabled` gates on isValidVapidSubject(); main.ts warns the
	// operator when a subject is set-but-invalid.
	MORPHIT_RELAY_VAPID_SUBJECT: z.string().trim().optional(),
	// Push-sender worker polling interval (ms).  Default 2s.
	// cp450 — notifications must feel immediate: the end-to-end
	// budget is <6s (a ~3s Blurt block + indexer enqueue + this
	// drain + push-service delivery), so this drain is the one
	// piece we fully control and it's kept small.  The prior 30s
	// default blew the budget on its own.  The query is a cheap
	// indexed SELECT (LIMIT pushBatchSize) that returns 0 rows
	// while the queue is idle, so a 2s cadence is negligible load.
	MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS: z.coerce
		.number()
		.int()
		.positive()
		.default(2_000),
	// Max queue rows drained per tick.  Bounds worst-case
	// per-tick latency.  Default 50.
	MORPHIT_RELAY_PUSH_BATCH_SIZE: z.coerce
		.number()
		.int()
		.min(1)
		.max(500)
		.default(50),
	// Max age for a pending push, in seconds.  Pushes older than
	// this are dropped instead of delivered — a "your order
	// filled" notification 6 hours after the fact is worse than
	// no notification.  Default 3600 (1h).
	MORPHIT_RELAY_PUSH_MAX_AGE_SECONDS: z.coerce
		.number()
		.int()
		.min(60)
		.default(3600),
	// Consecutive failures before a subscription is presumed
	// dead and deleted.  Default 5.
	MORPHIT_RELAY_PUSH_MAX_CONSECUTIVE_FAILURES: z.coerce
		.number()
		.int()
		.min(1)
		.max(50)
		.default(5),
	// Part 122 cp14 — when 'true' (default), /v1/push/subscribe
	// requires a valid posting-key signature over the canonical
	// message.  Set to 'false' to accept unsigned subscribes
	// (cp13-compat mode) — useful only for the brief window
	// during a frontend roll-forward.
	MORPHIT_RELAY_PUSH_REQUIRE_SIGNED: z
		.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
		.default('true')
		.transform((v) => v === 'true' || v === '1' || v === 'yes' || v === 'on')
});

export interface Config {
	readonly listenHost: string;
	readonly listenPort: number;
	readonly publicOrigin: string;
	readonly blurtRpcEndpoints: readonly string[];
	readonly relayAccount: string;
	/** WIF-formatted private key string. Present when the key
	 *  file is a plaintext WIF; undefined when the file is an
	 *  encrypted envelope and the relay hasn't been unlocked yet
	 *  (ADR-0010 §4). Consumers must not access this until after
	 *  unlockActiveKey() has resolved. NEVER log this, NEVER
	 *  include in an error message, NEVER serialize in a response
	 *  body. Held in process memory only. */
	readonly relayActiveKeyWif: string | undefined;
	/** When the key file is an encrypted v1 envelope, this is
	 *  the parsed JSON object awaiting decryption. Undefined
	 *  when the file was a plaintext WIF. Exactly one of
	 *  relayActiveKeyWif and relayActiveKeyEnvelope is defined. */
	readonly relayActiveKeyEnvelope: unknown | undefined;
	readonly allowedOrigins: readonly string[];
	readonly availabilityRatePerMin: number;
	readonly createRatePerHour: number;
	/** ADR-0010 §4 — long-window signup cap. Stacks on top of
	 *  createRatePerHour; both must pass. Default 2/day. */
	readonly createRatePerDay: number;
	readonly maxRequestBodyBytes: number;

	// ── Signup-drain prevention (layered defenses) ──
	readonly signupEnabled: boolean;
	readonly signupDailyCeiling: number;
	/** Optional path for persisting the daily-ceiling counter
	 *  across relay restarts (Audit 2026-05 Finding 5-4
	 *  hardening). When unset, the counter is in-memory only —
	 *  matches the historical behavior. When set, the counter
	 *  survives restarts so an attacker can't bypass the daily
	 *  cap by triggering a process restart. The persisted file
	 *  contains AGGREGATE counts only (no IPs, no user data).
	 *  Recommended location: a file under the relay's data dir,
	 *  e.g. `/var/lib/morphit/relay/daily-ceiling.json`. */
	readonly signupCeilingPersistPath: string | null;

	/** Data directory for runtime operator-actionable state
	 *  (kill-switch sentinel, future runtime flags).  When unset,
	 *  the kill-switch feature is disabled. */
	readonly dataDir: string | null;
	readonly createSpacingMinutes: number;
	readonly altchaTriggerCount: number;
	readonly altchaMaxnumber: number;
	readonly inviteHmacSecret: string | undefined;
	readonly altchaHmacSecret: string | undefined;

	/** Layer 7 — high-value name policy (see policy/highValueName.ts). */
	readonly highValueNamePolicy: 'strict' | 'moderate' | 'off';
	readonly highValueShortNameThreshold: number;

	/** Layer 8 — sequential signup detector. */
	readonly sequentialDetectorEnabled: boolean;
	readonly sequentialWindowMs: number;
	readonly sequentialThreshold: number;
	readonly sequentialMinPrefix: number;

	/** Trusted-proxy IPs / CIDR ranges that may set
	 *  X-Forwarded-For.  Default empty (loopback only).  See
	 *  configureTrustedProxies in middleware/ip.ts. */
	readonly trustedProxyIps: string;

	/** Postgres URL shared with the indexer — the relay reads
	 *  relay_pending_transfers here (ADR-0011 §8 queue drainer). */
	readonly databaseUrl: string;
	readonly queuePollIntervalMs: number;
	readonly queueBatchSize: number;
	readonly queueMaxRetries: number;

	readonly verboseHealth: boolean;

	/** Operator-tunable mirror of the chain's account_creation_fee
	 *  (currently 100 BLURT).  See env-schema doc for the three
	 *  ways this is consumed. */
	readonly accountCreationFeeBlurt: number;

	// ── Web Push (Part 122 cp13) ───────────────────────────────
	/** VAPID public key (base64url, ~88 chars).  Sent to clients
	 *  in pushManager.subscribe()'s applicationServerKey.  When
	 *  undefined, push is disabled at runtime. */
	readonly vapidPublicKey: string | undefined;
	/** VAPID private key (base64url, ~44 chars).  Used by the
	 *  web-push library to sign VAPID JWTs.  NEVER log, NEVER
	 *  serialize, NEVER include in error messages. */
	readonly vapidPrivateKey: string | undefined;
	/** VAPID subject (mailto:|https:// URL).  Identifies the
	 *  operator to push services per RFC 8292. */
	readonly vapidSubject: string | undefined;
	/** True iff all three VAPID fields are set — push subsystem
	 *  is active. */
	readonly pushEnabled: boolean;
	/** Push-sender worker polling interval (ms). */
	readonly pushPollIntervalMs: number;
	/** Max queue rows drained per tick. */
	readonly pushBatchSize: number;
	/** Max age (seconds) for a pending push before it's dropped. */
	readonly pushMaxAgeSeconds: number;
	/** Consecutive delivery failures before subscription is
	 *  presumed dead and deleted. */
	readonly pushMaxConsecutiveFailures: number;
	/** When true (default), the subscribe endpoint requires a
	 *  valid posting-key signature on every request.  When
	 *  false (cp13-compat), rate-limited-only.  Part 122 cp14. */
	readonly pushRequireSigned: boolean;
}

/** Config variant guaranteed to have the active-key WIF
 *  resolved. Produced by unlockActiveKey(); consumed by every
 *  component that broadcasts chain operations (create endpoint,
 *  queue drainer, mint script). Using this type instead of the
 *  base Config at those sites makes the type system enforce the
 *  "must unlock before use" invariant at compile time. */
export interface UnlockedConfig
	extends Omit<Config, 'relayActiveKeyWif' | 'relayActiveKeyEnvelope'> {
	readonly relayActiveKeyWif: string;
	readonly relayActiveKeyEnvelope: undefined;
}

/**
 * Load configuration from environment. Throws if any validation
 * constraint fails; the caller should let the exception kill the
 * process — this is a boot-time check, not a recoverable error.
 */
export function loadConfig(): Config {
	const parsed = envSchema.safeParse(process.env);
	if (!parsed.success) {
		const msg = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
		throw new Error(`Invalid relay configuration:\n${msg}`);
	}
	const env = parsed.data;

	// Validate the active-key file exists and has tight permissions.
	const keyPath = env.MORPHIT_RELAY_ACTIVE_KEY_FILE;
	let keyStat;
	try {
		keyStat = statSync(keyPath);
	} catch (err) {
		throw new Error(
			`MORPHIT_RELAY_ACTIVE_KEY_FILE ${JSON.stringify(keyPath)}: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
	}
	// Mode & 0o077 must be zero — no group or other permission bits.
	// (On Windows, stat mode is always lax; in that case skip the check.
	// Production deployments are Linux-only so this edge case is
	// developer-convenience only.)
	if (process.platform !== 'win32') {
		const mode = keyStat.mode & 0o777;
		if ((mode & 0o077) !== 0) {
			throw new Error(
				`MORPHIT_RELAY_ACTIVE_KEY_FILE ${JSON.stringify(
					keyPath
				)} has permissions 0${mode.toString(8)}; must be 0400 or 0600 ` +
					`(run: chmod 0400 ${keyPath})`
			);
		}
	}

	// Read the key file. The file may be either:
	//   (a) a plaintext WIF starting with '5' or 'K' (legacy / dev
	//       convenience), or
	//   (b) a v1 encrypted-key envelope starting with '{' (ADR-0010
	//       §4 passphrase-at-boot).
	// loadConfig is synchronous and can't prompt; (b) defers the
	// WIF materialization to main.ts via the envelope field.
	const rawKeyFile = readFileSync(keyPath, 'utf8').trim();
	if (rawKeyFile.length === 0) {
		throw new Error(`MORPHIT_RELAY_ACTIVE_KEY_FILE ${JSON.stringify(keyPath)} is empty`);
	}

	let wif: string | undefined;
	let keyEnvelope: unknown | undefined;
	if (looksLikeEnvelope(rawKeyFile)) {
		try {
			keyEnvelope = JSON.parse(rawKeyFile);
		} catch (err) {
			throw new Error(
				`MORPHIT_RELAY_ACTIVE_KEY_FILE ${JSON.stringify(keyPath)}: looks like an envelope but JSON.parse failed: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	} else {
		wif = rawKeyFile;
	}

	const blurtRpcEndpoints = splitTrim(env.MORPHIT_RELAY_BLURT_RPC);
	if (blurtRpcEndpoints.length === 0) {
		throw new Error('MORPHIT_RELAY_BLURT_RPC must list at least one endpoint');
	}
	for (const ep of blurtRpcEndpoints) {
		if (!ep.startsWith('https://') && !isHiddenServiceOrigin(ep)) {
			throw new Error(
				`MORPHIT_RELAY_BLURT_RPC entry ${JSON.stringify(ep)} must start with https:// ` +
					`(or http:// for a .onion/.i2p hidden service)`
			);
		}
	}

	const allowedOrigins = splitTrim(env.MORPHIT_RELAY_ALLOWED_ORIGINS);
	if (allowedOrigins.length === 0) {
		throw new Error('MORPHIT_RELAY_ALLOWED_ORIGINS must list at least one origin');
	}
	for (const o of allowedOrigins) {
		if (!o.startsWith('https://') && !o.startsWith('http://localhost') && !isHiddenServiceOrigin(o)) {
			throw new Error(
				`MORPHIT_RELAY_ALLOWED_ORIGINS entry ${JSON.stringify(o)} must be https:// ` +
					`(or http:// for a .onion/.i2p hidden service, or http://localhost for dev)`
			);
		}
	}

	return {
		listenHost: env.MORPHIT_RELAY_LISTEN_HOST,
		listenPort: env.MORPHIT_RELAY_LISTEN_PORT,
		publicOrigin: env.MORPHIT_RELAY_PUBLIC_ORIGIN,
		blurtRpcEndpoints,
		relayAccount: env.MORPHIT_RELAY_ACCOUNT,
		relayActiveKeyWif: wif,
		relayActiveKeyEnvelope: keyEnvelope,
		allowedOrigins,
		availabilityRatePerMin: env.MORPHIT_RELAY_AVAILABILITY_RATE_PER_MIN,
		createRatePerHour: env.MORPHIT_RELAY_CREATE_RATE_PER_HOUR,
		createRatePerDay: env.MORPHIT_RELAY_CREATE_RATE_PER_DAY,
		// 64 KiB — matches the Go version. Well above the ~4 KiB max for
		// a signed account-creation transaction and small enough to
		// reject large-body abuse before it hits zod parsing.
		maxRequestBodyBytes: 64 * 1024,

		// Signup-drain prevention (see env schema for rationale).
		signupEnabled: env.MORPHIT_RELAY_SIGNUP_ENABLED,
		signupDailyCeiling: env.MORPHIT_RELAY_SIGNUP_DAILY_CEILING,
		signupCeilingPersistPath: env.MORPHIT_RELAY_SIGNUP_CEILING_PERSIST_PATH ?? null,
		dataDir: env.MORPHIT_RELAY_DATA_DIR ?? null,
		createSpacingMinutes: env.MORPHIT_RELAY_CREATE_SPACING_MINUTES,
		altchaTriggerCount: env.MORPHIT_RELAY_ALTCHA_TRIGGER_COUNT,
		altchaMaxnumber: env.MORPHIT_RELAY_ALTCHA_MAXNUMBER,
		inviteHmacSecret: env.MORPHIT_RELAY_INVITE_HMAC_SECRET,
		altchaHmacSecret: env.MORPHIT_RELAY_ALTCHA_HMAC_SECRET,
		highValueNamePolicy: env.MORPHIT_RELAY_HIGHVALUE_NAME_POLICY,
		highValueShortNameThreshold: env.MORPHIT_RELAY_HIGHVALUE_SHORT_NAME_THRESHOLD,
		sequentialDetectorEnabled: env.MORPHIT_RELAY_SEQUENTIAL_DETECTOR_ENABLED,
		sequentialWindowMs: env.MORPHIT_RELAY_SEQUENTIAL_WINDOW_MS,
		sequentialThreshold: env.MORPHIT_RELAY_SEQUENTIAL_THRESHOLD,
		sequentialMinPrefix: env.MORPHIT_RELAY_SEQUENTIAL_MIN_PREFIX,
		trustedProxyIps: env.MORPHIT_RELAY_TRUSTED_PROXY_IPS,

		databaseUrl: env.MORPHIT_RELAY_DATABASE_URL,
		queuePollIntervalMs: env.MORPHIT_RELAY_QUEUE_POLL_INTERVAL_MS,
		queueBatchSize: env.MORPHIT_RELAY_QUEUE_BATCH_SIZE,
		queueMaxRetries: env.MORPHIT_RELAY_QUEUE_MAX_RETRIES,

		verboseHealth: env.MORPHIT_RELAY_VERBOSE_HEALTH,
		accountCreationFeeBlurt: env.MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT,

		// Web Push: enabled only when ALL three VAPID fields are set AND
		// the public key is a well-formed P-256 point. A malformed public
		// key can't produce a working subscription, so we treat push as
		// disabled (clean client message) rather than serving a bad key
		// that fails cryptically in every user's browser. main.ts logs a
		// clear operator warning for the set-but-invalid case.
		vapidPublicKey: env.MORPHIT_RELAY_VAPID_PUBLIC_KEY,
		vapidPrivateKey: env.MORPHIT_RELAY_VAPID_PRIVATE_KEY,
		vapidSubject: env.MORPHIT_RELAY_VAPID_SUBJECT,
		pushEnabled: Boolean(
			isValidVapidPublicKey(env.MORPHIT_RELAY_VAPID_PUBLIC_KEY) &&
				env.MORPHIT_RELAY_VAPID_PRIVATE_KEY &&
				isValidVapidSubject(env.MORPHIT_RELAY_VAPID_SUBJECT)
		),
		pushPollIntervalMs: env.MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS,
		pushBatchSize: env.MORPHIT_RELAY_PUSH_BATCH_SIZE,
		pushMaxAgeSeconds: env.MORPHIT_RELAY_PUSH_MAX_AGE_SECONDS,
		pushMaxConsecutiveFailures: env.MORPHIT_RELAY_PUSH_MAX_CONSECUTIVE_FAILURES,
		pushRequireSigned: env.MORPHIT_RELAY_PUSH_REQUIRE_SIGNED
	};
}

function splitTrim(s: string): string[] {
	return s
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);
}

/** A .onion / .i2p host is SELF-AUTHENTICATING — the network layer provides the
 *  encryption and the address IS the public key, so the service is served over
 *  plain `http://` with no TLS (a cert would be both pointless and impossible).
 *  Accept `http://` ONLY for those hosts; everything else must still be https. */
function isHiddenServiceOrigin(o: string): boolean {
	if (!o.startsWith('http://')) return false;
	try {
		const h = new URL(o).hostname.toLowerCase();
		return h.endsWith('.onion') || h.endsWith('.i2p');
	} catch {
		return false;
	}
}
