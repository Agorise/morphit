/**
 * Morphit — release-payload validator.
 *
 * Pure: takes any JSON value, returns a `ReleasePayloadV1` (narrowed)
 * or a typed error.  Mirrors the indexer's
 * `apps/indexer/src/indexer/handlers/release.ts` `validate()` rules.
 *
 * The frontend revalidates client-side because:
 *
 *   • An indexer the user trusts could be compromised; we can't
 *     tell, so we re-check what we can re-check independently.
 *   • The chain-direct fetch path (`releaseFetch.ts`) returns the
 *     raw payload — it's just the JSON the chain stored.  We have
 *     to validate it before treating any field as authoritative.
 *
 * Smoke-testable.  No I/O, no DOM.
 */

import type { ReleasePayloadV1 } from './release.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

/** Loose-but-not-permissive cap on hash-manifest size.  Mirrors the
 *  indexer's checkJsonbSize ceiling.  64 KB serialized is a generous
 *  ceiling: a typical web app has dozens of bundles, hundreds of
 *  asset paths at the upper end.  Each entry is roughly
 *  `"path/...": "sha256-..."` ~ 80–120 bytes.
 *
 *  cp430: this was 64 KB, but the indexer stores each field in a
 *  JSONB column capped at MAX_JSONB_BYTES = 4096 (apps/indexer/src/
 *  indexer/payloadSize.ts), so the HANDLER rejects any manifest over
 *  4096 as `hash_manifest_too_large` — regardless of what the builder
 *  accepted.  A 64 KB manifest here therefore built + broadcast fine
 *  but was silently filed `valid=false` by the indexer.  These caps
 *  now MIRROR the handler's 4096 so the builder fails loudly, up front.
 *  ~4 KB ≈ 40 entries — the on-chain manifest is a tamper-critical
 *  SUBSET (shell + entry + service worker); full per-file coverage is
 *  the served /verify.json. */
const MANIFEST_MAX_SERIALIZED_BYTES = 4096;

/** Same cap on endpoints, mirroring the indexer's per-field JSONB
 *  limit (a handful of URLs is well under it). */
const ENDPOINTS_MAX_SERIALIZED_BYTES = 4096;

const SIGNATURE_MAX_LEN = 512;

export type ReleaseValidateError =
	| 'payload_not_object'
	| 'version_not_string'
	| 'version_not_semver'
	| 'hash_manifest_not_object'
	| 'hash_manifest_too_large'
	| 'hash_manifest_entry_invalid'
	| 'endpoints_not_object'
	| 'endpoints_too_large'
	| 'endpoints_entry_invalid'
	| 'signature_not_string'
	| 'signature_too_long'
	// Part 106 — treasury chain-pin validation reasons.  Mirror
	// the indexer's `validateTreasury()` reasons in
	// apps/indexer/src/indexer/handlers/release.ts.
	//
	// Part 107 (privacy correction): the XMR private view key
	// is no longer chain-pinned.  Validation reasons related
	// to the viewkey (treasury_xmr_viewkey_missing,
	// treasury_xmr_viewkey_not_hex64) were removed because the
	// validator no longer accepts a `viewkey` field — any
	// `viewkey` value present in the input is silently ignored
	// (forward-compat for any historical release op that
	// included one before Part 107).
	| 'treasury_not_object'
	| 'treasury_too_large'
	| 'treasury_btc_not_object'
	| 'treasury_btc_address_missing'
	| 'treasury_btc_address_too_long'
	| 'treasury_btc_address_not_mainnet'
	| 'treasury_btc_satoshis_invalid'
	| 'treasury_btc_satoshis_too_large'
	| 'treasury_xmr_not_object'
	| 'treasury_xmr_address_missing'
	| 'treasury_xmr_address_not_mainnet'
	| 'treasury_xmr_piconero_invalid'
	| 'treasury_xmr_piconero_too_large'
	| 'treasury_blurt_not_object'
	| 'treasury_blurt_base_invalid'
	| 'treasury_blurt_base_too_large'
	// cp556 — decentralized-distribution anchor validation reasons.
	// Mirror the indexer's `validateDistribution()` reasons in
	// apps/indexer/src/indexer/handlers/release.ts exactly.
	| 'distribution_not_object'
	| 'distribution_too_large'
	| 'distribution_source_sha256_invalid'
	| 'distribution_gpg_fingerprint_invalid'
	| 'distribution_ipfs_cid_invalid'
	| 'distribution_mirrors_not_array'
	| 'distribution_mirror_invalid';

