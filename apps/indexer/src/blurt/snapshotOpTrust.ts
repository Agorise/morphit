/**
 * apps/indexer/src/blurt/snapshotOpTrust.ts
 *
 * Read a pinned publisher's signed op from the chain WITHOUT trusting any one
 * RPC node.
 *
 * WHAT WAS WRONG. Fast-sync read @morphit's account history from ONE endpoint
 * (the fastest) and accepted any `indexer_snapshot_v1` entry that merely
 * NAMED @morphit in `required_posting_auths`. Nothing checked a signature,
 * confirmed the transaction was really in a block, or compared the signing key
 * with the pinned `officialPostingPubkey` the release and rpc-directory
 * handlers already insist on. One hostile node could invent an op pointing at
 * its own dump; the dump was then piped into psql as root. Snapshot mirrors
 * read the same way and would have re-served the forgery to everyone.
 *
 * WHAT THIS DOES INSTEAD, in three independent checks:
 *   1. the newest op is read from the account history of at least two
 *      distinct OPERATORS that agree on which transaction it is;
 *   2. the block holding that transaction is fetched from at least two
 *      distinct operators that agree on the block and on the transaction's
 *      exact content — the transaction id is RECOMPUTED from that content, so
 *      a node cannot pair a real id with altered operations;
 *   3. the transaction's signature must recover to the PINNED public key.
 *      That is the check a node cannot fake without the key itself, and it is
 *      what makes 1 and 2 about freshness rather than authenticity.
 *
 * The payload that comes back is the one parsed from the confirmed block, never
 * the one in the history answer.
 */
import { createHash } from 'node:crypto';
import { cryptoUtils, Signature } from '@beblurt/dblurt';
import {
	INDEXER_SNAPSHOT_OP_ID,
	selectNewestSnapshotOp,
	validateIndexerSnapshotPayload,
	type SelectedSnapshotOp
} from './indexerSnapshotOp.js';

/** The narrow chain surface this needs; BlurtClient provides it. */
export interface AgreedChainReader {
	condenserAgreed<T>(
		method: string,
		params: readonly unknown[],
		keyOf: (answer: T) => string | null,
		minAgree: number,
		opts?: { readonly mutable?: boolean; readonly freshOf?: (answer: T) => number | null }
	): Promise<{ readonly value: T; readonly key: string } | null>;
}

interface TxLike {
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: ReadonlyArray<readonly [string, Record<string, unknown>]>;
	readonly extensions?: readonly unknown[];
	readonly signatures?: readonly string[];
}

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

/** Every public key the transaction's signatures recover to, for `chainIdHex`. */
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

/** The transaction in `block` whose RECOMPUTED id is `trxId`, or null. */
export function findTransaction(block: unknown, trxId: string): TxLike | null {
	const b = block as { transactions?: unknown };
	if (!b || !Array.isArray(b.transactions)) return null;
	for (const tx of b.transactions) {
		if (transactionIdOf(tx) === trxId) return tx as TxLike;
	}
	return null;
}

/** What two operators must agree on for a block holding `trxId`: its id and the
 *  transaction's exact content. Null when this answer does not hold it. */
export function blockAgreementKey(block: unknown, trxId: string): string | null {
	const tx = findTransaction(block, trxId);
	if (tx === null) return null;
	const id = (block as { block_id?: unknown }).block_id;
	const content = createHash('sha256').update(JSON.stringify(tx)).digest('hex');
	return `${typeof id === 'string' ? id : '?'}|${trxId}|${content}`;
}

export interface OfficialCustomJson {
	/** The parsed `json` of the op, from the CONFIRMED block. */
	readonly payload: unknown;
	readonly blockNum: number;
	readonly trxId: string;
}

export type ConfirmResult =
	| { readonly ok: true; readonly op: OfficialCustomJson }
	| { readonly ok: false; readonly reason: 'no_quorum' | 'op_not_in_tx' | 'bad_signature' };

/**
 * Confirm that block `blockNum` holds transaction `trxId`, agreed by `minAgree`
 * distinct operators, that it carries a custom_json `opId` with `signer` as a
 * posting auth, and that its signature recovers to `pinnedPubkey`.
 */
