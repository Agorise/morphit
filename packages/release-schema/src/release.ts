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
	/** cp372 — chain-pinned BLURT listing-fee base (tier-1 amount,
	 *  before the Sybil multiplier).  Unlike BTC/XMR there is no
	 *  address: the BLURT fee is a transfer to the operator's fee
	 *  recipient account, so only the amount needs pinning.  Pinning
	 *  it on-chain makes the BLURT floor deterministic across every
	 *  federated indexer (the same anti-fork property the BTC/XMR
	 *  amounts already had); before cp372 it was an env-only per-
	 *  operator value, the one fee input that could diverge between
	 *  nodes.  Optional + nullable: releases without it (pre-cp372, or
	 *  operators who never pin BLURT) leave every indexer on its env
	 *  fallback (`MORPHIT_INDEXER_FEE_BASE_BLURT`).  The maintainer's
	 *  release-broadcaster auto-computes this from the canonical USD
	 *  target ÷ live price, so operators never hand-tune it. */
	readonly blurt?: {
		/** Tier-1 listing-fee base, in whole BLURT (3-decimal
		 *  precision, e.g. 62.5).  Positive, finite. */
		readonly base: number;
	} | null;
}

/**
 * Decentralized-distribution anchor (cp556).
 *
 * The project's source is public on Forgejo (git.agorise.net), but a
 * single git host is a single point of failure and censorship. This
 * block lets `@morphit` anchor, ON CHAIN, a verifiable pointer to the
 * SAME GPG-signed source tarball mirrored to independent hosts —
 * Codeberg, IPFS, etc. — so anyone can obtain the code from whatever
 * host is reachable and PROVE it is the unmodified release.
 *
 * The tarball + signatures are produced by `scripts/release-sign.sh`
 * (`git archive` from the tagged commit → `morphit-vX.Y.Z-source.tar.gz`
 * + `.sha256` + `.asc`). The verifier `scripts/verify-download.mjs`
 * reads THIS block from the chain (via RPC, never the indexer — same
 * anti-circularity rule as the rest of the release op) and checks a
 * downloaded tarball against it. See docs/VERIFY-YOUR-DOWNLOAD.md.
 *
 * Every field is public + verification-only. Nothing secret is ever
 * placed here (same invariant as the treasury block: the XMR view key
 * and any signing WIF are NEVER chain-pinned).
 *
 * The whole block is OPTIONAL + omittable — releases cut before the
 * mirror/pin steps ran carry no distribution block, and clients simply
 * have nothing extra to cross-check (the hash_manifest still guards the
 * running bundle regardless).
 */
export interface ReleaseDistributionBlock {
	/** Lowercase-hex SHA-256 of the signed source tarball
	 *  (`morphit-vX.Y.Z-source.tar.gz`), exactly as `sha256sum` prints
	 *  it. 64 hex chars. A downloader runs `sha256sum` on their copy
	 *  and compares — a mirror that served altered bytes fails here. */
	readonly source_sha256: string;
	/** Fingerprint of the GPG public key that signed the release, so a
	 *  downloader knows WHICH key's signature to trust — and, because
	 *  the fingerprint is itself anchored on-chain by @morphit, a
	 *  hostile mirror can't swap in its own key + re-sign. 40 hex
	 *  chars (v4 SHA-1 fingerprint) or 64 (v5 SHA-256), case-insensitive,
	 *  spaces allowed and normalized out. */
	readonly gpg_fingerprint: string;
	/** OPTIONAL IPFS CID of the same signed tarball (or a directory
	 *  holding it + its `.asc`). Content-addressed: the CID IS the
	 *  hash, so no gateway can serve altered bytes under it. CIDv0
	 *  (`Qm…`, base58) or CIDv1 (`baf…`, base32). Omitted until the
	 *  bytes are actually pinned. */
	readonly ipfs_cid?: string;
	/** OPTIONAL independent download mirrors (`https://…`) carrying the
	 *  SAME signed bytes — a Codeberg release asset, an IPFS gateway,
	 *  etc. Bounded list; recommendations, not mandates. */
	readonly mirrors?: readonly string[];
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
	/** cp436 — OPTIONAL announced endpoint pools. Ken's rule: normal
	 *  releases OMIT this entirely (it bloats the chain and is redundant
	 *  with the frontend's baked-in DEFAULT_BLURT_RPC_ENDPOINTS). When
	 *  absent, clients keep whatever endpoints they already have. */
	readonly endpoints?: ReleaseEndpoints;
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
	/** cp556 — OPTIONAL decentralized-distribution anchor: a
	 *  verifiable pointer to the GPG-signed source tarball mirrored
	 *  to Codeberg / IPFS / etc.  See ReleaseDistributionBlock. */
	readonly distribution?: ReleaseDistributionBlock;
}
