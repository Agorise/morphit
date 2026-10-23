/**
 * Read an op signed by a pinned key from the Blurt chain without trusting
 * whoever serves it — the browser port of the indexer's
 * apps/indexer/src/blurt/snapshotOpTrust.ts, at the browser's request budget.
 *
 * What makes a record genuine is its SIGNATURE, which no node or instance can
 * fake:
 *   1. the newest matching op is found in the signer's account history;
 *   2. the block holding it is read through the same source, and the
 *      transaction id is RECOMPUTED from the block's content, so a source
 *      cannot pair a real id with altered operations;
 *   3. the transaction's signature must recover to the PINNED public key.
 * The payload returned is the one parsed from that block, never the one in
 * the history answer.
 *
 * The source. One: the instance's agreed-read relay (`POST /v1/chain/agreed`),
 * which answers only with what two RPC operators of its pool return alike —
 * the browser contacts nothing else. Steady state: two requests, one
 * `get_account_history` (the smallest window) and one `get_block`. A record
 * signed by another key is therefore something two operators agree on, and is
 * reported as such. What remains: two operators that agree can serve an older
 * genuine record or withhold a newer one, and the instance relaying them can do
 * the same, refuse to answer, or show its own visitors a false alarm — never
 * a forged record.
 *
 * Pure apart from the injected reader; no SvelteKit imports, so it runs under
 * tsx and can be reused by scripts. dblurt (signature recovery, transaction
 * ids) is loaded on first use to keep it out of the first-paint bundle.
 */

/** The one source: every answer is one that two RPC operators gave alike
 *  (the instance's agreed-read relay, $net/chainRelay chainAgreed). */
export interface AgreedChainReader {
	/** One read; throws when there is no agreed answer. */
	read<T>(method: string, params: unknown): Promise<T>;
}

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
			/** The block number AS REPORTED: not covered by the signature, so
			 *  never used to decide anything. */
			readonly blockNum: number;
			readonly trxId: string;
			/** The transaction's `expiration`, part of what the signer signed. */
			readonly signedExpiration: string;
	  }
	| {
			readonly ok: false;
			/** 'no_quorum': nothing could be verified (no agreed answer, or one
			 *  that does not prove what it names) — nothing is known.
			 *  'none': the history window holds no such op.
			 *  'bad_signature': the newest such op is signed by keys other than
			 *  the pinned one (`keys`). */
			readonly reason: 'no_quorum' | 'none' | 'bad_signature';
			readonly keys?: readonly string[];
	  };

interface ReadArgs {
	readonly signer: string;
	readonly opId: string;
	readonly pinnedPubkey: string;
	readonly windows: readonly number[];
	readonly match?: (payload: unknown) => boolean;
}

/**
 * The newest custom_json `opId` by `signer` whose payload satisfies `match`,
 * proved as described in the file header. `windows` are the history sizes to
 * try in order (a larger one only when the smaller holds no such op).
 */
export async function readSignedOp(
	chain: AgreedChainReader,
	args: ReadArgs
): Promise<SignedOpResult> {
	const d = await loadDblurt();
	const signer = args.signer.toLowerCase();
	const match = args.match ?? (() => true);
	const unverified: SignedOpResult = { ok: false, reason: 'no_quorum' };

	let cand: HistoryCandidate | null = null;
	for (const window of args.windows) {
		let hist: unknown;
		try {
			hist = await chain.read<unknown>('condenser_api.get_account_history', [signer, -1, window]);
		} catch {
			return unverified;
		}
		const c = newestCandidate(hist, args.opId, signer, match);
		if (c === undefined) return unverified;
		cand = c;
		if (cand !== null) break;
	}
	if (cand === null) return { ok: false, reason: 'none' };
	const { blockNum, trxId } = cand;
	let block: unknown;
	try {
		block = await chain.read<unknown>('condenser_api.get_block', [blockNum]);
	} catch {
		return unverified;
	}
	const tx = findTransaction(d, block, trxId);
	if (tx === null) return unverified;
	const payload = customJsonPayloads(tx.operations, args.opId, signer).find(match);
	// The block holds the transaction, but not the op the history named.
	if (payload === undefined) return unverified;
	const keys = recoverSigningKeys(d, tx);
	if (!keys.includes(args.pinnedPubkey))
		return { ok: false, reason: 'bad_signature', keys: [...new Set(keys)] };
	return { ok: true, payload, blockNum, trxId, signedExpiration: tx.expiration };
}
