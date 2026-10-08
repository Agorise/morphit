/**
 * Handler: morphit_release_v1
 *
 * Payload shape:
 *   {
 *     "version": string (semver),
 *     "hash_manifest": object (frontend + ops asset hashes),
 *     "endpoints": object (RPC endpoint rotation set),
 *     "signature": string (optional secondary signature; opaque),
 *     "treasury": object (optional, onward — canonical
 *                         BTC/XMR fee addresses pinned by the
 *                         @morphit posting key.  See below.)
 *   }
 *
 * `treasury` shape (corrected) — every field
 * optional within:
 *   {
 *     "btc": { "address": "bc1q...", "satoshis": 416,
 *              "xpub"?: "xpub..." (v1.20.0, MK-H2: treasury BIP84
 *                        account key; per-order fee addresses) } | null,
 *     "xmr": { "address": "4..." | "8...",
 *              "piconero": "781250000" } | null
 *   }
 *   - Either chain may be `null` (or omitted entirely) to mean
 *     "this release does not pin a treasury for this chain;
 *     env-var fallback applies."
 *   - The whole `treasury` field may itself be `null` or omitted
 *     to mean "this release pre-dates OR deliberately
 *     omits the pin entirely."
 *   - **Privacy invariant**: the Monero `viewkey` is
 *     NEVER part of this block.  Publishing the view key would
 *     reveal every incoming payment to the treasury wallet
 *     forever, degrading privacy for the treasury and for every
 *     fee-paying user.  The view key stays env-only on each
 *     operator's indexer box.  If a release op carries a
 *     `viewkey` field (e.g. one broadcast previously),
 *     this handler silently ignores it — never persists it to
 *     the `treasury` JSONB column.
 *
 * Trust anchor:
 *   1. Signer's blurt account name MUST equal config.officialAccountName
 *   2. The transaction carrying the op MUST be signed by the pinned
 *      config.officialPostingPubkey (signature recovered from the block's
 *      own transaction — see $indexer/officialOpTrust)
 *   3. Payload must validate structurally
 *
 * All three conditions in AND. Any failure lands the row with
 * valid=false; the HTTP /v1/release endpoint only returns valid=true
 * rows. Invalid releases stay in the table for audit (operators can
 * see if a stale or hostile key ever broadcast something).
 *
 * No chain read happens here: the verdict is a pure function of the
 * block and the pin, the same on every node. A block holding this op is
 * applied only once RPC operators (counted by node name) serve the same transaction
 * (fee/btcFeeBlockConfirm.ts).
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { officialOpDistrust } from '$indexer/officialOpTrust';
import { checkJsonbSize } from '$indexer/payloadSize';
import {
	isBtcMainnetAddress,
	parseAccountXpub,
	parseXmrAddress,
	parseXmrPrimaryAddress
} from '@morphit/release-schema';

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ValidatedRelease {
	readonly version: string;
	readonly hash_manifest: Record<string, unknown>;
	readonly endpoints: Record<string, unknown>;
	readonly signature: string;
	/** Pre-serialized per Finding L. These go straight to
	 *  client.query() at the insert site so the DB row is
	 *  byte-identical to what passed the size check. */
	readonly hash_manifest_serialized: string;
	readonly endpoints_serialized: string;
	/** optional treasury pin.  null when the payload
	 *  did not include a `treasury` field at all (or included
	 *  it as null), serialized JSON when it did.  Either way,
	 *  the column write is unambiguous. */
	readonly treasury_serialized: string | null;
	/** optional distribution anchor (source_sha256, gpg_fingerprint,
	 *  ipfs_cid, ipns_name, mirrors) as a JSON string, or null. Persisted so
	 *  instances can pin the release's ipfs_cid and the API can surface it. */
	readonly distribution_serialized: string | null;
}

/**
 * Validate the optional `treasury` block: shape, and the BTC / XMR
 * addresses decoded with their checksums (shared parsers from
 * @morphit/release-schema) — a mistyped pinned address would burn
 * every fee paid to it, so a typo must not pin.
 *
 * **Privacy invariant**: this validator does NOT
 * accept a `viewkey` field.  Any `viewkey` present in the
 * input is silently ignored and not persisted.  The view key
 * is operator-private; publishing it would degrade privacy
 * for the treasury and for every fee-paying user.  See
 * docs/adr/0011-dynamic-fee-model.md amendment.
 *
 * Returns the canonicalized treasury value (with omitted fields
 * coerced to null) on success, or a reason string on failure.
 */
