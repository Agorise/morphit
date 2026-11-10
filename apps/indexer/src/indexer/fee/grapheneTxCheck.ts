/**
 * Morphit indexer — has a trade's HIVE / STEEM payment reached the seller's
 * account? The lookup behind GET /v1/payment-check?asset=hive|steem
 * (fee/paymentCheck.ts), v1.24.0.
 *
 * On these chains the address is an account name, so the same account gets
 * every payment ever made to it. What ties a payment to THIS trade is the
 * memo the seller's ask carries (a short random code the chat generates, as
 * for BLURT): only transfers with that memo count. Its transaction id says
 * which transfer the buyer means, and the time of its block lets the seller's
 * screen refuse one made before the account was shared.
 *
 * Asked, by transaction id:
 *   - Hive: HAfAH, the account-history service the Hive core developers
 *     publish (gitlab.syncad.com/hive/HAfAH), which many API nodes serve as
 *     plain GET JSON: `<base>/transactions/<id>` (the transaction, its block
 *     number and the block's `timestamp`; for an unknown id an HTTP 400 whose
 *     message says "Unknown Transaction"), then, only for a transaction it
 *     has, `<base>/headblock` (the newest block it holds, reversible ones
 *     included) and `<base>/sync-status` (`last_block_num`: HAF's consistent,
 *     that is last irreversible, block — hive.app_get_irreversible_block() in
 *     HAfAH's endpoints/other/get_sync_status.sql). Seen answering on 9 Nov
 *     2026 at api.hive.blog, api.openhive.network, techcoderx.com,
 *     rpc.mahdiyari.info and hiveapi.actifit.io.
 *   - Steem: the nodes' JSON-RPC (POST), `condenser_api.get_transaction`
 *     (steemit/steem account_history_api: "Unknown Transaction <id>" for an
 *     unknown id), `condenser_api.get_dynamic_global_properties`
 *     (`head_block_number`, `last_irreversible_block_num`) and
 *     `condenser_api.get_block_header` (`timestamp`). SteemWorld's SDS, the
 *     one GET service, was seen 20 days behind the chain on 9 Nov 2026, so it
 *     is not asked.
 *
 * What counts as paid: the `transfer` operations of that transaction to the
 * account, in the coin itself (HIVE: NAI @@000000021; STEEM: "x.xxx STEEM"),
 * never HBD / SBD, a power-up, savings or escrow, and with the ask's memo when
 * one is given; a transfer from the account to itself pays nothing. A
 * transfer to the account with another memo is reported (`otherMemo`), so the
 * seller is told why it does not count.
 *
 * Depth: blocks from the head down to the transaction's block, counted as
 * `required` (paymentCheck.ts, 3) only once that block is IRREVERSIBLE — until
 * then at most `required - 1`, so the seller's screen never calls a payment
 * confirmed that a fork could still drop. Hive makes a block irreversible
 * within a few seconds, Steem within about a minute.
 *
 * Agreement: at least two OPERATORS (feeSources.ts explorerOperatorOf; lowered
 * to the number of URLs configured, as for an explorer tier, so two addresses
 * of one operator never decide alone) must give the same block, amount and
 * memo verdict; the lowest depth they give counts. "Not found" needs the same
 * number saying so, and ends the round as soon as they do. Anything less is
 * no answer. A node that cannot be reached, times out or answers 408 / 429 /
 * 5xx is put on the pool's cooldown ladder (rpc-pool isTransportError); every
 * request, its answer read in full, ends within `requestTimeoutMs`.
 *
 * These services are clearnet only (no Tor or I2P one is known): a
 * zero-clearnet node has none, and makeSourceFetch refuses clearnet there
 * anyway.
 *
 * Privacy: nothing is logged; the transaction id, the account and the memo go
 * only to the nodes asked (all three are public on the chain once paid).
 */
import { EndpointPool, TRANSPORT_FAILURE } from '@morphit/rpc-pool';
import { explorerOperatorOf } from '@morphit/operator-config/fee-sources';
import { explorerInit, readExplorerJson } from './explorerHttp';
import { paymentTimeOf, type PaymentLookupResult } from './verifier';

export type GrapheneChain = 'hive' | 'steem';

/** Hive's NAI for HIVE itself (hive protocol asset_symbol.hpp; HBD is
 *  @@000000013, VESTS @@000000037). */