export type ReleaseValidateResult =
	| { ok: true; value: ReleasePayloadV1 }
	| { ok: false; reason: ReleaseValidateError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Subresource-Integrity-style hash format check. */
const SHA256_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** Mainnet-only Bitcoin address shape.  bech32 (`bc1...`),
 *  legacy (`1...`), P2SH (`3...`).  Testnet `tb1`, `m`, `n`
 *  rejected.  Length-bounded. */
const BTC_MAINNET_ADDRESS_RE = /^(bc1[a-z0-9]+|[13][1-9A-HJ-NP-Za-km-z]+)$/;
const BTC_ADDRESS_MAX_LEN = 100;
/** Sanity ceiling on a single-listing fee amount.  Mirrors the
 *  indexer's check.  1000 BTC per listing is absurd. */
const BTC_SATOSHIS_MAX = 100_000_000_000;

/** Mainnet Monero — primary (`4...`) or subaddress (`8...`),
 *  exactly 95 chars total.  Testnet (`9`/`B`) and stagenet
 *  (`5`/`7`) rejected. */
const XMR_MAINNET_ADDRESS_RE = /^[48][0-9A-Za-z]{94}$/;
/** Piconero amount as decimal string.  String-encoded because
 *  large fees can exceed Number.MAX_SAFE_INTEGER. */
const XMR_PICONERO_RE = /^\d+$/;
/** Sanity ceiling on piconero string length: 1000 XMR is 1e15
 *  piconero (16 digits), far above any reasonable listing fee. */
const XMR_PICONERO_MAX_LEN = 16;

/** cp372 — sanity ceiling on the chain-pinned BLURT base.  The
 *  canonical fee is ~12.5¢ (≈62.5 BLURT at $0.002).  Even an
 *  extreme BLURT crash to $0.000001 would only need ~125,000
 *  BLURT to hold ~12.5¢; 10,000,000 leaves generous headroom
 *  while rejecting absurd / hostile values. */
const BLURT_BASE_MAX = 10_000_000;

/** Cheap-and-conservative URL shape validator.  We don't run new
 *  URL() because that's expensive and accepts a much wider grammar
 *  than we want here.  Endpoints must be `https://...` strings,
 *  no whitespace, reasonable length.
 *  v1.8.16 (Ken) — `+` allowed in the path (kept in sync with the
 *  indexer's handlers/release.ts): Launchpad personal-repo git URLs are
 *  `git.launchpad.net/~agorise/+git/morphit`. `+` is a valid RFC-3986
 *  path sub-delimiter and the charset is otherwise unchanged, so no
 *  whitespace/control chars slip through. */
const ORIGIN_RE = /^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~+/-]*)?$/;
const MAX_ORIGIN_LEN = 256;

/** cp556 — distribution-anchor shape checks. Deliberately strict +
 *  bounded, same philosophy as the treasury regexes above. */
/** Lowercase-hex SHA-256, exactly 64 chars — as `sha256sum` prints. */
const SOURCE_SHA256_RE = /^[0-9a-f]{64}$/;
/** GPG fingerprint: v4 (40-hex, SHA-1) or v5 (64-hex, SHA-256),
 *  case-insensitive, NO spaces (the builder strips GPG's display
 *  spaces before this ever runs). */
const GPG_FINGERPRINT_RE = /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/;
/** IPFS CID: v0 (`Qm…`, base58btc, 46 chars) or v1 base32 (`b…`, the
 *  default of `ipfs add --cid-version 1`). Bounded. */
const IPFS_CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,110})$/;
/** Belt-and-suspenders ceiling; a CID never approaches this. */
const IPFS_CID_MAX_LEN = 128;
/** No release needs more than a handful of mirrors. */
const MIRRORS_MAX = 8;
const DISTRIBUTION_MAX_SERIALIZED_BYTES = 4096;

/** Validate a parsed payload.  Returns `{ ok: true, value }` or
 *  `{ ok: false, reason }`.  The error reasons mirror the indexer's
 *  rejection reasons so a release that the indexer would store as
 *  `valid=true` always passes here, and vice versa.
 *
 *  This is the canonical validator on the frontend.  Anywhere a
 *  release payload arrives, run it through here BEFORE consuming
 *  any field. */
