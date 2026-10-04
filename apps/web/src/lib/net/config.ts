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

/** The posting relay's own account. It pays the small Blurt network
 *  fee (an operation flat fee + a bandwidth fee, deducted from LIQUID
 *  BLURT — NOT mana; mana on Blurt is only voting power) on behalf of
 *  new users during account creation, and broadcasts signed ops they
 *  hand it. It never holds user private keys.
 *
 *  Registered 2026-04-18. */
export const MORPHIT_RELAY_ACCOUNT = 'morphit-relay';

/**
 * Posting public key of the canonical `@morphit` Blurt account.
 *
 * The browser's release check ($net/releaseFetch) accepts a
 * `morphit_release_v1` op only when the transaction that carries it, read
 * from the block that holds it, has a signature that recovers to this key. A node that serves a made-up op cannot produce that signature, so the
 * op is refused and its contents (release hashes, treasury addresses) are
 * never used.
 *
 * Source of truth: blocks.blurtwallet.com/#/@morphit. If @morphit ever
 * rotates this key, releases signed by the new key show as a trust-anchor
 * mismatch in clients that still pin the old one, until a release that pins
 * the new key ships.
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
 * the Blurt account-creation fee (in BLURT) for new users on their
 * behalf, without ever holding user private keys (see docs/adr/0006-security-posture-phase3a.md).
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
 * discovery, chat ciphertext). See docs/adr/0008-phase3b-indexer-architecture.md and
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
 * indexer (see docs/RUN-A-MORPHIT-NODE.md §5).
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
	// Empty string = same origin. Return the BARE origin with NO trailing
	// slash, so BOTH composition styles produce a single-slash URL:
	//   • `new URL('/v1/…', here)`        → https://host/v1/…   (documented)
	//   • `${here}/v1/…`  (string concat) → https://host/v1/…   (was the trap)
	// Previously this fell through to `${origin}${'/'}` = "https://host/",
	// and a string-concatenating consumer then produced "https://host//v1/…"
	// — a DOUBLE slash that a reverse proxy with `merge_slashes off`
	// (e.g. BunkerWeb) 404s, which made valid indexer reads (account-keys
	// existence check) read as "invalid". root-cause fix.
	if (originOrPath === '') {
		return window.location.origin;
	}
	// Window exists. Normalize the path so e.g. both '/relay' and
	// 'relay' work, and so we don't double-slash when appending.
	const path = originOrPath.startsWith('/') ? originOrPath : `/${originOrPath}`;
	return `${window.location.origin}${path}`;
}

/** The clearnet Blurt RPC nodes a BROWSER may contact directly.
 *
 *  Every chain read and write the app makes goes SAME-ORIGIN through the
 *  operator's indexer (`/v1/chain/condenser`, `/v1/broadcast`), so the
 *  visitor's IP never reaches a third party for those. The one exception is
 *  the release check ($net/releaseFetch): it exists to catch an operator
 *  serving a tampered build, so it must read the chain without the operator.
 *  This list (with the hidden tiers below) is that check's pool, chosen per
 *  page origin by `selectRpcPool` in ./endpoints.ts.
 *
 *  ⚠ This is the BROWSER-CORS-CLEAN SUBSET of the canonical pool, NOT the
 *  whole pool. The canonical source of truth is
 *  `DEFAULT_BLURT_RPC_ENDPOINTS` in `@morphit/operator-config` (6 nodes),
 *  which the indexer + relay use SERVER-side where CORS does not apply.
 *  A browser, however, can only use a node that returns a single valid
 *  `Access-Control-Allow-Origin`. Re-verified live 2026-07: FIVE of the six
 *  canonical nodes return a single valid `*` and are browser-usable —
 *  drakernoise, saboin, beblurt, dagobert, and blurt.blog. The one omission:
 *    • rpc.blurt.one — no valid `Access-Control-Allow-Origin`; stays
 *      SERVER-only until re-verified.
 *  Liveness is a SEPARATE axis from CORS, handled by the rotator's cooldown:
 *  a node that is temporarily down is skipped while cooling and used again on
 *  recovery, so it stays in this set. The rpc-endpoint-canon smoke enforces
 *  this list is a SUBSET of canon (no stray).
 *
 *  Order is NOT priority: the rotator shuffles it on each boot and then
 *  prefers nodes by measured latency and success.
 */
