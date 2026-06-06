/**
 * Morphit — network configuration.
 *
 * Single source of truth for environment-specific constants: Blurt account
 * names, the canonical Morphit posting pubkey for release-op verification,
 * RPC endpoints, relay origin, op namespaces. Everything in here is known
 * to the code by import, never hardcoded elsewhere.
 *
 * As of Phase 3a kickoff (2026-04-18), `MORPHIT_ACCOUNT` and
 * `MORPHIT_RELAY_ACCOUNT` are no longer placeholders — both are registered
 * on Blurt mainnet.
 */

export const NETWORK = 'blurt-mainnet';

/** Morphit's own account on Blurt — used for on-chain announcements
 *  (release-discovery ops, authoritative endpoint list, etc.). Writes
 *  from this account are signed by the project operator only.
 *
 *  Registered 2026-04-18. */
export const MORPHIT_ACCOUNT = 'morphit';

/** The posting relay's own account. It spends Mana (Blurt's
 *  transaction fuel) on behalf of new users during account creation,
 *  and broadcasts signed ops they hand it. It never holds user
 *  private keys.
 *
 *  Registered 2026-04-18. */
export const MORPHIT_RELAY_ACCOUNT = 'morphit-relay';

/**
 * Posting public key of the canonical `@morphit` Blurt account.
 *
 * Used by the client to verify the signer of `morphit_release_v1`
 * release-discovery ops. If a malicious or compromised RPC node
 * serves a forged release op, this pubkey's signature check fails
 * and the client ignores the op rather than trusting its contents
 * (endpoint list, release hashes, etc.).
 *
 * Source of truth: blocks.blurtwallet.com/#/@morphit. If the operator
 * ever rotates this key, the rotation itself is a signed on-chain
 * `account_update` op that older clients can follow; this constant
 * gets updated in a coordinated release.
 *
 * This value is NON-SENSITIVE — posting pubkeys are public by design,
 * visible on every op the account has ever signed.
 */
export const MORPHIT_OFFICIAL_POSTING_PUBKEY =
	'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9';

/**
 * Base location of Morphit's posting relay service.
 *
 * The relay is a small service on the operator's VPS that pays
 * Blurt RC for new-user account creation on behalf of the user,
 * without ever holding user private keys (see PHASE-3a-DESIGN.md).
 *
 * Default is a same-origin relative path ('/relay') assuming
 * the colocated topology documented in OPERATIONS.md §14: nginx
 * on the public hostname reverse-proxies `/relay/*` to the
 * relay bound to loopback. In that topology the relay needs NO
 * DNS record of its own and the frontend's Origin header
 * automatically matches the public hostname — making
 * MORPHIT_RELAY_ALLOWED_ORIGINS setup trivial.
 *
 * Operators running a split topology (relay on a distinct
 * subdomain like `relay.example.com`) can override to an
 * absolute URL. Both forms are supported — resolveOrigin()
 * normalizes them into a full URL at fetch time.
 *
 * If set to an absolute URL, it must be included in the
 * frontend's CSP `connect-src` directive. Same-origin
 * relative paths are covered by `'self'` automatically.
 */
export const MORPHIT_RELAY_ORIGIN = '/relay';

/**
 * Base location for the Morphit indexer — the read-only HTTP
 * API that exposes queryable state derived from on-chain
 * `morphit_*` ops (orderbook, profiles, feedback, release
 * discovery, chat ciphertext). See docs/PHASE-3b-DESIGN.md and
 * ADR-0008.
 *
 * The indexer is public-read, no authentication; every response
 * includes `Cache-Control: max-age=3` which matches the
 * indexer's chain-polling cadence.
 *
 * This is a BUILD-TIME constant (the bundle reads no runtime
 * env — vite bakes only `__MORPHIT_VERSION__`). As shipped it is
 * the empty string = same origin, which is correct for the
 * colocated single-host topology where one reverse proxy serves
 * the SPA and proxies `/v1/*` and `/rss/*` to the loopback-bound
 * indexer (see docs/RUN-A-MORPHIT-NODE.md §8).
 *
 * Operators running a split topology (indexer on its own
 * subdomain like `indexer.example.com`) set this to that
 * absolute URL and rebuild, and must add the origin to the
 * frontend CSP `connect-src` (see ops/nginx/web.conf).
 *
 * IMPORTANT — only the *origin* (scheme + host + port) of this
 * value is ever used. Every consumer composes requests as
 * `new URL('/v1/...', resolveOrigin(MORPHIT_INDEXER_ORIGIN))`,
 * and a root-absolute first arg discards any path on the base.
 * A stray path here (e.g. the old '/api/indexer') is therefore
 * silently dropped — but it WAS a trap for SSE/RSS/view builders
 * that string-concatenated the origin (those now use new URL
 * too). Do not reintroduce a path: keep this '' or a bare
 * absolute URL with no path.
 */
export const MORPHIT_INDEXER_ORIGIN = '';

/**
 * Resolve a configured origin (which may be a relative path or
 * an absolute URL) into an absolute URL suitable for fetch()
 * or `new URL(path, base)`.
 *
 * - Absolute URLs (`https://...`, `http://...`) return unchanged.
 * - Anything else is treated as a path on the current page's
 *   origin, resolved against `window.location.origin`.
 *
 * Must be called at fetch time, not at module load. If called
 * during prerender/SSR with a relative origin, `window` is
 * undefined and this function throws a clear error rather than
 * producing a broken URL silently.
 */