export function validateReleasePayload(payload: unknown): ReleaseValidateResult {
	if (!isPlainObject(payload)) {
		return { ok: false, reason: 'payload_not_object' };
	}

	const version = payload.version;
	if (typeof version !== 'string') {
		return { ok: false, reason: 'version_not_string' };
	}
	if (!SEMVER_RE.test(version)) {
		return { ok: false, reason: 'version_not_semver' };
	}

	const hashManifest = payload.hash_manifest;
	if (!isPlainObject(hashManifest)) {
		return { ok: false, reason: 'hash_manifest_not_object' };
	}
	const hashSerLen = byteLengthOfJson(hashManifest);
	if (hashSerLen > MANIFEST_MAX_SERIALIZED_BYTES) {
		return { ok: false, reason: 'hash_manifest_too_large' };
	}
	// Each hash-manifest entry must be a valid SRI-format hash
	// string.  This stops a hostile signer from stuffing arbitrary
	// data into manifest values.
	for (const [, v] of Object.entries(hashManifest)) {
		if (typeof v !== 'string' || !SHA256_RE.test(v)) {
			return { ok: false, reason: 'hash_manifest_entry_invalid' };
		}
	}

	// cp436 — endpoints is now OPTIONAL. Ken's rule: stop pinning the
	// blurt_rpc list on-chain — it's redundant with the frontend's baked-in
	// DEFAULT_BLURT_RPC_ENDPOINTS and only bloats the chain. Validate it only
	// when present; a payload with NO endpoints is valid (and preferred).
	let validEndpoints: Record<string, readonly string[]> | undefined;
	if (payload.endpoints !== undefined && payload.endpoints !== null) {
		const endpoints = payload.endpoints;
		if (!isPlainObject(endpoints)) {
			return { ok: false, reason: 'endpoints_not_object' };
		}
		const endpointsSerLen = byteLengthOfJson(endpoints);
		if (endpointsSerLen > ENDPOINTS_MAX_SERIALIZED_BYTES) {
			return { ok: false, reason: 'endpoints_too_large' };
		}
		for (const [, list] of Object.entries(endpoints)) {
			if (!Array.isArray(list)) {
				return { ok: false, reason: 'endpoints_entry_invalid' };
			}
			for (const u of list) {
				if (
					typeof u !== 'string' ||
					u.length === 0 ||
					u.length > MAX_ORIGIN_LEN ||
					!ORIGIN_RE.test(u)
				) {
					return { ok: false, reason: 'endpoints_entry_invalid' };
				}
			}
		}
		validEndpoints = endpoints as Record<string, readonly string[]>;
	}

	let signature: string | undefined;
	if (payload.signature !== undefined && payload.signature !== null) {
		if (typeof payload.signature !== 'string') {
			return { ok: false, reason: 'signature_not_string' };
		}
		if (payload.signature.length > SIGNATURE_MAX_LEN) {
			return { ok: false, reason: 'signature_too_long' };
		}
		signature = payload.signature;
	}

	// Part 106 — optional treasury pin.  Validation is structural
	// only.  Part 108++ removed view-key-based verification
	// entirely (per-payment proofs replaced it); Part 109 removed
	// the view-key env var; Part 110 retired the diagnostic
	// helper.  No view-key concept reaches this validator.
	const treasuryResult = validateTreasury(payload.treasury);
	if (!treasuryResult.ok) {
		return { ok: false, reason: treasuryResult.reason };
	}

	// cp556 — optional decentralized-distribution anchor.  Structural
	// validation only (parity with the indexer handler).
	const distributionResult = validateDistribution(payload.distribution);
	if (!distributionResult.ok) {
		return { ok: false, reason: distributionResult.reason };
	}

	return {
		ok: true,
		value: {
			version,
			hash_manifest: hashManifest as Record<string, string>,
			...(validEndpoints !== undefined ? { endpoints: validEndpoints } : {}),
			...(signature !== undefined ? { signature } : {}),
			...(treasuryResult.value !== null ? { treasury: treasuryResult.value } : {}),
			...(distributionResult.value !== null ? { distribution: distributionResult.value } : {})
		}
	};
}