function validateTreasury(
	t: unknown
): { value: Record<string, unknown> | null } | { reason: string } {
	if (t === undefined || t === null) {
		// Payload didn't include treasury at all — fine, just means
		// no chain-pin for this release.
		return { value: null };
	}
	if (!isPlainObject(t)) return { reason: 'treasury_not_object' };

	// btc: { address, satoshis } | null | undefined
	let btc: { address: string; satoshis: number; xpub?: string } | null = null;
	if (t.btc !== undefined && t.btc !== null) {
		if (!isPlainObject(t.btc)) return { reason: 'treasury_btc_not_object' };
		const addr = t.btc.address;
		if (typeof addr !== 'string' || addr.length === 0) {
			return { reason: 'treasury_btc_address_missing' };
		}
		if (addr.length > 100) return { reason: 'treasury_btc_address_too_long' };
		// Strict shape check: testnet prefixes rejected so a
		// fat-finger on testnet doesn't ever reach mainnet
		// indexers as a "valid" pin.  Mainnet only: bc1, 1, 3.
		if (!/^(bc1[a-z0-9]+|[13][1-9A-HJ-NP-Za-km-z]+)$/.test(addr)) {
			return { reason: 'treasury_btc_address_not_mainnet' };
		}
		// The shape admits a typo; the checksum does not. Every fee
		// paid to a mistyped pinned address would be burned.
		if (!isBtcMainnetAddress(addr)) {
			return { reason: 'treasury_btc_address_bad_checksum' };
		}
		const sat = t.btc.satoshis;
		if (typeof sat !== 'number' || !Number.isInteger(sat) || sat <= 0) {
			return { reason: 'treasury_btc_satoshis_invalid' };
		}
		if (sat > 100_000_000_000) {
			// Sanity ceiling: 1000 BTC per listing fee is absurd.
			return { reason: 'treasury_btc_satoshis_too_large' };
		}
		// v1.20.0 (MK-H2) — optional treasury BIP84 account xpub, the key
		// every per-order BTC fee address is derived from. The crypto check
		// (checksum, mainnet, PUBLIC, account depth, valid point) is the
		// shared parser — the one the frontend validator and the address
		// derivation also use — and the canonical `xpub…` spelling is what
		// gets persisted. Attached only when present (legacy shape otherwise).
		if (t.btc.xpub !== undefined && t.btc.xpub !== null) {
			const parsed = parseAccountXpub(t.btc.xpub);
			if (!parsed.ok) return { reason: 'treasury_btc_xpub_invalid' };
			btc = { address: addr, satoshis: sat, xpub: parsed.value.xpub };
		} else {
			btc = { address: addr, satoshis: sat };
		}
	}

	// xmr: { address, piconero } | null | undefined
	//
	// viewkey is INTENTIONALLY NOT a chain-pinned
	// field.  A previous design embedded the private
	// view key here under the rationale that "it's publish-safe
	// by Monero design"; that was correct only narrowly (no
	// theft risk) and wrong for privacy (publishing the view key
	// reveals every incoming payment, amount, timing, and
	// subaddress to the treasury wallet, forever).
	//
	// later+: per-payment proof verification replaced view-
	// key-based decryption entirely.  No Morphit indexer needs
	// a view key, ever.  A later change removed the
	// `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` env var as well.
	//
	// The defense-in-depth check below remains: if a payload
	// submitted to this validator contains a stale `viewkey`
	// field (e.g. from an early release op being
	// replayed), it is silently stripped — not stored in the
	// JSONB column, not stored anywhere.
	let xmr: { address: string; piconero: string; primary_address?: string } | null = null;
	if (t.xmr !== undefined && t.xmr !== null) {
		if (!isPlainObject(t.xmr)) return { reason: 'treasury_xmr_not_object' };
		const addr = t.xmr.address;
		if (typeof addr !== 'string') return { reason: 'treasury_xmr_address_missing' };
		// Mainnet primary (95 chars, starts with 4) or subaddress
		// (95 chars, starts with 8).  Testnet starts 9/B, stagenet
		// starts 5/7 — all rejected so fat-finger config doesn't
		// reach mainnet indexers.
		if (!/^[48][0-9A-Za-z]{94}$/.test(addr)) {
			return { reason: 'treasury_xmr_address_not_mainnet' };
		}
		{
			const parsed = parseXmrAddress(addr);
			if (!parsed.ok || parsed.value.net !== 'mainnet' || parsed.value.kind === 'integrated') {
				return { reason: 'treasury_xmr_address_bad_checksum' };
			}
		}
		const pn = t.xmr.piconero;
		if (typeof pn !== 'string' || !/^\d+$/.test(pn) || pn === '0') {
			return { reason: 'treasury_xmr_piconero_invalid' };
		}
		// Sanity ceiling: piconero is 1e-12 XMR; 1000 XMR is 1e15
		// piconero, far above any reasonable listing fee.
		if (pn.length > 16) {
			return { reason: 'treasury_xmr_piconero_too_large' };
		}
		// v1.20.0 (MK-H2) — optional treasury PRIMARY address for bound XMR
		// fees (shared parser: mainnet standard address, checksum).
		if (t.xmr.primary_address !== undefined && t.xmr.primary_address !== null) {
			const prim = parseXmrPrimaryAddress(t.xmr.primary_address);
			if (!prim.ok) return { reason: 'treasury_xmr_primary_invalid' };
			xmr = { address: addr, piconero: pn, primary_address: prim.value.address };
		} else {
			xmr = { address: addr, piconero: pn };
		}
	}

	// optional chain-pinned BLURT fee base.  No address
	// (BLURT fees are transfers to the operator's fee recipient);
	// only the tier-1 base amount is pinned.  Mirrors the
	// release-schema package's validateTreasury().
	let blurt: { base: number } | null = null;
	if (t.blurt !== undefined && t.blurt !== null) {
		if (!isPlainObject(t.blurt)) return { reason: 'treasury_blurt_not_object' };
		const base = t.blurt.base;
		if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) {
			return { reason: 'treasury_blurt_base_invalid' };
		}
		// Sanity ceiling: ~12.5¢ is ≈62.5 BLURT; even an extreme
		// crash to $0.000001 needs only ~125,000 BLURT.  10M leaves
		// generous headroom while rejecting absurd / hostile values.
		if (base > 10_000_000) {
			return { reason: 'treasury_blurt_base_too_large' };
		}
		blurt = { base };
	}

	// Both null is fine — it's a structurally valid "I declare
	// no treasury pin" payload, equivalent to omitting the field.
	// Attach `blurt` only when present so a release with no BLURT
	// pin serializes byte-identically to the older shape.
	const value: Record<string, unknown> = blurt !== null ? { btc, xmr, blurt } : { btc, xmr };
	const sizeCheck = checkJsonbSize(value);
	if (!sizeCheck.ok) return { reason: 'treasury_too_large' };
	return { value };
}

