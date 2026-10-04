/**
 * The release hashes @morphit published on chain, read so that no RPC node
 * and no local service decides them.
 *
 * `morphit-ops upgrade` used to take the expected SHA-256 from whoever served
 * it: the Forgejo primary's `.sha256` on the clearnet path, and the local
 * indexer's `/v1/release` on the hidden and offline paths. Neither is an
 * anchor: a primary that is taken over serves its own hash, and `/v1/release`
 * repeats whatever the indexer stored from one RPC node.
 *
 * This reads the `morphit_release_v1` op for one version the way
 * apps/indexer/src/blurt/snapshotOpTrust.ts reads snapshot ops:
 *   1. find the op for that version in @morphit's account history;
 *   2. fetch the block that holds it and find the transaction by its
 *      RECOMPUTED id, so a node cannot pair a real id with altered content;
 *   3. require that the transaction's signature recovers to the PINNED
 *      posting key. That is the check no node can fake without the key.
 * The hashes returned come from the transaction in the block, never from the
 * history answer.
 *
 * `read` is the only way out of this module. ops-cli passes chainRead
 * (lib/chainAccess.ts): this node's own indexer first, and on a hidden-only
 * node nothing else. Because of step 3, which node answered does not matter
 * for authenticity; a node that withholds the op only makes the anchor
 * unavailable, and the caller then needs a signed tarball instead.
 */
import { cryptoUtils, Signature } from '@beblurt/dblurt';

export const RELEASE_OP_ID = 'morphit_release_v1';

/** One read-only condenser call. */
export type CondenserRead = (method: string, params: readonly unknown[]) => Promise<unknown>;

export interface ReleaseAnchor {
	/** Version as published, without a leading "v". */
	readonly version: string;
	/** SHA-256 of the slim release tarball `morphit-vX.Y.Z.tar.gz`. */
	readonly sourceSha256: string;
	/** SHA-256 of the self-contained `morphit-vX.Y.Z-offline.tar.gz`, if published. */
	readonly offlineSha256: string | null;
	readonly ipfsCid: string | null;
	readonly ipnsName: string | null;
	readonly gpgFingerprint: string | null;
	readonly blockNum: number;
	readonly trxId: string;
}

export type ReleaseAnchorResult =
	| { readonly ok: true; readonly anchor: ReleaseAnchor }
	| { readonly ok: false; readonly reason: string };

interface TxLike {
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: ReadonlyArray<readonly [string, Record<string, unknown>]>;
	readonly extensions?: readonly unknown[];
	readonly signatures?: readonly string[];
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,110})$/;
const IPNS_RE = /^k51[a-z0-9]{50,70}$/;
const FPR_RE = /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/;
const TRX_ID_RE = /^[0-9a-f]{40}$/;

const bare = (v: string): string => v.trim().replace(/^v/, '');

/** The id the chain gives this transaction, recomputed from its content. */
export function transactionIdOf(tx: unknown): string | null {
	try {
		const t = tx as TxLike;
		return cryptoUtils.generateTrxId({
			ref_block_num: t.ref_block_num,
			ref_block_prefix: t.ref_block_prefix,
			expiration: t.expiration,
			operations: t.operations,
			extensions: t.extensions ?? []
		} as never);
	} catch {
		return null;
	}
}

/** Every public key the transaction's signatures recover to. */
export function recoverSigningKeys(tx: unknown, chainIdHex: string): string[] {
	const t = tx as TxLike;
	if (!t || !Array.isArray(t.signatures)) return [];
	let digest: Buffer;
	try {
		digest = cryptoUtils.transactionDigest(
			{
				ref_block_num: t.ref_block_num,
				ref_block_prefix: t.ref_block_prefix,
				expiration: t.expiration,
				operations: t.operations,
				extensions: t.extensions ?? []
			} as never,
			Buffer.from(chainIdHex, 'hex')
		);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const s of t.signatures.slice(0, 8)) {
		try {
			out.push(Signature.fromString(s).recover(digest).toString());
		} catch {
			/* a malformed signature proves nothing */
		}
	}
	return out;
}

/** The release payload in a custom_json op body, when it is a release op
 *  authorised by `signer` for `version`; otherwise null. */
function releasePayloadOf(
	op: unknown,
	signer: string,
	version: string
): Record<string, unknown> | null {
	if (!Array.isArray(op) || op[0] !== 'custom_json') return null;
	const c = op[1] as Record<string, unknown> | undefined;
	if (!c || c.id !== RELEASE_OP_ID || typeof c.json !== 'string') return null;
	const auths = Array.isArray(c.required_posting_auths) ? c.required_posting_auths : [];
	if (!auths.some((a) => typeof a === 'string' && a.toLowerCase() === signer)) return null;
	let p: unknown;
	try {
		p = JSON.parse(c.json);
	} catch {
		return null;
	}
	if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
	const v = (p as { version?: unknown }).version;
	if (typeof v !== 'string' || bare(v) !== version) return null;
	return p as Record<string, unknown>;
}

interface Candidate {
	readonly blockNum: number;
	readonly trxId: string;
	readonly seq: number;
}