export function resolveOrigin(originOrPath: string): string {
	if (/^https?:\/\//i.test(originOrPath)) {
		return originOrPath;
	}
	if (typeof window === 'undefined') {
		throw new Error(
			`resolveOrigin(${JSON.stringify(originOrPath)}) called without window — ` +
				'relative origins can only be resolved in the browser. ' +
				'Move this call into an event handler, onMount, or similar.'
		);
	}
	// Window exists. Normalize the path so e.g. both '/relay' and
	// 'relay' work, and so we don't double-slash when appending.
	const path = originOrPath.startsWith('/') ? originOrPath : `/${originOrPath}`;
	return `${window.location.origin}${path}`;
}

/** Default Blurt RPC endpoints seeded into every client. The endpoint-
 *  rotation client (`$lib/net/endpoints.ts`) health-checks each, picks a
 *  live one, and fails over when requests error. Users can add / pin /
 *  remove entries in Settings.
 *
 *  Sources as of 2026-04:
 *    • rpc.blurt.blog      — Blurt Foundation
 *    • blurt-rpc.saboin.com — Witness @saboin
 *    • rpc.beblurt.com      — BeBlurt frontend's node
 *    • rpc.blurt.one        — Witness @tekraze
 *
 *  Order is NOT priority. The rotator picks based on measured round-trip
 *  latency + success rate; first-probe order is randomized on each boot
 *  so the default pool doesn't centralize load on whichever appears
 *  first in this list.
 */
export const DEFAULT_RPC_ENDPOINTS: readonly string[] = [
	'https://rpc.blurt.blog',
	'https://blurt-rpc.saboin.com',
	'https://rpc.beblurt.com',
	'https://rpc.blurt.one'
] as const;

/** localStorage key under which the user's (possibly-modified) endpoint
 *  list is persisted. If missing, DEFAULT_RPC_ENDPOINTS is used. */
export const ENDPOINTS_STORAGE_KEY = 'morphit.rpcEndpoints';

/** Morphit-specific `custom_json` op ids, all versioned with a `_vN`
 *  suffix so indexers can evolve schemas without breaking old payloads. */
export const OP_IDS = {
	profile: 'morphit_profile_v1',
	order: 'morphit_order_v1',
	orderReplace: 'morphit_order_replace_v1',
	orderCancel: 'morphit_order_cancel_v1',
	feedback: 'morphit_feedback_v1',
	feedbackResponse: 'morphit_feedback_response_v1',
	chatMessage: 'morphit_chat_v1',
	chatIdentity: 'morphit_chat_identity_v1',
	chatRead: 'morphit_chat_read_v1',
	releaseDiscovery: 'morphit_release_v1',
	feeAttest: 'morphit_fee_attest_v1',
	featureBid: 'morphit_feature_bid_v1',
	operatorRegister: 'morphit_operator_register_v1',
	block: 'morphit_block_v1',
	/** Operator-instance block.  Item 3 — the operator account
	 *  signs this op to mark a user as blocked on this instance.
	 *  The blocked user's listings are filtered out of the
	 *  operator's orderbook view; the user can still operate
	 *  unaffected on other instances.  See ADR-0018. */
	operatorBlock: 'morphit_operator_block_v1',
	/** Operator-instance payment-method addition.  ADR-0021 —
	 *  operators broadcast region-specific payment methods that
	 *  augment (but cannot override or remove) the canonical
	 *  registry.  Keys are stored on chain in the order's
	 *  `payment_methods` array prefixed `@instance:` so cross-
	 *  instance filtering can detect them. */
	operatorPaymentMethod: 'morphit_payment_method_addition_v1',
	strangerFee: 'morphit_stranger_fee_v1'
} as const;

export type MorphitOpId = (typeof OP_IDS)[keyof typeof OP_IDS];

/** How long to wait for an RPC response before giving up on an endpoint,
 *  in milliseconds. Short because the failover is cheap and a slow
 *  endpoint is worse than no endpoint for UX. */
export const RPC_TIMEOUT_MS = 8_000;

/** How many recent RPC failures trigger demotion of an endpoint in the
 *  rotation priority. */
export const RPC_MAX_CONSECUTIVE_FAILURES = 3;

/** Upper bound on how many endpoints the rotation will try before giving
 *  up a single call. Prevents a bad-weather scenario from turning into a
 *  multi-minute retry cascade on the user's screen. */
export const RPC_MAX_RETRIES_PER_CALL = 3;

/** Which library performs the secp256k1 ECDSA when signing Blurt
 *  transactions.
 *
 *  - `'dblurt'` (default): @beblurt/dblurt's bundled signer, which uses
 *    `elliptic`.  Battle-tested against the live chain, but `elliptic` is
 *    unmaintained and carries CVE-2025-14505 (see docs/SECURITY.md).
 *  - `'noble'`: a @noble/secp256k1-based signer (constant-time, maintained;
 *    already this app's keygen library).  Proven equivalent for chain
 *    acceptance — the chain verifies by public-key recovery, and noble
 *    signatures recover to the correct key under dblurt's own verifier
 *    (scripts/blurt-noble-signer-recovery-proof.ts: 300/300).  See ADR-0046.
 *
 *  DEFAULT IS `'dblurt'` ON PURPOSE.  Flipping to `'noble'` is gated on a
 *  real Blurt chain broadcast confirming end-to-end acceptance, which can't
 *  be done in a code-review sandbox.  Both paths reuse dblurt's serializer +
 *  chain-id binding to compute the digest, so the only difference is which
 *  library runs the ECDSA over that identical digest. */
export const SIGNER_BACKEND: 'dblurt' | 'noble' = 'dblurt';