/**
 * Structurally validate the optional `distribution` anchor.
 * MIRRORS packages/release-schema/src/releaseValidate.ts
 * `validateDistribution()` — same regexes, same ceilings, same reason
 * names.  The frontend re-validates independently; release.test.ts
 * proves byte-for-byte parity.
 *
 * Shape validation ONLY — we do NOT fetch the tarball, resolve the
 * IPFS CID, or verify the GPG signature (that's the downloader's job
 * in scripts/verify-download.mjs).  We guarantee only that every field
 * is well-formed, so a hostile signer can't stuff junk into the anchor.
 *
 * NOTE: the anchor is validated to gate the release's `valid` verdict,
 * but it is NOT stored in a column — a downloader reads it from the
 * CHAIN (via RPC, never this indexer; same anti-circularity rule as
 * the rest of the op), so no `releases`-table column and no migration
 * is needed for it.
 */
function validateDistribution(
	d: unknown
): { value: Record<string, unknown> | null } | { reason: string } {
	if (d === undefined || d === null) return { value: null };
	if (!isPlainObject(d)) return { reason: 'distribution_not_object' };

	const sha = d.source_sha256;
	if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
		return { reason: 'distribution_source_sha256_invalid' };
	}
	const fpr = d.gpg_fingerprint;
	if (typeof fpr !== 'string' || !/^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/.test(fpr)) {
		return { reason: 'distribution_gpg_fingerprint_invalid' };
	}

	let ipfs_cid: string | undefined;
	if (d.ipfs_cid !== undefined && d.ipfs_cid !== null) {
		const cid = d.ipfs_cid;
		if (
			typeof cid !== 'string' ||
			cid.length > 128 ||
			!/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,110})$/.test(cid)
		) {
			return { reason: 'distribution_ipfs_cid_invalid' };
		}
		ipfs_cid = cid;
	}

	// v1.9.x — optional stable IPNS name (w3name Ed25519 `k51…`, ~62 chars),
	// the mutable "always latest" pointer. Same shape check as the schema
	// package's validateDistribution so a stored-valid release re-validates.
	let ipns_name: string | undefined;
	if (d.ipns_name !== undefined && d.ipns_name !== null) {
		const nm = d.ipns_name;
		if (typeof nm !== 'string' || nm.length > 80 || !/^k51[a-z0-9]{50,70}$/.test(nm)) {
			return { reason: 'distribution_ipns_name_invalid' };
		}
		ipns_name = nm;
	}

	// v1.9.6 — optional signed IPNS record (base64): the DHT-rebroadcast
	// pointer every instance re-announces. Same syntax + size gate as the schema
	// package's validateDistribution so a stored-valid release re-validates; the
	// cryptographic validity is re-checked where the record is USED (instance
	// rebroadcast + resolvers), not here.
	let ipns_record: string | undefined;
	if (d.ipns_record !== undefined && d.ipns_record !== null) {
		const rec = d.ipns_record;
		if (
			typeof rec !== 'string' ||
			rec.length < 64 ||
			rec.length > 1200 ||
			!/^[A-Za-z0-9+/]+={0,2}$/.test(rec)
		) {
			return { reason: 'distribution_ipns_record_invalid' };
		}
		ipns_record = rec;
	}

	let mirrors: string[] | undefined;
	if (d.mirrors !== undefined && d.mirrors !== null) {
		if (!Array.isArray(d.mirrors)) return { reason: 'distribution_mirrors_not_array' };
		// Cap raised 8→10 (v1.9.6) → 32 (v1.11.1, 9 new mirrors; ~20-mirror
		// goal + headroom). Kept in lockstep with release-schema MIRRORS_MAX; the
		// 4096-byte serialized cap below is the real bloat guard.
		if (d.mirrors.length > 32) return { reason: 'distribution_mirror_invalid' };
		for (const m of d.mirrors) {
			if (
				typeof m !== 'string' ||
				m.length === 0 ||
				m.length > 256 ||
				// v1.8.16 — `+` added to the allowed path charset for
				// Launchpad, whose personal-repo git URLs are literally
				// `git.launchpad.net/~agorise/+git/morphit`. `+` is a valid RFC-3986
				// path sub-delimiter (no injection risk — the value is only ever a
				// clone URL / displayed link) and this only ACCEPTS MORE: every
				// prior payload had no `+`, so all remain valid. NB forward-compat:
				// a `+` URL is rejected by pre-v1.8.16 validators, so a release
				// carrying the Launchpad mirror could be broadcast only once nodes ran
				// v1.8.16. Since 2026-10-07 the ceremony broadcasts BEFORE any node
				// upgrades, so every node judges a record with the PREVIOUS release's
				// validator, and a rejected op stays rejected (officialOpReverify
				// re-checks once): a change that widens what the record may carry
				// ships in one release and is used only by a later one.
				!/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~+/-]*)?$/.test(m)
			) {
				return { reason: 'distribution_mirror_invalid' };
			}
		}
		mirrors = d.mirrors as string[];
	}

	const value: Record<string, unknown> = {
		source_sha256: sha,
		gpg_fingerprint: fpr,
		...(ipfs_cid !== undefined ? { ipfs_cid } : {}),
		...(ipns_name !== undefined ? { ipns_name } : {}),
		...(ipns_record !== undefined ? { ipns_record } : {}),
		...(mirrors !== undefined ? { mirrors } : {})
	};
	const sizeCheck = checkJsonbSize(value);
	if (!sizeCheck.ok) return { reason: 'distribution_too_large' };
	return { value };
}

