/**
 * apps/indexer/src/blurt/indexerSnapshotOp.ts  (cp766)
 *
 * The `indexer_snapshot_v1` on-chain op — the canonical POINTER to a published
 * indexer-DB snapshot, posted by @morphit exactly like `chain_snapshot_v1` points
 * to a block_log snapshot and `morphit_release_v1` points to a release. A fresh
 * Morphit node reads the latest one signed by a TRUSTED signer to bootstrap its
 * indexer in minutes instead of replaying ~3.75M blocks for days.
 *
 * TRUST (this is the important difference from chain_snapshot_v1): this points at
 * DERIVED state (the indexer's Postgres DB), which is NOT self-verifying — re-
 * deriving it IS the multi-day replay we're avoiding. So this op is a signed
 * pointer whose trust comes from WHO signed it: a consumer accepts it only from a
 * signer it has chosen to trust (default @morphit), then proves the download
 * against `sha256`, and re-verifies the tail by normal indexing after restore.
 * The op carries the extra facts a stranger needs to gate the restore safely:
 * chain_id (must match — else it's another chain's state), schema_version, and
 * last_applied_block (where the target resumes). See snapshotManifest.ts for the
 * compatibility rules and the full trust model.
 *
 * PURE (no network, no key, no fs): the validator + builder are unit-tested.
 * Reuses the release op's custom_json size limit + signer conventions so all
 * three anchors (release / chain_snapshot / indexer_snapshot) stay parallel.
 */
import { BLURT_CUSTOM_JSON_MAX_BYTES, RELEASE_SIGNER_DEFAULT } from './releaseBroadcastOp.js';

/** custom_json op id the publisher signs and consumers key on. Frozen. */
export const INDEXER_SNAPSHOT_OP_ID = 'indexer_snapshot_v1';

export { BLURT_CUSTOM_JSON_MAX_BYTES, RELEASE_SIGNER_DEFAULT as INDEXER_SNAPSHOT_SIGNER_DEFAULT };

/** The `json` field of an indexer_snapshot_v1 custom_json op. */
export interface IndexerSnapshotPayload {
	/** IPFS CID of the snapshot tarball (manifest.json + indexer.sql.gz). */
	readonly ipfs_cid: string;
	/** Lowercase 64-hex SHA-256 of indexer.sql.gz — the download is proved against
	 *  this (and against the manifest's dumpSha256) before anything is trusted. */
	readonly sha256: string;
	/** Blurt chain id the snapshot's derived state is for. MUST match the target's
	 *  chain — a mismatch means the state belongs to another chain (fatal). */
	readonly chain_id: string;
	/** DB schema version the snapshot carries. The importer refuses a snapshot
	 *  newer than its build; older forward-migrates. */
	readonly schema_version: number;
	/** indexer_state.last_applied_block — where the fresh node resumes + tail-verifies. */
	readonly last_applied_block: number;
	/** Tarball size in bytes (advisory; progress + disk pre-check). */
	readonly size_bytes: number;
	/** Indexer build version that produced the snapshot (provenance; advisory). */
	readonly indexer_version: string;
	/** Optional IPNS name that always resolves to the NEWEST snapshot. */
	readonly ipns_name?: string;
	/** Optional https mirror (e.g. the Forgejo download) for when IPFS is slow. */
	readonly forgejo_url?: string;
}