export const HIVE_NAI = '@@000000021';
const GRAPHENE_TXID = /^[0-9a-f]{40}$/;
/** An account name as both chains define it (is_valid_account_name): 3-16
 *  characters, dot-separated parts of at least 3. */
const ACCOUNT = /^(?=.{3,16}$)[a-z][a-z0-9-]+[a-z0-9](?:\.[a-z][a-z0-9-]+[a-z0-9])*$/;
/** The ask's memo, as the chat generates it (web chat/payload.ts MEMO_RE). */
const TRADE_MEMO = /^[a-z0-9]{6,32}$/;
/** HTTP statuses that say "this node, not this question": rotate and back off
 *  (rpc-pool isTransportError matches `http <status>`). */
const NODE_TROUBLE = new Set([
	408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527
]);

/** What a transaction pays the account (paidTo). */
export interface Paid {
	/** In the coin's smallest unit (0.001). */
	readonly units: bigint;
	/** A transfer of the coin reached the account with another memo. */
	readonly otherMemo: boolean;
}

/** One node's answer about one transaction. */
export type GrapheneNodeAnswer =
	| {
			readonly kind: 'found';
			readonly block: number;
			/** The block's time, unix seconds; null when unreadable. */
			readonly time: number | null;
			readonly paid: Paid;
			readonly head: number;
			readonly irreversible: number;
	  }
	| { readonly kind: 'not_found' }
	/** An answer that says nothing about the transaction. */
	| { readonly kind: 'malformed' };

type Found = Extract<GrapheneNodeAnswer, { kind: 'found' }>;
type Verdict = Found | { readonly kind: 'not_found' };

function isBlockNum(n: unknown): n is number {
	return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/** "2024-03-22T17:11:03" (UTC, as both chains write it) → unix seconds. */
export function grapheneTimeOf(t: unknown): number | null {
	if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t)) return null;
	const ms = Date.parse(`${t}Z`);
	return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

/** What a transaction's operations pay `account` — only transfers carrying
 *  `memo` when one is given — or null when a transfer to it cannot be read
 *  (the answer then counts for nothing rather than for 0). Hive's operations
 *  come as HAfAH writes them (`{type: 'transfer_operation', value}` with a NAI
 *  amount), Steem's in the condenser format (`['transfer', value]`, "1.000
 *  STEEM"). PURE. */
export function paidTo(
	chain: GrapheneChain,
	operations: unknown,
	account: string,
	memo: string | null = null
): Paid | null {
	if (!Array.isArray(operations)) return null;
	let units = 0n;
	let otherMemo = false;
	for (const op of operations as readonly unknown[]) {
		let type: unknown;
		let value: unknown;
		if (chain === 'hive') {
			if (typeof op !== 'object' || op === null || Array.isArray(op)) return null;
			({ type, value } = op as { type?: unknown; value?: unknown });
			if (type !== 'transfer_operation') continue;
		} else {
			if (!Array.isArray(op) || op.length !== 2) return null;
			[type, value] = op as unknown[];
			if (type !== 'transfer') continue;
		}
		if (typeof value !== 'object' || value === null) return null;
		const v = value as { from?: unknown; to?: unknown; amount?: unknown; memo?: unknown };
		if (v.to !== account) continue;
		if (v.from === account) continue; // to itself: no payment
		if (typeof v.from !== 'string') return null;
		const got = chain === 'hive' ? hiveUnits(v.amount) : steemUnits(v.amount);
		if (got === 'other_coin') continue;
		if (got === null) return null;
		// Exactly the ask's memo (the chat writes it in lowercase; an encrypted
		// memo, "#…", can never match).
		if (memo !== null && (typeof v.memo !== 'string' || v.memo.trim() !== memo)) {
			otherMemo = true;
			continue;
		}
		units += got;
	}
	return { units, otherMemo };
}

function hiveUnits(a: unknown): bigint | 'other_coin' | null {
	if (typeof a !== 'object' || a === null) return null;
	const { amount, precision, nai } = a as { amount?: unknown; precision?: unknown; nai?: unknown };
	if (typeof nai !== 'string') return null;
	if (nai !== HIVE_NAI) return 'other_coin';
	if (precision !== 3 || typeof amount !== 'string' || !/^\d{1,19}$/.test(amount)) return null;
	return BigInt(amount);
}

