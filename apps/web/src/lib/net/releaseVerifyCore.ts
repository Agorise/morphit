/**
 * Read an op signed by a pinned key from the Blurt chain without trusting the
 * node that serves it — the browser port of the indexer's
 * apps/indexer/src/blurt/snapshotOpTrust.ts, at the browser's request budget.
 *
 * What makes a record genuine is its SIGNATURE, which no node can fake:
 *   1. the newest matching op is found in the signer's account history;
 *   2. the block holding it is fetched from the SAME node, and the
 *      transaction id is RECOMPUTED from the block's content, so a node cannot
 *      pair a real id with altered operations;
 *   3. the transaction's signature must recover to the PINNED public key.
 * The payload returned is the one parsed from that block, never the one in
 * the history answer.
 *
 * Budget. Steady state: two requests to ONE node — one `get_account_history`
 * (the smallest window) and one `get_block`. One other OPERATOR's node is
 * asked (the same two reads) only when the first node fails, serves a record
 * that cannot be verified (unsigned, signed by another key, malformed, or no
 * record at all), or serves a verified record the caller does not take as
 * current (`isCurrent`: e.g. a release older than the running build — a node
 * may be lagging or withholding the newest one). Never more than two nodes.
 * With two nodes, the newer verified record wins — decided by SIGNED data
 * (`newer`), never by a node-reported block number. "Signed by another key"
 * is reported only when both say so of the same transaction, so one node can
 * neither forge a record nor raise a false alarm. One node CAN still serve an
 * older genuine record when the second node is unreachable or agrees, and can
 * withhold a newer one from a build that already matches the record it
 * serves: those are the limits of a two-request budget.
 *
 * Pure apart from the injected reader; no SvelteKit imports, so it runs under
 * tsx and can be reused by scripts. dblurt (signature recovery, transaction
 * ids) is loaded on first use to keep it out of the first-paint bundle.
 */

/** What this needs from the node pool (EndpointRotator provides it). */
export interface ChainNodeReader {
	/** Endpoints to try, best first. */
	nodesInOrder(): readonly string[];
	/** The operator behind an endpoint, counted by node name (one node's
	 *  .onion and .b32.i2p are one operator); names are not proof that two
	 *  operators are independent. */
	operatorOf(url: string): string;
	/** One request to one endpoint; throws when it fails. */
	callAt<T>(url: string, method: string, params: unknown): Promise<T>;
}

/** Nodes a check may ask: the best one, plus one other operator's node. */
export const MAX_NODES_PER_CHECK = 2;

interface TxLike {
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: ReadonlyArray<readonly [string, Record<string, unknown>]>;
	readonly extensions?: readonly unknown[];
	readonly signatures?: readonly string[];
}

type Dblurt = typeof import('@beblurt/dblurt');
let dblurt: Dblurt | null = null;
async function loadDblurt(): Promise<Dblurt> {
	if (dblurt === null) dblurt = await import('@beblurt/dblurt');
	return dblurt;
}

function unsigned(t: TxLike): unknown {
	return {
		ref_block_num: t.ref_block_num,
		ref_block_prefix: t.ref_block_prefix,
		expiration: t.expiration,
		operations: t.operations,
		extensions: t.extensions ?? []
	};
}

/** The id the chain gives this transaction, recomputed from its content. */
export function transactionIdOf(d: Dblurt, tx: unknown): string | null {
	try {
		return d.cryptoUtils.generateTrxId(unsigned(tx as TxLike) as never);
	} catch {
		return null;
	}
}

/** Every DISTINCT public key the transaction's signatures recover to on the
 *  Blurt chain id. */
export function recoverSigningKeys(d: Dblurt, tx: unknown): string[] {
	const t = tx as TxLike;
	if (!t || !Array.isArray(t.signatures)) return [];
	let digest: ReturnType<Dblurt['cryptoUtils']['transactionDigest']>;
	try {
		digest = d.cryptoUtils.transactionDigest(unsigned(t) as never, d.DEFAULT_CHAIN_ID);
	} catch {
		return [];
	}
	const out = new Set<string>();
	for (const s of t.signatures.slice(0, 8)) {
		try {
			out.add(d.Signature.fromString(s).recover(digest).toString());
		} catch {
			/* a malformed signature proves nothing */
		}
	}
	return [...out];
}