/** Release-op candidates for `version` in one history page, newest first. */
export function releaseCandidates(history: unknown, signer: string, version: string): Candidate[] {
	if (!Array.isArray(history)) return [];
	const out: Candidate[] = [];
	for (const entry of history) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const seq = Number(entry[0]);
		const h = entry[1] as { block?: unknown; trx_id?: unknown; op?: unknown } | undefined;
		if (!h) continue;
		const blockNum = Number(h.block);
		const trxId = typeof h.trx_id === 'string' ? h.trx_id : '';
		if (
			!Number.isInteger(blockNum) ||
			blockNum <= 0 ||
			!TRX_ID_RE.test(trxId) ||
			/^0+$/.test(trxId)
		)
			continue;
		if (releasePayloadOf(h.op, signer, version) === null) continue;
		out.push({ blockNum, trxId, seq: Number.isFinite(seq) ? seq : -1 });
	}
	return out.sort((a, b) => b.seq - a.seq);
}

/** Lowest sequence number in a history page, or null. */
function lowestSeq(history: unknown): number | null {
	if (!Array.isArray(history)) return null;
	let low: number | null = null;
	for (const e of history) {
		if (!Array.isArray(e)) continue;
		const s = Number(e[0]);
		if (Number.isInteger(s) && (low === null || s < low)) low = s;
	}
	return low;
}

/** Turn a verified payload into an anchor; null when its hashes are malformed. */
function anchorFrom(
	payload: Record<string, unknown>,
	version: string,
	c: Candidate
): ReleaseAnchor | null {
	const d = payload.distribution as Record<string, unknown> | null | undefined;
	if (!d || typeof d !== 'object') return null;
	const src = typeof d.source_sha256 === 'string' ? d.source_sha256 : '';
	if (!SHA256_RE.test(src)) return null;
	const off =
		typeof d.offline_sha256 === 'string' && SHA256_RE.test(d.offline_sha256)
			? d.offline_sha256
			: null;
	const cid = typeof d.ipfs_cid === 'string' && CID_RE.test(d.ipfs_cid) ? d.ipfs_cid : null;
	const ipns = typeof d.ipns_name === 'string' && IPNS_RE.test(d.ipns_name) ? d.ipns_name : null;
	const fpr =
		typeof d.gpg_fingerprint === 'string' && FPR_RE.test(d.gpg_fingerprint)
			? d.gpg_fingerprint.toUpperCase()
			: null;
	return {
		version,
		sourceSha256: src,
		offlineSha256: off,
		ipfsCid: cid,
		ipnsName: ipns,
		gpgFingerprint: fpr,
		blockNum: c.blockNum,
		trxId: c.trxId
	};
}

/**
 * The verified on-chain release record for `tag`, or why there is none.
 * Never throws: a read that fails is a reason, not an exception.
 */
export async function readSignedReleaseAnchor(
	read: CondenserRead,
	args: {
		readonly tag: string;
		readonly signer: string;
		readonly pinnedPubkey: string;
		readonly chainId: string;
		/** History entries per page (Blurt allows up to 1000). */
		readonly pageSize?: number;
		/** How many pages back to look before giving up. */
		readonly maxPages?: number;
	}
): Promise<ReleaseAnchorResult> {
	const version = bare(args.tag);
	const signer = args.signer.toLowerCase();
	const pageSize = Math.max(1, Math.min(1000, args.pageSize ?? 1000));
	const maxPages = Math.max(1, args.maxPages ?? 4);

	const candidates: Candidate[] = [];
	let from = -1;
	for (let page = 0; page < maxPages; page++) {
		let history: unknown;
		try {
			history = await read('get_account_history', [
				signer,
				from,
				from === -1 ? pageSize : Math.min(pageSize, from)
			]);
		} catch (err) {
			if (candidates.length > 0) break;
			return {
				ok: false,
				reason: `could not read @${signer}'s history (${err instanceof Error ? err.message : String(err)})`
			};
		}
		candidates.push(...releaseCandidates(history, signer, version));
		if (candidates.length > 0) break;
		const low = lowestSeq(history);
		if (low === null || low <= 0) break;
		from = low - 1;
	}
	if (candidates.length === 0) {
		return { ok: false, reason: `@${signer} has published no release record for v${version}` };
	}

	let lastWhy = '';
	for (const c of candidates) {
		let block: unknown;
		try {
			block = await read('get_block', [c.blockNum]);
		} catch (err) {
			lastWhy = `could not read block ${c.blockNum} (${err instanceof Error ? err.message : String(err)})`;
			continue;
		}
		const txs = (block as { transactions?: unknown } | null)?.transactions;
		const tx = Array.isArray(txs)
			? (txs.find((t) => transactionIdOf(t) === c.trxId) as TxLike | undefined)
			: undefined;
		if (tx === undefined) {
			lastWhy = `block ${c.blockNum} does not hold transaction ${c.trxId}`;
			continue;
		}
		if (!recoverSigningKeys(tx, args.chainId).includes(args.pinnedPubkey)) {
			lastWhy = `the release record in block ${c.blockNum} is not signed by @${signer}'s pinned posting key`;
			continue;
		}
		let payload: Record<string, unknown> | null = null;
		for (const op of [...(tx.operations ?? [])].reverse()) {
			payload = releasePayloadOf(op, signer, version);
			if (payload !== null) break;
		}
		if (payload === null) {
			lastWhy = `the signed transaction in block ${c.blockNum} carries no release record for v${version}`;
			continue;
		}
		const anchor = anchorFrom(payload, version, c);
		if (anchor === null) {
			lastWhy = `the signed release record for v${version} has no valid source_sha256`;
			continue;
		}
		return { ok: true, anchor };
	}
	return { ok: false, reason: lastWhy };
}