export async function confirmSignedCustomJson(
	chain: AgreedChainReader,
	args: {
		readonly blockNum: number;
		readonly trxId: string;
		readonly opId: string;
		readonly signer: string;
		readonly pinnedPubkey: string;
		readonly chainId: string;
		readonly minAgree: number;
	}
): Promise<ConfirmResult> {
	const agreed = await chain.condenserAgreed<unknown>(
		'get_block',
		[args.blockNum],
		(b) => blockAgreementKey(b, args.trxId),
		args.minAgree
	);
	if (agreed === null) return { ok: false, reason: 'no_quorum' };
	const tx = findTransaction(agreed.value, args.trxId);
	if (tx === null) return { ok: false, reason: 'no_quorum' };
	let payload: unknown;
	let found = false;
	for (const op of tx.operations ?? []) {
		if (!Array.isArray(op) || op[0] !== 'custom_json') continue;
		const c = op[1] as Record<string, unknown>;
		if (c.id !== args.opId) continue;
		const auths = Array.isArray(c.required_posting_auths) ? c.required_posting_auths : [];
		if (!auths.some((a) => typeof a === 'string' && a.toLowerCase() === args.signer)) continue;
		if (typeof c.json !== 'string') continue;
		try {
			payload = JSON.parse(c.json);
			found = true;
		} catch {
			continue;
		}
	}
	if (!found) return { ok: false, reason: 'op_not_in_tx' };
	if (!recoverSigningKeys(tx, args.chainId).includes(args.pinnedPubkey)) {
		return { ok: false, reason: 'bad_signature' };
	}
	return { ok: true, op: { payload, blockNum: args.blockNum, trxId: args.trxId } };
}

export type TrustedSnapshotResult =
	| {
			readonly ok: true;
			readonly selected: SelectedSnapshotOp;
			/** The agreed history answer — used only for REACHABILITY (peer
			 *  mirror addresses); every download is proved against the signed
			 *  sha256 anyway. */
			readonly history: unknown;
	  }
	| { readonly ok: false; readonly reason: string };

/**
 * The newest `indexer_snapshot_v1` op published by `signer`, read so that no
 * single RPC operator decides it. See the file header for the three
 * checks. `minAgree` is the number of distinct operators that must agree at
 * each chain read — 2 for fast-sync and the mirror.
 */
export async function resolveTrustedSnapshotOp(
	chain: AgreedChainReader,
	args: {
		readonly signer: string;
		readonly pinnedPubkey: string;
		readonly chainId: string;
		readonly historyLimit: number;
		readonly minAgree: number;
	}
): Promise<TrustedSnapshotResult> {
	const signer = args.signer.toLowerCase();
	const trusted = new Set([signer]);
	const hist = await chain.condenserAgreed<unknown>(
		'get_account_history',
		[signer, -1, args.historyLimit],
		(h) => {
			if (!Array.isArray(h)) return null;
			const sel = selectNewestSnapshotOp(h, trusted);
			return sel === null ? 'none' : `${sel.blockNum ?? '?'}|${sel.trxId ?? '?'}`;
		},
		args.minAgree,
		{
			// The account's NEWEST op changes as the chain grows: a node that is
			// behind names an older one. Its block number says which (VT5-1), so
			// a stale majority cannot pin an older snapshot over a newer one.
			mutable: true,
			freshOf: (h) => {
				if (!Array.isArray(h)) return null;
				const n = selectNewestSnapshotOp(h, trusted)?.blockNum;
				return typeof n === 'number' ? n : 0;
			}
		}
	);
	if (hist === null) {
		return {
			ok: false,
			reason:
				`the RPC nodes this box can reach did not agree on @${signer}'s newest snapshot ` +
				`(${args.minAgree} operators, counted by node name, must). Try again in a few minutes.`
		};
	}
	const sel = selectNewestSnapshotOp(hist.value, trusted);
	if (sel === null)
		return {
			ok: false,
			reason: `no indexer_snapshot_v1 op from @${signer} in the last ${args.historyLimit} history entries`
		};
	if (sel.blockNum === null || sel.trxId === null) {
		return {
			ok: false,
			reason: 'the history entry for the newest snapshot has no block number or transaction id'
		};
	}
	const confirmed = await confirmSignedCustomJson(chain, {
		blockNum: sel.blockNum,
		trxId: sel.trxId,
		opId: INDEXER_SNAPSHOT_OP_ID,
		signer,
		pinnedPubkey: args.pinnedPubkey,
		chainId: args.chainId,
		minAgree: args.minAgree
	});
	if (!confirmed.ok) {
		const why =
			confirmed.reason === 'bad_signature'
				? `its signature does not come from the pinned @${signer} posting key`
				: confirmed.reason === 'op_not_in_tx'
					? 'the confirmed transaction does not carry that op'
					: `${args.minAgree} RPC operators (counted by node name) did not confirm the transaction in block ${sel.blockNum}`;
		return { ok: false, reason: `refusing the newest snapshot op: ${why}.` };
	}
	const v = validateIndexerSnapshotPayload(confirmed.op.payload);
	if (!v.ok || v.value === undefined) {
		return { ok: false, reason: `the signed snapshot op is malformed: ${v.reason ?? 'unknown'}` };
	}
	return {
		ok: true,
		selected: { payload: v.value, seq: sel.seq, signer, blockNum: sel.blockNum, trxId: sel.trxId },
		history: hist.value
	};
}