/** The transaction in `block` whose RECOMPUTED id is `trxId`, or null. */
export function findTransaction(d: Dblurt, block: unknown, trxId: string): TxLike | null {
	const b = block as { transactions?: unknown };
	if (!b || typeof b !== 'object' || !Array.isArray(b.transactions)) return null;
	for (const tx of b.transactions) {
		if (tx && typeof tx === 'object' && transactionIdOf(d, tx) === trxId) return tx as TxLike;
	}
	return null;
}

/** The parsed `json` of every custom_json `opId` in `ops` with `signer` as a
 *  posting auth, newest (last) first. */
function customJsonPayloads(
	ops: ReadonlyArray<readonly [string, Record<string, unknown>]> | undefined,
	opId: string,
	signer: string
): unknown[] {
	const out: unknown[] = [];
	for (const op of [...(ops ?? [])].reverse()) {
		if (!Array.isArray(op) || op[0] !== 'custom_json') continue;
		const c = op[1] as Record<string, unknown>;
		if (c.id !== opId || typeof c.json !== 'string') continue;
		const auths = Array.isArray(c.required_posting_auths) ? c.required_posting_auths : [];
		if (!auths.some((a) => typeof a === 'string' && a.toLowerCase() === signer)) continue;
		try {
			out.push(JSON.parse(c.json));
		} catch {
			/* not this one */
		}
	}
	return out;
}

/** One history entry that names a candidate op. */
export interface HistoryCandidate {
	readonly blockNum: number;
	readonly trxId: string;
}

const TRX_ID_RE = /^[0-9a-f]{40}$/;

/** The newest op in a `get_account_history` answer that is a custom_json
 *  `opId` signed (by posting auth) by `signer` and whose payload satisfies
 *  `match`. Null when there is none; undefined when the answer is malformed. */
export function newestCandidate(
	history: unknown,
	opId: string,
	signer: string,
	match: (payload: unknown) => boolean
): HistoryCandidate | null | undefined {
	if (!Array.isArray(history)) return undefined;
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (!Array.isArray(entry)) continue;
		const h = entry[1] as { block?: unknown; trx_id?: unknown; op?: unknown } | undefined;
		if (!h || !Array.isArray(h.op)) continue;
		const payloads = customJsonPayloads([h.op as never], opId, signer);
		if (!payloads.some(match)) continue;
		if (
			typeof h.block !== 'number' ||
			!Number.isSafeInteger(h.block) ||
			h.block <= 0 ||
			typeof h.trx_id !== 'string' ||
			!TRX_ID_RE.test(h.trx_id)
		)
			continue;
		return { blockNum: h.block, trxId: h.trx_id };
	}
	return null;
}

export type SignedOpResult =
	| {
			readonly ok: true;
			/** Parsed from the block, signature verified. */
			readonly payload: unknown;
			/** The block number AS THE NODE REPORTED IT: not covered by the
			 *  signature, so never used to decide anything. */
			readonly blockNum: number;
			readonly trxId: string;
			/** The transaction's `expiration`, part of what the signer signed. */
			readonly signedExpiration: string;
	  }
	| {
			readonly ok: false;
			/** 'no_quorum': nothing could be verified (nodes unreachable, or their
			 *  answers unverifiable or contradictory) — nothing is known.
			 *  'none': both nodes asked hold no such op.
			 *  'bad_signature': both nodes asked name the same newest op, signed by
			 *  keys other than the pinned one (`keys`). */
			readonly reason: 'no_quorum' | 'none' | 'bad_signature';
			readonly keys?: readonly string[];
	  };

interface ReadArgs {
	readonly signer: string;
	readonly opId: string;
	readonly pinnedPubkey: string;
	readonly windows: readonly number[];
	readonly match?: (payload: unknown) => boolean;
	/** Whether a verified record ends the check at the first node. A record it
	 *  refuses (e.g. an older release than the one running) sends the check to
	 *  one other operator's node. Default: every verified record does. */
	readonly isCurrent?: (payload: unknown) => boolean;
	/** Which of two verified records is the newer (> 0: `a`). Decided by
	 *  SIGNED data only — never by the block number a node reports, which a
	 *  node can inflate. Default: the transactions' signed `expiration`. */
	readonly newer?: (a: VerifiedRecord, b: VerifiedRecord) => number;
}

/** A record whose signature was verified. */
export type VerifiedRecord = SignedOpResult & { ok: true };