function steemUnits(a: unknown): bigint | 'other_coin' | null {
	if (typeof a !== 'string') return null;
	const m = /^(\d{1,16})\.(\d{3}) ([A-Z]{3,5})$/.exec(a);
	if (m === null) return null;
	if (m[3] !== 'STEEM') return 'other_coin';
	return BigInt(m[1]!) * 1000n + BigInt(m[2]!);
}

export interface GrapheneTxCheckerConfig {
	readonly chain: GrapheneChain;
	/** HAfAH bases (Hive) or JSON-RPC URLs (Steem). */
	readonly urls: readonly string[];
	/** Agreeing operators needed (lowered to the number of URLs configured). */
	readonly minAgree: number;
	/** The depth that counts as confirmed (paymentCheck.ts). */
	readonly requiredConfirmations: number;
	/** One request, its answer read in full. */
	readonly requestTimeoutMs: number;
}

/** A request's outcome: the parsed body, a node's own "no such transaction",
 *  or an answer that says nothing (a 4xx page, a body that is not JSON). */
type Got = { kind: 'ok'; body: unknown } | { kind: 'unknown_tx' } | { kind: 'bad' };

const keyOf = (v: Verdict): string =>
	v.kind === 'not_found' ? 'nf' : `${v.block}|${v.paid.units}|${v.paid.otherMemo ? 1 : 0}`;

export class GrapheneTxChecker {
	private readonly pool: EndpointPool | null;
	private readonly minAgree: number;

	constructor(
		private readonly config: GrapheneTxCheckerConfig,
		private readonly fetchImpl: typeof fetch = fetch
	) {
		this.pool =
			config.urls.length === 0
				? null
				: new EndpointPool({ endpoints: [...config.urls], operatorOf: explorerOperatorOf });
		// Lowered by URLs, never by operators (as fee/paymentCheck.ts does for an
		// explorer tier): one operator's two addresses must not decide alone.
		this.minAgree = Math.max(1, Math.min(config.minAgree, config.urls.length));
	}

	/** The payment `txid` makes to `account` (with `memo`, when the ask has
	 *  one), as the nodes agree on it. */
	async lookupPayment(
		txid: string,
		account: string,
		memo: string | null = null,
		signal?: AbortSignal
	): Promise<PaymentLookupResult> {
		const id = txid.toLowerCase();
		if (
			this.pool === null ||
			!GRAPHENE_TXID.test(id) ||
			!ACCOUNT.test(account) ||
			(memo !== null && !TRADE_MEMO.test(memo))
		) {
			return { kind: 'no_answer' };
		}
		const quorum = await this.pool.quorumCall<Verdict>(
			async (url, poolSignal) => {
				const a = await this.ask(url, id, account, memo, poolSignal);
				return a.kind === 'malformed' ? null : a;
			},
			{
				equivalenceKey: keyOf,
				minAgree: this.minAgree,
				// One more than needed at once (the chat asks every few seconds); the
				// next operator is asked when one fails or disagrees.
				maxOperators: this.minAgree + 1,
				// A Steem node is asked twice in a row (the transaction and its
				// dynamic properties together, then the block header).
				timeoutMs: this.config.requestTimeoutMs * 2 + 1_000,
				...(signal !== undefined ? { signal } : {})
			}
		);
		if (quorum.kind !== 'quorum_met') return { kind: 'no_answer' };
		if (quorum.agreedKey === 'nf') return { kind: 'not_found' };
		const agreeing = quorum.responses.filter(
			(a): a is Found => a.kind === 'found' && keyOf(a) === quorum.agreedKey
		);
		const need = this.config.requiredConfirmations;
		const depth = Math.min(
			...agreeing.map((a) => {
				const d = Math.max(1, a.head - a.block + 1);
				return a.block <= a.irreversible ? d : Math.min(d, need - 1);
			})
		);
		const { blockTime, timeDisputed } = paymentTimeOf(
			agreeing.map((a) => ({ inBlock: true, time: a.time })),
			Math.floor(Date.now() / 1000)
		);
		const paid = agreeing[0]!.paid;
		return {
			kind: 'found',
			amount: paid.units,
			confirmations: depth,
			blockTime,
			...(timeDisputed ? { timeDisputed: true } : {}),
			...(paid.otherMemo ? { otherMemo: true } : {})
		};
	}