export const DEFAULT_RPC_ENDPOINTS: readonly string[] = [
	'https://rpc.drakernoise.com',
	'https://blurt-rpc.saboin.com',
	'https://rpc.beblurt.com',
	'https://blurtrpc.dagobert.uk',
	'https://rpc.blurt.blog'
] as const;

/** The public hidden-rpc nodes (git.agorise.net/agorise/hidden-rpc), in
 *  @morphit/operator-config's order. Each node answers on a `.onion` AND a
 *  `.b32.i2p` address; both addresses are ONE operator (see
 *  `HIDDEN_RPC_OPERATORS`), which matters when the release check asks two
 *  operators. Operators are counted by node name; nothing proves two names
 *  are independent parties (the default hidden nodes are run by the project). */
const HIDDEN_RPC_NODE_NAMES: readonly string[] = [
	'Star',
	'Jade',
	'kc',
	'oldpc',
	'mama',
	'j2',
	's2'
];

/** The `.onion` half of @morphit/operator-config's
 *  DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS, same order — the release check's pool
 *  on a `.onion` page (Tor Browser reaches these directly).
 *  apps/web/scripts/hidden-rpc-browser-tier-canon-smoke.ts
 *  pins the match, and the `.onion` CSP connect-src in
 *  ops/bunkerweb/frontend/nginx.conf must list the same origins
 *  (scripts/csp-header-consistency-smoke.ts). */
export const DEFAULT_HIDDEN_RPC_ENDPOINTS: readonly string[] = [
	// Star
	'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091',
	// Jade
	'http://axj4qkjwk3bwh2lrn4bud5rrgsyrvuamd6jxdlmks6flsrju7q5rb5yd.onion:8091',
	// kc
	'http://xpqyoeap42iwmi6c6ew6svvtv2qwnkrbxpcshqitwmb3z2jqcvjb2nid.onion:8091',
	// oldpc
	'http://iarstejtiqofqs7hamflujy3fjwitxfoyysj6cngwpzdzermwm6hteid.onion:8091',
	// mama
	'http://lr444djiignckmq3y2mhl2zplcy7lwxfxamv2irc2lt5jpmfybshhzid.onion:8091',
	// j2
	'http://ukbumluqrinql6dw7l2mbtdioygodnrloob22cqfa4tvl3pspn5qzhid.onion:8091',
	// s2
	'http://qci6a2fsuljqk2q3coeyqiipmzv3yqykvgibbktt6fcojysl2yw3gaad.onion:8091'
] as const;

/** The `.b32.i2p` half of the same nodes, same order — the release check's
 *  pool on an `.i2p` page. A visitor on an I2P site is by definition using an
 *  I2P proxy, which routes `.b32.i2p` and cannot route `.onion` (a separate
 *  network), so an `.i2p` page gets these and nothing else. The `.i2p` CSP
 *  connect-src must list the same origins. */
export const DEFAULT_I2P_RPC_ENDPOINTS: readonly string[] = [
	// Star
	'http://zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa.b32.i2p:8091',
	// Jade
	'http://7tea4n3co3q2ozke2ovgqn7j5zirkauxipfttudbhthkat6fzlcq.b32.i2p:8091',
	// kc
	'http://xenmlfwajcaiavtt24a3lwzzjiv4pgvfjaps4etlpvgmvupvvcea.b32.i2p:8091',
	// oldpc
	'http://5cfk2jmub7gnte536sxezapgkykirje6v6omouhpymfo52eh473a.b32.i2p:8091',
	// mama
	'http://jtkaeepcpj2gfgv7swwnplffpu4zpf37bojtpigyrii5glwmrd6q.b32.i2p:8091',
	// j2
	'http://ogmildopmgbdyy2kc724ezhrnmvhnf2x52qw7lqgo2jna5juc3kq.b32.i2p:8091',
	// s2
	'http://5jsepybvuw66r4e7xejv26r67ewoimtmx3iwedpflh7a2t5y66sa.b32.i2p:8091'
] as const;