function bySignedExpiration(a: VerifiedRecord, b: VerifiedRecord): number {
	return a.signedExpiration < b.signedExpiration
		? -1
		: a.signedExpiration > b.signedExpiration
			? 1
			: 0;
}

/** What one node's answers prove. */
type NodeVerdict =
	| { readonly kind: 'ok'; readonly record: VerifiedRecord }
	| {
			readonly kind: 'bad_signature';
			readonly blockNum: number;
			readonly trxId: string;
			readonly keys: readonly string[];
	  }
	| { readonly kind: 'none' }
	| { readonly kind: 'unverifiable' };

async function readFromNode(
	d: Dblurt,
	chain: ChainNodeReader,
	url: string,
	args: ReadArgs,
	signer: string,
	match: (payload: unknown) => boolean
): Promise<NodeVerdict> {
	let cand: HistoryCandidate | null = null;
	for (const window of args.windows) {
		let hist: unknown;
		try {
			hist = await chain.callAt<unknown>(url, 'condenser_api.get_account_history', [
				signer,
				-1,
				window
			]);
		} catch {
			return { kind: 'unverifiable' };
		}
		const c = newestCandidate(hist, args.opId, signer, match);
		if (c === undefined) return { kind: 'unverifiable' };
		cand = c;
		if (cand !== null) break;
	}
	if (cand === null) return { kind: 'none' };
	const { blockNum, trxId } = cand;
	let block: unknown;
	try {
		block = await chain.callAt<unknown>(url, 'condenser_api.get_block', [blockNum]);
	} catch {
		return { kind: 'unverifiable' };
	}
	const tx = findTransaction(d, block, trxId);
	if (tx === null) return { kind: 'unverifiable' };
	const payload = customJsonPayloads(tx.operations, args.opId, signer).find(match);
	// The block holds the transaction, but not the op the history named.
	if (payload === undefined) return { kind: 'unverifiable' };
	const keys = recoverSigningKeys(d, tx);
	if (!keys.includes(args.pinnedPubkey)) return { kind: 'bad_signature', blockNum, trxId, keys };
	return {
		kind: 'ok',
		record: { ok: true, payload, blockNum, trxId, signedExpiration: tx.expiration }
	};
}

/**
 * The newest custom_json `opId` by `signer` whose payload satisfies `match`,
 * proved as described in the file header. `windows` are the history sizes to
 * try in order (a larger one only when the smaller holds no such op).
 */
export async function readSignedOp(
	chain: ChainNodeReader,
	args: ReadArgs
): Promise<SignedOpResult> {
	const d = await loadDblurt();
	const signer = args.signer.toLowerCase();
	const match = args.match ?? (() => true);
	const isCurrent = args.isCurrent ?? (() => true);

	const order = chain.nodesInOrder();
	const first = order[0];
	if (first === undefined) return { ok: false, reason: 'no_quorum' };
	const a = await readFromNode(d, chain, first, args, signer, match);
	if (a.kind === 'ok' && isCurrent(a.record.payload)) return a.record;

	// One other operator's node, and no more.
	const firstOperator = chain.operatorOf(first);
	const second = order.find((u) => chain.operatorOf(u) !== firstOperator);
	const b: NodeVerdict =
		second === undefined
			? { kind: 'unverifiable' }
			: await readFromNode(d, chain, second, args, signer, match);

	const verified = [a, b]
		.filter((v): v is NodeVerdict & { kind: 'ok' } => v.kind === 'ok')
		.map((v) => v.record);
	if (verified.length > 0) {
		// The newest genuine record, by what the signer signed: a node that
		// lags or withholds cannot hold the check on an older release when the
		// other one has a newer one, and inflating a block number gains nothing.
		const newer = args.newer ?? bySignedExpiration;
		return verified.reduce((x, y) => (newer(y, x) > 0 ? y : x));
	}
	if (
		a.kind === 'bad_signature' &&
		b.kind === 'bad_signature' &&
		a.trxId === b.trxId &&
		a.blockNum === b.blockNum
	) {
		return { ok: false, reason: 'bad_signature', keys: [...new Set([...a.keys, ...b.keys])] };
	}
	if (a.kind === 'none' && b.kind === 'none') return { ok: false, reason: 'none' };
	return { ok: false, reason: 'no_quorum' };
}