	/** One node, asked about one transaction. Throws when it cannot be asked. */
	private async ask(
		url: string,
		txid: string,
		account: string,
		memo: string | null,
		poolSignal: AbortSignal
	): Promise<GrapheneNodeAnswer> {
		return this.config.chain === 'hive'
			? this.askHafah(url.replace(/\/+$/, ''), txid, account, memo, poolSignal)
			: this.askCondenser(url, txid, account, memo, poolSignal);
	}

	private async askHafah(
		base: string,
		txid: string,
		account: string,
		memo: string | null,
		signal: AbortSignal
	): Promise<GrapheneNodeAnswer> {
		// The transaction first: most questions are about one not made yet, and
		// then the head and the irreversible block are not needed.
		const tx = await this.get(`${base}/transactions/${txid}`, signal, true);
		if (tx.kind === 'unknown_tx') return { kind: 'not_found' };
		if (tx.kind !== 'ok') return { kind: 'malformed' };
		const [head, sync] = await Promise.all([
			this.get(`${base}/headblock`, signal, false),
			this.get(`${base}/sync-status`, signal, false)
		]);
		if (head.kind !== 'ok' || sync.kind !== 'ok') return { kind: 'malformed' };
		return answerOf('hive', {
			txid,
			account,
			memo,
			tx: tx.body,
			operations: (tx.body as { transaction_json?: { operations?: unknown } } | null)
				?.transaction_json?.operations,
			time: (tx.body as { timestamp?: unknown } | null)?.timestamp,
			head: head.body,
			irreversible: (sync.body as { last_block_num?: unknown } | null)?.last_block_num
		});
	}

	private async askCondenser(
		url: string,
		txid: string,
		account: string,
		memo: string | null,
		signal: AbortSignal
	): Promise<GrapheneNodeAnswer> {
		const [tx, props] = await Promise.all([
			this.rpc(url, 'condenser_api.get_transaction', [txid], signal),
			this.rpc(url, 'condenser_api.get_dynamic_global_properties', [], signal)
		]);
		if (tx.kind === 'unknown_tx') return { kind: 'not_found' };
		if (tx.kind !== 'ok' || props.kind !== 'ok') return { kind: 'malformed' };
		const block = (tx.body as { block_num?: unknown } | null)?.block_num;
		if (!isBlockNum(block)) return { kind: 'malformed' };
		const header = await this.rpc(url, 'condenser_api.get_block_header', [block], signal);
		if (header.kind !== 'ok') return { kind: 'malformed' };
		const p = props.body as {
			head_block_number?: unknown;
			last_irreversible_block_num?: unknown;
		} | null;
		return answerOf('steem', {
			txid,
			account,
			memo,
			tx: tx.body,
			operations: (tx.body as { operations?: unknown } | null)?.operations,
			time: (header.body as { timestamp?: unknown } | null)?.timestamp,
			head: p?.head_block_number,
			irreversible: p?.last_irreversible_block_num
		});
	}

	/** One GET. `txLookup`: an HTTP 400 saying "Unknown Transaction" is the
	 *  node's own "no such transaction" (HAfAH's PostgREST error body). */
	private async get(url: string, signal: AbortSignal, txLookup: boolean): Promise<Got> {
		const r = await this.request(url, { method: 'GET', accept: 'application/json' }, signal);
		if (r.status === 400 && txLookup && saysUnknownTx(r.body)) return { kind: 'unknown_tx' };
		if (r.status !== 200 || r.body === undefined) return { kind: 'bad' };
		return { kind: 'ok', body: r.body };
	}

	/** One JSON-RPC call; its `result`, or `unknown_tx` for the node's own
	 *  "Unknown Transaction" error. */
	private async rpc(
		url: string,
		method: string,
		params: readonly unknown[],
		signal: AbortSignal
	): Promise<Got> {
		const r = await this.request(
			url,
			{
				method: 'POST',
				accept: 'application/json',
				contentType: 'application/json',
				body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
			},
			signal
		);
		if (r.status !== 200 || typeof r.body !== 'object' || r.body === null) return { kind: 'bad' };
		const b = r.body as { result?: unknown; error?: unknown };
		if (b.error !== undefined) {
			return method === 'condenser_api.get_transaction' && saysUnknownTx(b.error)
				? { kind: 'unknown_tx' }
				: { kind: 'bad' };
		}
		return b.result === undefined || b.result === null
			? { kind: 'bad' }
			: { kind: 'ok', body: b.result };
	}

