/**
 * apps/indexer/src/blurt/chainSnapshotOp.ts  (cp765)
 *
 * The `chain_snapshot_v1` on-chain op — the canonical POINTER to a published
 * Blurt block_log snapshot, posted by @morphit exactly like `morphit_release_v1`
 * points to a release. A new indexer / hidden-rpc node reads the latest one from
 * @morphit's account history to bootstrap the raw chain in hours instead of
 * cold-syncing for days.
 *
 * TRUST: this points at the RAW chain (blurtd's block_log), which is SELF-
 * VERIFYING — blurtd re-checks every block's witness signature + prev-hash on
 * import, so a tampered file fails on replay. The op therefore only needs to
 * carry integrity/locator fields (CID + sha256 + height); it does NOT ask anyone
 * to trust derived state. (Contrast the indexer-DB snapshot, cp764, which is
 * derived and stays same-operator-only.)
 *
 * This module is PURE (no network, no key, no fs): the validator + builder that
 * decide what may go on-chain are unit-tested. Reuses the release op's Blurt
 * custom_json size limit + signer conventions so the two anchors stay parallel.
 */
import { BLURT_CUSTOM_JSON_MAX_BYTES, RELEASE_SIGNER_DEFAULT } from './releaseBroadcastOp.js';

/** custom_json op id the snapshot publisher signs and consumers key on. Frozen. */
export const CHAIN_SNAPSHOT_OP_ID = 'chain_snapshot_v1';

export { BLURT_CUSTOM_JSON_MAX_BYTES, RELEASE_SIGNER_DEFAULT as CHAIN_SNAPSHOT_SIGNER_DEFAULT };

/** The `json` field of a chain_snapshot_v1 custom_json op. */
export interface ChainSnapshotPayload {
	/** IPFS CID of the block_log snapshot archive (CIDv1 base32 or CIDv0). */
	readonly ipfs_cid: string;
	/** Lowercase 64-hex SHA-256 of the archive — the download is checked against
	 *  this before blurtd ever touches it. */
	readonly sha256: string;
	/** Chain height the snapshot covers (advisory; blurtd re-derives on import). */
	readonly block_height: number;
	/** Archive size in bytes (advisory; lets a client show progress / pre-check disk). */
	readonly size_bytes: number;
	/** blurtd version the block_log was produced by (import-compat hint). */
	readonly blurtd_version: string;
	/** Optional IPNS name that always resolves to the NEWEST snapshot. */
	readonly ipns_name?: string;
	/** Optional https mirror (e.g. the Forgejo download) for when IPFS is slow. */
	readonly forgejo_url?: string;
}

export interface ChainSnapshotValidateResult {
	readonly ok: boolean;
	readonly reason?: string;
	readonly value?: ChainSnapshotPayload;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
// CIDv1 base32 (bafy…) or CIDv0 base58btc (Qm…). Loose but rejects obvious junk.
const CID_RE = /^(baf[a-z2-7]{55,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

function isPosInt(n: unknown): n is number {
	return typeof n === 'number' && Number.isInteger(n) && n > 0 && Number.isFinite(n);
}

/** Validate a parsed chain_snapshot payload. Pure; fails CLOSED with a reason. */
export function validateChainSnapshotPayload(input: unknown): ChainSnapshotValidateResult {
	if (!input || typeof input !== 'object') return { ok: false, reason: 'payload is not an object' };
	const p = input as Record<string, unknown>;

	if (typeof p.ipfs_cid !== 'string' || !CID_RE.test(p.ipfs_cid)) {
		return { ok: false, reason: 'ipfs_cid missing or not a CID (bafy… / Qm…)' };
	}
	if (typeof p.sha256 !== 'string' || !SHA256_RE.test(p.sha256)) {
		return { ok: false, reason: 'sha256 must be 64 lowercase hex chars' };
	}
	if (!isPosInt(p.block_height)) return { ok: false, reason: 'block_height must be a positive integer' };
	if (!isPosInt(p.size_bytes)) return { ok: false, reason: 'size_bytes must be a positive integer' };
	if (typeof p.blurtd_version !== 'string' || p.blurtd_version.length === 0 || p.blurtd_version.length > 32) {
		return { ok: false, reason: 'blurtd_version must be a non-empty string (≤32 chars)' };
	}
	if (p.ipns_name !== undefined) {
		if (typeof p.ipns_name !== 'string' || p.ipns_name.length === 0 || p.ipns_name.length > 128) {
			return { ok: false, reason: 'ipns_name, if present, must be a non-empty string (≤128 chars)' };
		}
	}
	if (p.forgejo_url !== undefined) {
		if (typeof p.forgejo_url !== 'string' || !/^https:\/\/[^\s]+$/.test(p.forgejo_url)) {
			return { ok: false, reason: 'forgejo_url, if present, must be an https:// URL' };
		}
	}

	const value: ChainSnapshotPayload = {
		ipfs_cid: p.ipfs_cid,
		sha256: p.sha256,
		block_height: p.block_height,
		size_bytes: p.size_bytes,
		blurtd_version: p.blurtd_version,
		...(p.ipns_name !== undefined ? { ipns_name: p.ipns_name as string } : {}),
		...(p.forgejo_url !== undefined ? { forgejo_url: p.forgejo_url as string } : {})
	};
	return { ok: true, value };
}

/** The exact shape `broadcast.customJson(data, key)` expects. */
export interface ChainSnapshotCustomJsonOp {
	readonly required_auths: readonly string[];
	readonly required_posting_auths: readonly string[];
	readonly id: string;
	readonly json: string;
}

/**
 * Validate a snapshot payload JSON string and shape it into the custom_json op
 * ready for broadcast. Pure + throws on any problem; no network, no key. The
 * on-chain `json` is the EXACT trimmed input, so a dry-run shows byte-for-byte
 * what gets signed.
 */
export function buildChainSnapshotOp(
	payloadJson: string,
	signer: string = RELEASE_SIGNER_DEFAULT
): ChainSnapshotCustomJsonOp {
	const trimmed = payloadJson.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error('chain_snapshot payload is not valid JSON');
	}
	const result = validateChainSnapshotPayload(parsed);
	if (!result.ok) throw new Error(`chain_snapshot payload failed validation: ${result.reason}`);
	if (!ACCOUNT_RE.test(signer)) throw new Error(`invalid signer account name: "${signer}"`);

	const jsonBytes = new TextEncoder().encode(trimmed).length;
	if (jsonBytes >= BLURT_CUSTOM_JSON_MAX_BYTES) {
		throw new Error(
			`chain_snapshot payload is ${jsonBytes} bytes — Blurt custom_json must be under ${BLURT_CUSTOM_JSON_MAX_BYTES}.`
		);
	}
	return {
		required_auths: [],
		required_posting_auths: [signer],
		id: CHAIN_SNAPSHOT_OP_ID,
		json: trimmed
	};
}