function validate(payload: unknown): ValidatedRelease | { reason: string } {
	if (!isPlainObject(payload)) return { reason: 'payload_not_object' };

	const version = payload.version;
	if (typeof version !== 'string') return { reason: 'version_not_string' };
	// Loose semver check — major.minor.patch with optional prerelease/build.
	if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
		return { reason: 'version_not_semver' };
	}

	if (!isPlainObject(payload.hash_manifest)) {
		return { reason: 'hash_manifest_not_object' };
	}
	const hashManifestSize = checkJsonbSize(payload.hash_manifest);
	if (!hashManifestSize.ok) return { reason: 'hash_manifest_too_large' };

	// endpoints is OPTIONAL (project rule: no longer pinned on-chain —
	// redundant with the frontend's baked-in defaults + avoids chain-bloat).
	// Validate only when present; default to an empty object so the DB column
	// stays non-null and /v1/release returns {} for the (now normal) case.
	let endpoints: Record<string, unknown> = {};
	let endpoints_serialized = '{}';
	if (payload.endpoints !== undefined && payload.endpoints !== null) {
		if (!isPlainObject(payload.endpoints)) {
			return { reason: 'endpoints_not_object' };
		}
		const endpointsSize = checkJsonbSize(payload.endpoints);
		if (!endpointsSize.ok) return { reason: 'endpoints_too_large' };
		endpoints = payload.endpoints;
		endpoints_serialized = endpointsSize.serialized;
	}

	let signature = '';
	if (payload.signature !== undefined && payload.signature !== null) {
		if (typeof payload.signature !== 'string') {
			return { reason: 'signature_not_string' };
		}
		if (payload.signature.length > 512) return { reason: 'signature_too_long' };
		signature = payload.signature;
	}

	// optional treasury pin.  Validation is structural
	// only; cryptographic validation (does the viewkey actually
	// decode the address) is the operator's responsibility at
	// release-build time.
	const treasuryResult = validateTreasury(payload.treasury);
	if ('reason' in treasuryResult) return { reason: treasuryResult.reason };
	const treasury_serialized =
		treasuryResult.value === null ? null : JSON.stringify(treasuryResult.value);

	// validate the optional distribution anchor (parity with the
	// frontend validator) AND persist it: instances pin the release's
	// ipfs_cid to their own IPFS node (decentralized availability), and the
	// download page / pinning service read it from /v1/release, so the block
	// now lives in a `distribution` JSONB column (migration v53).
	const distributionResult = validateDistribution(payload.distribution);
	if ('reason' in distributionResult) return { reason: distributionResult.reason };
	const distribution_serialized =
		distributionResult.value === null ? null : JSON.stringify(distributionResult.value);

	return {
		version,
		hash_manifest: payload.hash_manifest,
		endpoints,
		signature,
		hash_manifest_serialized: hashManifestSize.serialized,
		endpoints_serialized,
		treasury_serialized,
		distribution_serialized
	};
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	const v = validate(ctx.payload);
	if ('reason' in v) {
		// Structurally malformed payload — don't even record a row
		// in `releases`, just let the event log's rejection reflect it.
		return { ok: false, reason: v.reason };
	}

	// Determine whether this release is trustworthy. We record the
	// row either way — operators want to see rejected releases in
	// case they reveal key-compromise attempts.
	let valid = true;
	let invalidReason: string | null = null;

	// Checks 1 and 2: the official account, and a signature from the pinned
	// key over the transaction the block carries.
	const distrust = officialOpDistrust(ctx);
	if (distrust !== null) {
		valid = false;
		invalidReason = distrust;
	}

	// Record the row. `valid=false` releases are still worth
	// keeping — operators want to see rejected releases in case
	// they reveal key-compromise attempts. When valid=false, we
	// also persist the specific invalidReason so post-incident
	// forensics can distinguish impersonation from key compromise.
	await client.query(
		`INSERT INTO releases (
			version, hash_manifest, endpoints, signature,
			source_block_num, source_trx_id, signer, valid,
			invalid_reason, created_at, treasury, distribution
		) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, $9, $10,
		          CASE WHEN $11::text IS NULL THEN NULL ELSE $11::jsonb END,
		          CASE WHEN $12::text IS NULL THEN NULL ELSE $12::jsonb END)
		ON CONFLICT (source_trx_id) DO NOTHING`,
		[
			v.version,
			v.hash_manifest_serialized,
			v.endpoints_serialized,
			v.signature,
			ctx.blockNum,
			ctx.trxId,
			ctx.signer,
			valid,
			invalidReason,
			ctx.blockTime,
			v.treasury_serialized,
			v.distribution_serialized
		]
	);

	return { ok: true };
};

/** (v1.20.0, V3-1) The payload validator, for the upgrade backfill
 *  (reconcileUpgrade.ts) — the SAME function the handler runs. */
export { validate as validateReleaseOp };

export default handle;