	/** One request with its answer read in full, all within
	 *  `requestTimeoutMs` (and stopped when the pool stops the call). Throws
	 *  for a node that cannot be asked — unreachable, too slow, a redirect, or
	 *  an HTTP status that is the node's own trouble — in words the pool's
	 *  isTransportError counts, so the node is cooled (429: backed off). A
	 *  body that is not JSON comes back as `undefined`. */
	private async request(
		url: string,
		init: Parameters<typeof explorerInit>[0],
		poolSignal: AbortSignal
	): Promise<{ status: number; body: unknown }> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
		const onAbort = (): void => ac.abort();
		if (poolSignal.aborted) ac.abort();
		else poolSignal.addEventListener('abort', onAbort, { once: true });
		try {
			let res: Response;
			try {
				res = await this.fetchImpl(url, explorerInit(init, ac.signal));
			} catch {
				throw new Error(TRANSPORT_FAILURE);
			}
			if (NODE_TROUBLE.has(res.status)) {
				void res.body?.cancel().catch(() => {});
				throw new Error(`HTTP ${res.status}`);
			}
			// A redirect is not followed (explorerInit): the node said nothing.
			if (res.status >= 300 && res.status < 400) {
				void res.body?.cancel().catch(() => {});
				throw new Error(TRANSPORT_FAILURE);
			}
			let body: unknown;
			try {
				// Raced against the timer too: a fetch whose body does not stop on
				// the abort must still not hold this request open.
				const reading = readExplorerJson(res, ac);
				reading.catch(() => {});
				body = await Promise.race([reading, abortedPromise(ac.signal)]);
			} catch {
				// Cut off by the timer (or the pool), or too big: no answer at all.
				if (ac.signal.aborted) throw new Error(TRANSPORT_FAILURE);
				body = undefined;
			}
			return { status: res.status, body };
		} finally {
			clearTimeout(timer);
			poolSignal.removeEventListener('abort', onAbort);
		}
	}
}

/** Rejects once `signal` aborts (never resolves). */
function abortedPromise(signal: AbortSignal): Promise<never> {
	return new Promise<never>((_, reject) => {
		if (signal.aborted) reject(new Error('aborted'));
		else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
	});
}

/** Does an error body say the transaction is unknown? Both chains' nodes
 *  write "Unknown Transaction <id>" (an FC_ASSERT in account_history_api). */
function saysUnknownTx(e: unknown): boolean {
	const m = typeof e === 'object' && e !== null ? (e as { message?: unknown }).message : undefined;
	return typeof m === 'string' && /\bUnknown Transaction\b/.test(m);
}

/** One node's raw fields, checked, as an answer. PURE. */
export function answerOf(
	chain: GrapheneChain,
	f: {
		readonly txid: string;
		readonly account: string;
		readonly memo?: string | null;
		readonly tx: unknown;
		readonly operations: unknown;
		readonly time: unknown;
		readonly head: unknown;
		readonly irreversible: unknown;
	}
): GrapheneNodeAnswer {
	const tx = f.tx as { transaction_id?: unknown; block_num?: unknown } | null;
	// Its own id: a node answering about another transaction says nothing.
	if (typeof tx?.transaction_id !== 'string' || tx.transaction_id.toLowerCase() !== f.txid) {
		return { kind: 'malformed' };
	}
	const block = tx.block_num;
	if (!isBlockNum(block) || !isBlockNum(f.head) || !isBlockNum(f.irreversible)) {
		return { kind: 'malformed' };
	}
	const paid = paidTo(chain, f.operations, f.account, f.memo ?? null);
	if (paid === null) return { kind: 'malformed' };
	return {
		kind: 'found',
		block,
		time: grapheneTimeOf(f.time),
		paid,
		// Read one after the other, the head can be a block behind the
		// transaction or the irreversible block: never below either.
		head: Math.max(f.head, block, f.irreversible),
		irreversible: f.irreversible
	};
}