/**
 * Validate the optional `distribution` field of a release payload
 * (cp556).  Mirrors the indexer-side `validateDistribution()` in
 * `apps/indexer/src/indexer/handlers/release.ts` — same regexes,
 * same ceilings, same reason names — so a release the indexer stores
 * `valid=true` always passes here, and vice versa.
 *
 * Structural + shape validation ONLY.  It does NOT fetch the tarball,
 * check the IPFS CID resolves, or verify the GPG signature — those are
 * the downloader's job (`scripts/verify-download.mjs`).  What it
 * guarantees is that every field is well-formed, so a hostile signer
 * can't stuff arbitrary data into the anchor.
 *
 * Returns:
 *   { ok: true, value: null } when distribution was undefined/null
 *   { ok: true, value: ReleaseDistributionBlock } when present + valid
 *   { ok: false, reason } when present + structurally invalid
 */
export function validateDistribution(d: unknown):
	| { ok: true; value: import('./release.js').ReleaseDistributionBlock | null }
	| { ok: false; reason: ReleaseValidateError } {
	if (d === undefined || d === null) return { ok: true, value: null };
	if (!isPlainObject(d)) return { ok: false, reason: 'distribution_not_object' };

	const sha = d.source_sha256;
	if (typeof sha !== 'string' || !SOURCE_SHA256_RE.test(sha)) {
		return { ok: false, reason: 'distribution_source_sha256_invalid' };
	}

	const fpr = d.gpg_fingerprint;
	if (typeof fpr !== 'string' || !GPG_FINGERPRINT_RE.test(fpr)) {
		return { ok: false, reason: 'distribution_gpg_fingerprint_invalid' };
	}

	let ipfs_cid: string | undefined;
	if (d.ipfs_cid !== undefined && d.ipfs_cid !== null) {
		const cid = d.ipfs_cid;
		if (typeof cid !== 'string' || cid.length > IPFS_CID_MAX_LEN || !IPFS_CID_RE.test(cid)) {
			return { ok: false, reason: 'distribution_ipfs_cid_invalid' };
		}
		ipfs_cid = cid;
	}

	let mirrors: string[] | undefined;
	if (d.mirrors !== undefined && d.mirrors !== null) {
		if (!Array.isArray(d.mirrors)) {
			return { ok: false, reason: 'distribution_mirrors_not_array' };
		}
		if (d.mirrors.length > MIRRORS_MAX) {
			return { ok: false, reason: 'distribution_mirror_invalid' };
		}
		for (const m of d.mirrors) {
			if (typeof m !== 'string' || m.length === 0 || m.length > MAX_ORIGIN_LEN || !ORIGIN_RE.test(m)) {
				return { ok: false, reason: 'distribution_mirror_invalid' };
			}
		}
		mirrors = d.mirrors as string[];
	}

	// Attach optional fields ONLY when present, so a minimal anchor
	// (sha + fingerprint) serializes byte-identically across builder,
	// chain, and re-validation — no phantom keys to break fixtures.
	const value: import('./release.js').ReleaseDistributionBlock = {
		source_sha256: sha,
		gpg_fingerprint: fpr,
		...(ipfs_cid !== undefined ? { ipfs_cid } : {}),
		...(mirrors !== undefined ? { mirrors } : {})
	};
	if (byteLengthOfJson(value) > DISTRIBUTION_MAX_SERIALIZED_BYTES) {
		return { ok: false, reason: 'distribution_too_large' };
	}
	return { ok: true, value };
}

/**
 * Validate the optional `treasury` field of a release payload.
 * Mirrors the indexer-side `validateTreasury()` in
 * `apps/indexer/src/indexer/handlers/release.ts` — same regex,
 * same ceilings, same reason names.  Any release that the
 * indexer would store as `valid=true` passes here too, and any
 * release the indexer rejects fails here with the same reason.
 *
 * Returns:
 *   { ok: true, value: null } when treasury was undefined or null
 *   { ok: true, value: ReleaseTreasuryBlock } when present and valid
 *   { ok: false, reason } when present and structurally invalid
 */
