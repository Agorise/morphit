/**
 * Morphit — release-discovery op schema.
 *
 * The `morphit` account publishes a `morphit_release_v1` custom_json op
 * on Blurt whenever the project ships a new release.  Clients fetch
 * the latest such op (via chain RPC, NOT via indexer — the indexer's
 * trust would be circular here), verify it was signed by the pinned
 * `MORPHIT_OFFICIAL_POSTING_PUBKEY` (see `$net/config.ts`), and use
 * its contents to:
 *
 *   • Check for updates (running version vs. announced version).
 *   • Refresh the endpoint registry (relay, indexer, avatar server).
 *   • Cross-verify the SHA-256 of the running bundle against the
 *     signed hash manifest, so a compromised CDN host can't silently
 *     serve malware.
 *
 * Schema is what the indexer's `morphit_release_v1` handler accepts
 * (apps/indexer/src/indexer/handlers/release.ts).  The two MUST stay
 * in sync — the frontend has its own validator that rejects any
 * payload the indexer would also reject, plus its own trust-anchor
 * pubkey check.  Frontend is paranoid; the indexer doing one round
 * of verification doesn't excuse skipping it client-side.
 */

/**
 * SHA-256 hash manifest for a release.  Keys are asset paths
 * relative to the web root (e.g. `"index.html"`,
 * `"_app/immutable/start-abc123.js"`).  Values are base64-encoded
 * SHA-256 digests prefixed with `sha256-` (Subresource-Integrity-
 * compatible format).
 *
 * Verification is opt-in per asset: any asset listed in the
 * manifest is checked; assets not listed are unchecked (they'll
 * still be served, but tamper-detection doesn't apply to them).
 * In practice the manifest covers index.html and the JS/CSS
 * bundles; image and font assets aren't worth the verify cost.
 */
export interface ReleaseHashManifest {
	readonly [assetPath: string]: string;
}

/**
 * Endpoint lists announced as the canonical community pool for each
 * service tier.  Each list is an array of origin URLs.  Clients may
 * merge these with user-configured endpoints; they are
 * recommendations, not mandates.
 */
export interface ReleaseEndpoints {
	/** Posting relays that accept signed ops on behalf of users. */
	readonly relay?: readonly string[];
	/** Indexers that serve the orderbook REST + RSS APIs. */
	readonly indexer?: readonly string[];
	/** Avatar image servers, each accepting `GET /avatars/{pubkey}`. */
	readonly avatar?: readonly string[];
	/** Blurt RPC endpoints for chain reads.  These are for
	 *  bootstrap / fallback; the running app already has a list
	 *  baked in. */
	readonly blurt?: readonly string[];
}

/**
 * Treasury chain-pin (Part 106; corrected Part 107).
 *
 * When present in a `morphit_release_v1` payload, the treasury
 * block declares the canonical Morphit BTC and/or XMR fee
 * addresses authoritatively, signed by the @morphit posting
 * key via the same trust anchor that gates the rest of the
 * release op.
 *
 * Either chain may be `null` inside the object — operators can
 * pin one chain at a time.  The whole `treasury` field is
 * optional on `ReleasePayloadV1` (older releases predate Part
 * 106 and have no treasury pin; their indexers fall back to
 * env-var values).
 *
 * **Privacy invariant (Part 107):** the chain-pinned `treasury`
 * block carries ONLY public information — the address and the
 * fee amount.  The Monero PRIVATE view key is NEVER chain-
 * pinned, never surfaced in any API response, never published
 * in any form.  Initial Part 106 design embedded the view key
 * here under the rationale that "it's publish-safe by Monero
 * design"; that framing was wrong for privacy (publishing the
 * view key reveals every incoming payment, amount, timing, and
 * subaddress to the treasury wallet, forever).  Part 107
 * removes the view key from this block.  Each operator's
 * indexer holds the view key locally in its env config and
 * uses it ONLY in-memory for verification.  Community
 * operators who can't access the canonical view key cannot
 * independently verify XMR payments — they trust canonical's
 * federated verdict, run their own treasury, or disable XMR
 * fee acceptance.  See docs/adr/0011-dynamic-fee-model.md
 * Part 107 amendment for the full rationale.
 *
 * See docs/OPERATIONS.md §40 for the operator ceremony.
 */
export interface ReleaseTreasuryBlock {
	readonly btc: {
		/** Mainnet Bitcoin address.  Native segwit (`bc1q...`),
		 *  legacy (`1...`), or P2SH (`3...`).  Testnet rejected
		 *  by the validator. */
		readonly address: string;
		/** Listing fee amount in satoshis.  Positive integer. */
		readonly satoshis: number;
	} | null;
	readonly xmr: {
		/** Mainnet Monero address — primary (95 chars, starts
		 *  with `4`) or subaddress (95 chars, starts with `8`).
		 *  Testnet/stagenet rejected by the validator. */
		readonly address: string;
		/** Listing fee amount in piconero.  String-encoded
		 *  because typical values exceed Number.MAX_SAFE_INTEGER
		 *  for large fees. */
		readonly piconero: string;
	} | null;
}

/**
 * The full `morphit_release_v1` op body.  Serialized as JSON into
 * the `json` field of a Blurt `custom_json` operation authored by
 * `@morphit` and signed with its posting key.
 *
 * Field names match the indexer's canonical schema.  Older versions
 * of this file used different names (`release`, `hashes`, `notes`);
 * those were speculative and were never broadcast on chain.  The
 * indexer's shape (validated since Phase 3a) is authoritative.
 */
export interface ReleasePayloadV1 {
	/** Human-readable release version.  Loose semver:
	 *  major.minor.patch with optional pre-release / build suffix.
	 *  Indexer enforces `/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/`. */
	readonly version: string;
	/** SHA-256 hash manifest of the build's assets. */
	readonly hash_manifest: ReleaseHashManifest;
	/** Announced endpoint pools.  May be empty `{}` if the
	 *  operator wants to retain whatever clients already have. */
	readonly endpoints: ReleaseEndpoints;
	/** Optional secondary signature (PGP, etc.) — opaque to the
	 *  indexer, available to clients that want to do extra
	 *  verification.  Bounded at 512 chars. */
	readonly signature?: string;
	/** Optional treasury pin (Part 106).  When present, declares
	 *  the canonical BTC/XMR fee addresses authoritatively.
	 *  Frontend renders the address with copy + QR on the post-
	 *  order page; every federated indexer uses these addresses
	 *  for fee verification.  See ReleaseTreasuryBlock. */
	readonly treasury?: ReleaseTreasuryBlock;
}
