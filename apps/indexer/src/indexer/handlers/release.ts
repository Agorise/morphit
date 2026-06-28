/**
 * Handler: morphit_release_v1
 *
 * Payload shape:
 *   {
 *     "version": string (semver),
 *     "hash_manifest": object (frontend + ops asset hashes),
 *     "endpoints": object (RPC endpoint rotation set),
 *     "signature": string (optional secondary signature; opaque),
 *     "treasury": object (optional, Part 106 onward — canonical
 *                         BTC/XMR fee addresses pinned by the
 *                         @morphit posting key.  See below.)
 *   }
 *
 * `treasury` shape (Part 106; corrected Part 107) — every field
 * optional within:
 *   {
 *     "btc": { "address": "bc1q...", "satoshis": 416 } | null,
 *     "xmr": { "address": "4..." | "8...",
 *              "piconero": "781250000" } | null
 *   }
 *   - Either chain may be `null` (or omitted entirely) to mean
 *     "this release does not pin a treasury for this chain;
 *     env-var fallback applies."
 *   - The whole `treasury` field may itself be `null` or omitted
 *     to mean "this release pre-dates Part 106 OR deliberately
 *     omits the pin entirely."
 *   - **Part 107 privacy invariant**: the Monero `viewkey` is
 *     NEVER part of this block.  Publishing the view key would
 *     reveal every incoming payment to the treasury wallet
 *     forever, degrading privacy for the treasury and for every
 *     fee-paying user.  The view key stays env-only on each
 *     operator's indexer box.  If a release op carries a
 *     `viewkey` field (e.g. one broadcast before Part 107),
 *     this handler silently ignores it — never persists it to
 *     the `treasury` JSONB column.
 *
 * Trust anchor chain (UNCHANGED from Part 105):
 *   1. Signer's blurt account name MUST equal config.officialAccountName
 *   2. Signer's current posting pubkey on chain MUST equal
 *      config.officialPostingPubkey
 *   3. Payload must validate structurally
 *
 * All three conditions in AND. Any failure lands the row with
 * valid=false; the HTTP /v1/release endpoint only returns valid=true
 * rows. Invalid releases stay in the table for audit (operators can
 * see if a stale or hostile key ever broadcast something).
 *
 * Note: condition #2 does a chain read inside the handler. This is
 * the only handler that does so. It's fine — releases are rare (a
 * few per year at most), so the extra latency doesn't hurt the
 * poller's throughput.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { resolveSignerPostingPubkey } from '$blurt/verify';
import { checkJsonbSize } from '$indexer/payloadSize';

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
	/** Part 106 — optional treasury pin.  null when the payload
	 *  did not include a `treasury` field at all (or included
	 *  it as null), serialized JSON when it did.  Either way,
	 *  the column write is unambiguous. */
	readonly treasury_serialized: string | null;
}