/** Hidden endpoint URL → the node (operator) behind it. A node's `.onion` and
 *  `.b32.i2p` map to the same name, so the release check's second node is
 *  always another operator's. Clearnet nodes are told apart by hostname
 *  (./endpoints.ts `rpcOperatorOf`). */
export const HIDDEN_RPC_OPERATORS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries([
		...DEFAULT_HIDDEN_RPC_ENDPOINTS.map((u, i) => [u, HIDDEN_RPC_NODE_NAMES[i] ?? u]),
		...DEFAULT_I2P_RPC_ENDPOINTS.map((u, i) => [u, HIDDEN_RPC_NODE_NAMES[i] ?? u])
	])
);

/** The canonical Blurt RPC node(s) the indexer + relay use SERVER-side but a
 *  browser cannot reach (no valid CORS — see the omission note on
 *  DEFAULT_RPC_ENDPOINTS above). Listed here ONLY so the endpoint-settings
 *  panel can show the operator the COMPLETE canonical pool (the browser-
 *  reachable nodes above + these) and explain why the browser can't probe
 *  them — they are never added to the rotator.
 *
 *  Invariant: DEFAULT_RPC_ENDPOINTS ∪ SERVER_ONLY_CANONICAL_RPC_ENDPOINTS
 *  === the 6-node canonical pool (`DEFAULT_BLURT_RPC_ENDPOINTS` in
 *  `@morphit/operator-config`), with the two sets disjoint. The
 *  rpc-endpoint-canon smoke enforces this so the split can't drift. */
export const SERVER_ONLY_CANONICAL_RPC_ENDPOINTS: readonly string[] = [
	'https://rpc.blurt.one'
] as const;

/** localStorage key that once held a user-edited endpoint list. Nothing reads
 *  it any more (the custom-endpoint setting was removed); the name is kept so
 *  the storage classification still covers a value an older build left. */
export const ENDPOINTS_STORAGE_KEY = 'morphit.rpcEndpoints';

/** Morphit-specific `custom_json` op ids, all versioned with a `_vN`
 *  suffix so indexers can evolve schemas without breaking old payloads. */
export const OP_IDS = {
	profile: 'morphit_profile_v1',
	order: 'morphit_order_v1',
	orderReplace: 'morphit_order_replace_v1',
	orderCancel: 'morphit_order_cancel_v1',
	orderComplete: 'morphit_order_complete_v1',
	feedback: 'morphit_feedback_v1',
	feedbackResponse: 'morphit_feedback_response_v1',
	chatMessage: 'morphit_chat_v1',
	chatIdentity: 'morphit_chat_identity_v1',
	chatRead: 'morphit_chat_read_v1',
	chatFolders: 'morphit_chat_folders_v1',
	settings: 'morphit_settings_v1',
	releaseDiscovery: 'morphit_release_v1',
	rpcDirectory: 'morphit_rpc_v1',
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
 *  - `'dblurt'` (default): @beblurt/dblurt's own signer.  dblurt 0.17
 *    itself signs with @noble/secp256k1 (RFC 6979 with extra entropy,
 *    canonical-signature loop); `elliptic` is not in the dependency tree.
 *  - `'noble'`: Morphit's direct @noble/secp256k1 signer over the same
 *    digest (nobleSigner.ts; already this app's keygen library).  Proven
 *    equivalent for chain acceptance — the chain verifies by public-key
 *    recovery, and these signatures recover to the correct key under
 *    dblurt's own verifier (scripts/blurt-noble-signer-recovery-proof.ts:
 *    300/300).  See ADR-0046.
 *
 *  Both use the same curve library, so the choice is about which code path
 *  emits the signature, not about a vulnerable dependency.  Both reuse
 *  dblurt's serializer + chain-id binding to compute the digest. */
export const SIGNER_BACKEND: 'dblurt' | 'noble' = 'dblurt';