export interface IndexerSnapshotValidateResult {
	readonly ok: boolean;
	readonly reason?: string;
	readonly value?: IndexerSnapshotPayload;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
// CIDv1 base32 (bafy…) or CIDv0 base58btc (Qm…). Loose but rejects obvious junk.
const CID_RE = /^(baf[a-z2-7]{55,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

function isPosInt(n: unknown): n is number {
	return typeof n === 'number' && Number.isInteger(n) && n > 0 && Number.isFinite(n);
}

/** Validate a parsed indexer_snapshot payload. Pure; fails CLOSED with a reason. */
export function validateIndexerSnapshotPayload(input: unknown): IndexerSnapshotValidateResult {
	if (!input || typeof input !== 'object') return { ok: false, reason: 'payload is not an object' };
	const p = input as Record<string, unknown>;

	if (typeof p.ipfs_cid !== 'string' || !CID_RE.test(p.ipfs_cid)) {
		return { ok: false, reason: 'ipfs_cid missing or not a CID (bafy… / Qm…)' };
	}
	if (typeof p.sha256 !== 'string' || !SHA256_RE.test(p.sha256)) {
		return { ok: false, reason: 'sha256 must be 64 lowercase hex chars' };
	}
	if (typeof p.chain_id !== 'string' || p.chain_id.length === 0 || p.chain_id.length > 128) {
		return { ok: false, reason: 'chain_id must be a non-empty string (≤128 chars)' };
	}
	if (!isPosInt(p.schema_version)) {
		return { ok: false, reason: 'schema_version must be a positive integer' };
	}
	if (!isPosInt(p.last_applied_block)) {
		return { ok: false, reason: 'last_applied_block must be a positive integer' };
	}
	if (!isPosInt(p.size_bytes)) return { ok: false, reason: 'size_bytes must be a positive integer' };
	if (
		typeof p.indexer_version !== 'string' ||
		p.indexer_version.length === 0 ||
		p.indexer_version.length > 32
	) {
		return { ok: false, reason: 'indexer_version must be a non-empty string (≤32 chars)' };
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

	const value: IndexerSnapshotPayload = {
		ipfs_cid: p.ipfs_cid,
		sha256: p.sha256,
		chain_id: p.chain_id,
		schema_version: p.schema_version,
		last_applied_block: p.last_applied_block,
		size_bytes: p.size_bytes,
		indexer_version: p.indexer_version,
		...(p.ipns_name !== undefined ? { ipns_name: p.ipns_name as string } : {}),
		...(p.forgejo_url !== undefined ? { forgejo_url: p.forgejo_url as string } : {})
	};
	return { ok: true, value };
}

/** The exact shape `broadcast.customJson(data, key)` expects. */
export interface IndexerSnapshotCustomJsonOp {
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
export function buildIndexerSnapshotOp(
	payloadJson: string,
	signer: string = RELEASE_SIGNER_DEFAULT
): IndexerSnapshotCustomJsonOp {
	const trimmed = payloadJson.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error('indexer_snapshot payload is not valid JSON');
	}
	const result = validateIndexerSnapshotPayload(parsed);
	if (!result.ok) throw new Error(`indexer_snapshot payload failed validation: ${result.reason}`);
	if (!ACCOUNT_RE.test(signer)) throw new Error(`invalid signer account name: "${signer}"`);

	const jsonBytes = new TextEncoder().encode(trimmed).length;
	if (jsonBytes >= BLURT_CUSTOM_JSON_MAX_BYTES) {
		throw new Error(
			`indexer_snapshot payload is ${jsonBytes} bytes — Blurt custom_json must be under ${BLURT_CUSTOM_JSON_MAX_BYTES}.`
		);
	}
	return {
		required_auths: [],
		required_posting_auths: [signer],
		id: INDEXER_SNAPSHOT_OP_ID,
		json: trimmed
	};
}

/** A snapshot op selected from an account's on-chain history. */
export interface SelectedSnapshotOp {
	readonly payload: IndexerSnapshotPayload;
	/** get_account_history sequence number — higher = newer. */
	readonly seq: number;
	/** The trusted posting-auth that signed it (the chain enforced the signature,
	 *  so presence in this signer's history + this auth == authenticity). */
	readonly signer: string;
	readonly blockNum: number | null;
	readonly trxId: string | null;
}

/**
 * Pick the NEWEST valid indexer_snapshot_v1 op from an account's condenser
 * get_account_history result, restricted to trusted signers. PURE +
 * fail-closed: skips anything that isn't a well-formed custom_json of the frozen
 * id, signed (posting auth) by a trusted account, with a payload that passes
 * validateIndexerSnapshotPayload. Returns null when nothing qualifies (the
 * caller then refuses the fast path). Defensive against every malformed shape a
 * volunteer RPC might return — a bad entry is skipped, never thrown on.
 *
 * `history` is the raw array condenser returns: [ [seq, { op: [name, data],
 * block, trx_id, ... }], ... ]. `trustedSigners` are lowercased account names.
 */
export function selectNewestSnapshotOp(
	history: unknown,
	trustedSigners: ReadonlySet<string>
): SelectedSnapshotOp | null {
	if (!Array.isArray(history)) return null;
	let best: SelectedSnapshotOp | null = null;

	for (const entry of history) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const seq = entry[0];
		const body = entry[1];
		if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
		if (!body || typeof body !== 'object') continue;
		const rec = body as Record<string, unknown>;
		const op = rec.op;
		if (!Array.isArray(op) || op.length < 2) continue;
		if (op[0] !== 'custom_json') continue;
		const cj = op[1];
		if (!cj || typeof cj !== 'object') continue;
		const c = cj as Record<string, unknown>;
		if (c.id !== INDEXER_SNAPSHOT_OP_ID) continue;

		const auths = Array.isArray(c.required_posting_auths) ? c.required_posting_auths : [];
		const signer = auths.find(
			(a): a is string => typeof a === 'string' && trustedSigners.has(a.toLowerCase())
		);
		if (signer === undefined) continue;

		if (typeof c.json !== 'string') continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(c.json);
		} catch {
			continue;
		}
		const v = validateIndexerSnapshotPayload(parsed);
		if (!v.ok || !v.value) continue;

		// Keep the highest seq (newest). Ties can't happen (seq is unique per acct).
		if (best === null || seq > best.seq) {
			best = {
				payload: v.value,
				seq,
				signer,
				blockNum: typeof rec.block === 'number' ? rec.block : null,
				trxId: typeof rec.trx_id === 'string' ? rec.trx_id : null
			};
		}
	}
	return best;
}