/**
 * Structurally validate the optional `treasury` block.  We do
 * not VALIDATE that the BTC address is a syntactically-correct
 * Bitcoin address — that's an operator responsibility, enforced
 * at signing time via the bitcoin-address smoke.  Here we just
 * enforce the SHAPE so a malformed treasury block doesn't slip
 * into the releases table and confuse downstream readers.
 *
 * **Part 107 privacy invariant**: this validator does NOT
 * accept a `viewkey` field.  Any `viewkey` present in the
 * input is silently ignored and not persisted.  The view key
 * is operator-private; publishing it would degrade privacy
 * for the treasury and for every fee-paying user.  See
 * docs/adr/0011-dynamic-fee-model.md Part 107 amendment.
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
	let btc: { address: string; satoshis: number } | null = null;
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
		const sat = t.btc.satoshis;
		if (typeof sat !== 'number' || !Number.isInteger(sat) || sat <= 0) {
			return { reason: 'treasury_btc_satoshis_invalid' };
		}
		if (sat > 100_000_000_000) {
			// Sanity ceiling: 1000 BTC per listing fee is absurd.
			return { reason: 'treasury_btc_satoshis_too_large' };
		}
		btc = { address: addr, satoshis: sat };
	}

	// xmr: { address, piconero } | null | undefined
	//
	// Part 107: viewkey is INTENTIONALLY NOT a chain-pinned
	// field.  A previous Part 106 design embedded the private
	// view key here under the rationale that "it's publish-safe
	// by Monero design"; that was correct only narrowly (no
	// theft risk) and wrong for privacy (publishing the view key
	// reveals every incoming payment, amount, timing, and
	// subaddress to the treasury wallet, forever).
	//
	// Part 108++: per-payment proof verification replaced view-
	// key-based decryption entirely.  No Morphit indexer needs
	// a view key, ever.  Part 109 removed the
	// `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` env var as well.
	//
	// The defense-in-depth check below remains: if a payload
	// submitted to this validator contains a stale `viewkey`
	// field (e.g. from a Part 106-vintage release op being
	// replayed), it is silently stripped — not stored in the
	// JSONB column, not stored anywhere.
	let xmr: { address: string; piconero: string } | null = null;
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
		const pn = t.xmr.piconero;
		if (typeof pn !== 'string' || !/^\d+$/.test(pn) || pn === '0') {
			return { reason: 'treasury_xmr_piconero_invalid' };
		}
		// Sanity ceiling: piconero is 1e-12 XMR; 1000 XMR is 1e15
		// piconero, far above any reasonable listing fee.
		if (pn.length > 16) {
			return { reason: 'treasury_xmr_piconero_too_large' };
		}
		xmr = { address: addr, piconero: pn };
	}

	// cp372 — optional chain-pinned BLURT fee base.  No address
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
	// pin serializes byte-identically to the pre-cp372 shape.
	const value: Record<string, unknown> = blurt !== null ? { btc, xmr, blurt } : { btc, xmr };
	const sizeCheck = checkJsonbSize(value);
	if (!sizeCheck.ok) return { reason: 'treasury_too_large' };
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

	if (!isPlainObject(payload.endpoints)) {
		return { reason: 'endpoints_not_object' };
	}
	const endpointsSize = checkJsonbSize(payload.endpoints);
	if (!endpointsSize.ok) return { reason: 'endpoints_too_large' };

	let signature = '';
	if (payload.signature !== undefined && payload.signature !== null) {
		if (typeof payload.signature !== 'string') {
			return { reason: 'signature_not_string' };
		}
		if (payload.signature.length > 512) return { reason: 'signature_too_long' };
		signature = payload.signature;
	}

	// Part 106 — optional treasury pin.  Validation is structural
	// only; cryptographic validation (does the viewkey actually
	// decode the address) is the operator's responsibility at
	// release-build time.
	const treasuryResult = validateTreasury(payload.treasury);
	if ('reason' in treasuryResult) return { reason: treasuryResult.reason };
	const treasury_serialized =
		treasuryResult.value === null ? null : JSON.stringify(treasuryResult.value);

	return {
		version,
		hash_manifest: payload.hash_manifest,
		endpoints: payload.endpoints,
		signature,
		hash_manifest_serialized: hashManifestSize.serialized,
		endpoints_serialized: endpointsSize.serialized,
		treasury_serialized
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

	// Check 1: signer is the configured official account.
	if (ctx.signer !== ctx.config.officialAccountName) {
		valid = false;
		invalidReason = 'signer_not_official_account';
	}

	// Check 2: the signer's current posting pubkey on chain matches
	// the pinned value. Only run if check 1 passed — otherwise we'd
	// waste a chain call on someone impersonating @morphit.
	if (valid) {
		let account;
		try {
			account = await ctx.blurt.getAccount(ctx.signer, { userFacing: false });
		} catch (err) {
			// Chain unreachable during this handler. Re-throw so the
			// dispatcher rolls the block back and we retry — we'd
			// rather delay the release verdict than commit an
			// unverified 'valid=true' row.
			throw err;
		}
		const chainPubkey = resolveSignerPostingPubkey(account);
		if (chainPubkey === null) {
			valid = false;
			invalidReason = 'signer_no_single_posting_key';
		} else if (chainPubkey !== ctx.config.officialPostingPubkey) {
			valid = false;
			invalidReason = 'pubkey_mismatch';
		}
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
			invalid_reason, created_at, treasury
		) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, $9, $10,
		          CASE WHEN $11::text IS NULL THEN NULL ELSE $11::jsonb END)
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
			v.treasury_serialized
		]
	);

	return { ok: true };
};

export default handle;