/** The transactions in `block` carrying a custom_json `opId` with `signer` as a
 *  posting auth, in block order. */
function signedCandidates(block: unknown, opId: string, signer: string): TxLike[] {
	const b = block as { transactions?: unknown };
	if (!b || !Array.isArray(b.transactions)) return [];
	const out: TxLike[] = [];
	for (const tx of b.transactions as TxLike[]) {
		const hit = (tx?.operations ?? []).some((op) => {
			if (!Array.isArray(op) || op[0] !== 'custom_json') return false;
			const c = op[1] as Record<string, unknown>;
			const auths = Array.isArray(c.required_posting_auths) ? c.required_posting_auths : [];
			return (
				c.id === opId && auths.some((a) => typeof a === 'string' && a.toLowerCase() === signer)
			);
		});
		if (hit) out.push(tx);
	}
	return out;
}

/**
 * Like {@link confirmSignedCustomJson}, when only the BLOCK is known (the
 * persisted rpc directory keeps its block number, not its transaction id).
 * Operators must agree on the block id and on the exact content of every
 * candidate transaction; the newest candidate whose signature recovers to the
 * pinned key wins. `no_signed_op` means the block was agreed and holds no such
 * op from the pinned key — the stored claim is false.
 */
export async function confirmSignedCustomJsonInBlock(
	chain: AgreedChainReader,
	args: {
		readonly blockNum: number;
		readonly opId: string;
		readonly signer: string;
		readonly pinnedPubkey: string;
		readonly chainId: string;
		readonly minAgree: number;
	}
): Promise<{ ok: true; payload: unknown } | { ok: false; reason: 'no_quorum' | 'no_signed_op' }> {
	const signer = args.signer.toLowerCase();
	const agreed = await chain.condenserAgreed<unknown>(
		'get_block',
		[args.blockNum],
		(b) => {
			if (!b || typeof b !== 'object') return null;
			const id = (b as { block_id?: unknown }).block_id;
			const parts = signedCandidates(b, args.opId, signer).map(
				(tx) =>
					`${transactionIdOf(tx)}:${createHash('sha256').update(JSON.stringify(tx)).digest('hex')}`
			);
			return `${typeof id === 'string' ? id : '?'}|${parts.join(',')}`;
		},
		args.minAgree
	);
	if (agreed === null) return { ok: false, reason: 'no_quorum' };
	const cands = signedCandidates(agreed.value, args.opId, signer).reverse();
	for (const tx of cands) {
		if (!recoverSigningKeys(tx, args.chainId).includes(args.pinnedPubkey)) continue;
		for (const op of [...tx.operations].reverse()) {
			const c = op[1] as Record<string, unknown>;
			if (op[0] !== 'custom_json' || c.id !== args.opId || typeof c.json !== 'string') continue;
			try {
				return { ok: true, payload: JSON.parse(c.json) };
			} catch {
				/* not this one */
			}
		}
	}
	return { ok: false, reason: 'no_signed_op' };
}