export function validateTreasury(t: unknown):
	| { ok: true; value: import('./release.js').ReleaseTreasuryBlock | null }
	| { ok: false; reason: ReleaseValidateError } {
	if (t === undefined || t === null) return { ok: true, value: null };
	if (!isPlainObject(t)) return { ok: false, reason: 'treasury_not_object' };

	let btc: { address: string; satoshis: number } | null = null;
	if (t.btc !== undefined && t.btc !== null) {
		if (!isPlainObject(t.btc)) return { ok: false, reason: 'treasury_btc_not_object' };
		const addr = t.btc.address;
		if (typeof addr !== 'string' || addr.length === 0) {
			return { ok: false, reason: 'treasury_btc_address_missing' };
		}
		if (addr.length > BTC_ADDRESS_MAX_LEN) {
			return { ok: false, reason: 'treasury_btc_address_too_long' };
		}
		if (!BTC_MAINNET_ADDRESS_RE.test(addr)) {
			return { ok: false, reason: 'treasury_btc_address_not_mainnet' };
		}
		const sat = t.btc.satoshis;
		if (typeof sat !== 'number' || !Number.isInteger(sat) || sat <= 0) {
			return { ok: false, reason: 'treasury_btc_satoshis_invalid' };
		}
		if (sat > BTC_SATOSHIS_MAX) {
			return { ok: false, reason: 'treasury_btc_satoshis_too_large' };
		}
		btc = { address: addr, satoshis: sat };
	}

	let xmr: { address: string; piconero: string } | null = null;
	if (t.xmr !== undefined && t.xmr !== null) {
		if (!isPlainObject(t.xmr)) return { ok: false, reason: 'treasury_xmr_not_object' };
		const addr = t.xmr.address;
		if (typeof addr !== 'string') {
			return { ok: false, reason: 'treasury_xmr_address_missing' };
		}
		if (!XMR_MAINNET_ADDRESS_RE.test(addr)) {
			return { ok: false, reason: 'treasury_xmr_address_not_mainnet' };
		}
		// Part 107 — viewkey field deliberately NOT read.  If the
		// payload contains a `viewkey` field (e.g. from a release
		// op broadcast before Part 107), it's silently ignored.
		// Publishing the view key is a privacy regression for the
		// treasury wallet; chain-pinning it was a Part 106 design
		// error corrected in Part 107.  See ADR-0011 amendment.
		const pn = t.xmr.piconero;
		if (typeof pn !== 'string' || !XMR_PICONERO_RE.test(pn) || pn === '0') {
			return { ok: false, reason: 'treasury_xmr_piconero_invalid' };
		}
		if (pn.length > XMR_PICONERO_MAX_LEN) {
			return { ok: false, reason: 'treasury_xmr_piconero_too_large' };
		}
		xmr = { address: addr, piconero: pn };
	}

	// cp372 — optional chain-pinned BLURT fee base.  No address
	// (BLURT fees are transfers to the operator's fee recipient);
	// only the tier-1 base amount is pinned.
	let blurt: { base: number } | null = null;
	if (t.blurt !== undefined && t.blurt !== null) {
		if (!isPlainObject(t.blurt)) return { ok: false, reason: 'treasury_blurt_not_object' };
		const base = t.blurt.base;
		if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) {
			return { ok: false, reason: 'treasury_blurt_base_invalid' };
		}
		if (base > BLURT_BASE_MAX) {
			return { ok: false, reason: 'treasury_blurt_base_too_large' };
		}
		blurt = { base };
	}

	// Size cap on the whole serialized treasury block — mirrors
	// the indexer's checkJsonbSize gate.  In practice this can
	// never trip with valid btc + xmr fields above (max payload
	// is well under 1 KB), but it's a defense-in-depth bound for
	// hostile inputs that pad the object with unknown fields.
	//
	// Only attach `blurt` when present so a release with no BLURT
	// pin serializes byte-identically to the pre-cp372 shape
	// (backward compatibility for older consumers + existing
	// release-op fixtures).
	const value: import('./release.js').ReleaseTreasuryBlock =
		blurt !== null ? { btc, xmr, blurt } : { btc, xmr };
	if (byteLengthOfJson(value) > 4096) {
		return { ok: false, reason: 'treasury_too_large' };
	}
	return { ok: true, value };
}

/** UTF-8 byte length of `JSON.stringify(value)`.  Approximates
 *  Postgres's JSONB on-disk size for the indexer's parity check. */
function byteLengthOfJson(value: unknown): number {
	const ser = JSON.stringify(value);
	if (typeof TextEncoder !== 'undefined') {
		return new TextEncoder().encode(ser).length;
	}
	// Fallback for environments without TextEncoder (old node).
	// Roughly approximates UTF-8 byte length.
	let n = 0;
	for (const ch of ser) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x80) n += 1;
		else if (cp < 0x800) n += 2;
		else if (cp < 0x10000) n += 3;
		else n += 4;
	}
	return n;
}
