/**
 * @morphit/hidden-transport/rpc-fetch — how a Blurt RPC request is fetched.
 *
 *
 * WHAT WAS WRONG. Chain RPC went out with fetch's defaults: redirects FOLLOWED,
 * bodies read whole. An RPC node is a third party — any operator can publish one
 * in the on-chain directory — so:
 *   - a node answering `307 Location: http://127.0.0.1:6379/` turned the
 *     indexer or relay into a blind SSRF against its own loopback (and, before
 *     C1 was fixed, on a hidden-only node a redirect to `10.<attacker>` was a
 *     deanonymisation path);
 *   - a node answering with an endless body was read into memory until the
 *     per-call timeout, per call, per endpoint;
 *   - a reply small on the wire but huge once parsed (millions of `{}`) ran
 *     the process out of memory inside JSON.parse.
 *
 * WHY A SCOPED GLOBAL WRAPPER. dblurt's default (legacy) transport calls the
 * GLOBAL `fetch` with its own options and has no `fetch` option to pass (checked
 * in node_modules/@beblurt/dblurt 0.17.0: `utils.retryingFetch` →
 * `getGlobalFetch()`; `options.fetch` exists only in blurt-rpc-core, and dblurt
 * does not forward it). So `guardDblurtClient` runs each `client.call` inside an
 * AsyncLocalStorage scope, and a wrapper on `globalThis.fetch` applies the guard
 * only to requests made inside that scope. Every other fetch in the process is
 * passed through untouched.
 *
 * HOW LARGE A REPLY MAY BE depends on what was asked (rpcReplyBudget): a
 * dynamic-global-properties read is a few hundred bytes, a 10,000-entry account
 * history of a chat-active trader tens of MiB. One cap for both either refused
 * honest replies (8 MiB: the yearly P&L export failed) or let a node send any
 * request a reply that size. The request body is read (it is ours) and the cap
 * set from it.
 *
 * The errors are worded for the RPC pool:
 *   - a node that redirects, bombs (too many values, too deep), or answers a
 *     request whose size the chain bounds (a block) with more than that bound,
 *     is at fault: the error says "network policy", the pool's
 *     `isTransportError` rotates off it and cools it down;
 *   - a reply over the budget of a request whose honest size the chain does
 *     NOT bound (an account history, a get_accounts batch — a long-form blogger's
 *     history is honest and still too large) is the REQUEST's problem: every
 *     honest node would send the same. RpcReplyOverRequestBudgetError is worded
 *     so the pool treats it as an answer about the request (on a read, three
 *     operators must agree before it is returned; nobody is cooled down unless
 *     another node then answers within the budget).
 * Either way, guardDblurtClient stops dblurt from re-requesting the same reply
 * from the same node until its timeout (it retries every fetch error).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Largest reply to a request that has no budget of its own (head reads,
 *  chain properties, a single account or block, broadcasts): far above any
 *  honest answer to those. */
export const RPC_REPLY_MAX_BYTES = 8 * 1024 * 1024;

/** Room for the JSON-RPC envelope on top of a per-item budget. */
const RPC_REPLY_BASE_BYTES = 1024 * 1024;

/** Per account-history entry. The largest Morphit entry is a v2 chat message
 *  at the 1,536-character ciphertext cap with its self copy, about 3.6 KiB as
 *  history JSON; a 10,000-entry history of nothing else is 35.4 MiB. */
export const RPC_HISTORY_ENTRY_BUDGET_BYTES = 4 * 1024;

/** Per account in get_accounts: authorities plus both JSON metadata fields,
 *  each bounded by the 64 KiB transaction size (JSON escaping can double it). */
export const RPC_ACCOUNT_BUDGET_BYTES = 256 * 1024;

/** Per block: a full 64 KiB block is 250–400 KiB as JSON (hex signatures,
 *  quoted keys, escaped strings); 1 MiB leaves room for a larger block size
 *  vote. The chain bounds this, so a block reply over it is a node fault. */
export const RPC_BLOCK_BUDGET_BYTES = 1024 * 1024;

/** The chain refuses get_account_history above this limit. */
const HISTORY_LIMIT_MAX = 10_000;

/** No request may be answered with more than this: 10,000 history entries at
 *  the per-entry budget, plus the envelope. Proven against the worst parse
 *  bomb under the relay's 512M MemoryMax by apps/relay:rpc-reply-bomb-smoke. */
export const RPC_REPLY_CEILING_BYTES =
	HISTORY_LIMIT_MAX * RPC_HISTORY_ENTRY_BUDGET_BYTES + RPC_REPLY_BASE_BYTES;

export interface RpcReplyBudget {
	/** Bytes the reply may have. */
	readonly maxBytes: number;
	/** True when the request's honest reply size is not bounded by the chain
	 *  (account history, get_accounts): going over the budget then says the
	 *  request asked for too much, not that the node misbehaved. */
	readonly requestSized: boolean;
}

/** The method name and params of one JSON-RPC request, in either form dblurt
 *  and the indexer send: `{method:"call", params:[api, method, params]}` or
 *  `{method:"api.method", params}`. */
function methodOf(req: unknown): { method: string; params: unknown } | null {
	if (req === null || typeof req !== 'object') return null;
	const r = req as { method?: unknown; params?: unknown };
	if (typeof r.method !== 'string') return null;
	if (r.method === 'call' && Array.isArray(r.params) && typeof r.params[1] === 'string') {
		return { method: r.params[1], params: r.params[2] };
	}
	return { method: r.method.slice(r.method.lastIndexOf('.') + 1), params: r.params };
}

function itemBudget(req: unknown): { bytes: number; requestSized: boolean } {
	const m = methodOf(req);
	if (m === null) return { bytes: 0, requestSized: false };
	if (m.method === 'get_account_history') {
		const p = m.params;
		const raw = Array.isArray(p) ? p[2] : (p as { limit?: unknown } | null)?.limit;
		const limit = typeof raw === 'number' && Number.isFinite(raw) ? raw : HISTORY_LIMIT_MAX;
		const entries = Math.min(HISTORY_LIMIT_MAX, Math.max(1, Math.floor(limit)));
		return { bytes: entries * RPC_HISTORY_ENTRY_BUDGET_BYTES, requestSized: true };
	}
	if (m.method === 'get_accounts' || m.method === 'find_accounts') {
		const p = m.params;
		const names =
			Array.isArray(p) && Array.isArray(p[0])
				? p[0]
				: (p as { accounts?: unknown } | null)?.accounts;
		const count = Array.isArray(names) ? names.length : 1;
		return { bytes: Math.max(1, count) * RPC_ACCOUNT_BUDGET_BYTES, requestSized: true };
	}
	if (m.method === 'get_block') return { bytes: RPC_BLOCK_BUDGET_BYTES, requestSized: false };
	return { bytes: 0, requestSized: false };
}

/** How large the reply to this JSON-RPC request body (a string, as sent, or
 *  already parsed; a single request or a batch) may be. PURE. */
export function rpcReplyBudget(body: unknown): RpcReplyBudget {
	let parsed: unknown = body;
	if (typeof body === 'string') {
		try {
			parsed = JSON.parse(body);
		} catch {
			return { maxBytes: RPC_REPLY_MAX_BYTES, requestSized: false };
		}
	}
	const items = Array.isArray(parsed) ? parsed : [parsed];
	let bytes = 0;
	let requestSized = false;
	for (const item of items) {
		const b = itemBudget(item);
		bytes += b.bytes;
		requestSized ||= b.requestSized;
	}
	const maxBytes = Math.min(
		RPC_REPLY_CEILING_BYTES,
		Math.max(RPC_REPLY_MAX_BYTES, bytes + RPC_REPLY_BASE_BYTES)
	);
	return { maxBytes, requestSized };
}

/** Most JSON values (objects, arrays, and every comma-separated element) a
 *  reply may hold. Bytes alone do not bound memory: `{}` is 2 bytes on the wire
 *  and tens of bytes once parsed, so a reply under the byte cap can still exhaust
 *  the heap. Honest replies hold far fewer: a 20-block batch of ~650 transfers
 *  each 200-300 thousand, a 10,000-entry chat history about 250 thousand. */
export const RPC_REPLY_MAX_VALUES = 1_000_000;

/** Deepest nesting a reply may have. Chain objects nest about ten deep. */
export const RPC_REPLY_MAX_DEPTH = 64;

/** A node answered with a redirect. Not followed. */
export class RpcRedirectRefusedError extends Error {
	constructor(url: string, status: number) {
		super(`RPC node ${url} answered HTTP ${status} (a redirect); not followed (network policy)`);
		this.name = 'RpcRedirectRefusedError';
	}
}

/** A node's reply was larger than the cap. Read no further. */
export class RpcReplyTooLargeError extends Error {
	constructor(url: string, max: number) {
		super(`RPC node ${url} sent a reply over ${max} bytes; aborted (network policy)`);
		this.name = 'RpcReplyTooLargeError';
	}
}

/** The reply was larger than the request's budget, for a request whose
 *  honest reply size the chain does not bound (see rpcReplyBudget). Every honest
 *  node would send the same, so this is NOT worded as a node fault: no
 *  "network", no "timeout", nothing the pool's transport/fault classifiers
 *  match. Ask for fewer entries. */
export class RpcReplyOverRequestBudgetError extends Error {
	constructor(url: string, max: number) {
		super(
			`RPC reply from ${url} is over the ${max} bytes this request may return; ` +
				`refused (ask for fewer entries)`
		);
		this.name = 'RpcReplyOverRequestBudgetError';
	}
}

/** A node's reply would cost far more memory to parse than its size says. */
export class RpcReplyTooComplexError extends Error {
	constructor(url: string, what: string) {
		super(`RPC node ${url} sent a reply with ${what}; refused before parsing (network policy)`);
		this.name = 'RpcReplyTooComplexError';
	}
}

/**
 * Refuse a JSON reply whose PARSED form would be out of proportion to an honest
 * chain answer — too many values or too deep — before JSON.parse ever sees it.
 * One pass over the bytes, tracking only whether we are inside a string.
 * Multi-byte UTF-8 never contains the ASCII bytes counted here.
 */
export function checkRpcReplyShape(
	bytes: Uint8Array,
	limits: { maxValues?: number; maxDepth?: number } = {},
	url = ''
): void {
	const maxValues = limits.maxValues ?? RPC_REPLY_MAX_VALUES;
	const maxDepth = limits.maxDepth ?? RPC_REPLY_MAX_DEPTH;
	let values = 0;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (b === 0x5c) escaped = true;
			else if (b === 0x22) inString = false;
			continue;
		}
		if (b === 0x22) {
			inString = true;
		} else if (b === 0x7b || b === 0x5b) {
			// { or [
			if (++depth > maxDepth)
				throw new RpcReplyTooComplexError(url, `nesting deeper than ${maxDepth}`);
			if (++values > maxValues)
				throw new RpcReplyTooComplexError(url, `more than ${maxValues} values`);
		} else if (b === 0x7d || b === 0x5d) {
			depth--;
		} else if (b === 0x2c) {
			if (++values > maxValues)
				throw new RpcReplyTooComplexError(url, `more than ${maxValues} values`);
		}
	}
}

function urlOf(input: unknown): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	return (input as { url?: string } | null)?.url ?? String(input);
}

/** Read a body up to `max` bytes; past that, cancel it and throw. */
export async function readCappedBytes(
	res: Response,
	max: number,
	url = '',
	overCap: (url: string, max: number) => Error = (u, m) => new RpcReplyTooLargeError(u, m)
): Promise<Uint8Array<ArrayBuffer>> {
	// Returns a FRESH ArrayBuffer-backed array (never a view of a shared
	// buffer), which is what `new Response(body)` requires under the DOM lib's
	// BodyInit — the looser Uint8Array<ArrayBufferLike> did not typecheck there.
	const reader = res.body?.getReader();
	if (reader === undefined) return new Uint8Array(new ArrayBuffer(0));
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw overCap(url, max);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(new ArrayBuffer(total));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

/**
 * A fetch for RPC: redirects are refused (the 3xx is never followed, its body
 * cancelled), and the reply is read here, capped in bytes, checked for a parsed
 * shape an honest node never sends (checkRpcReplyShape), and handed back as a
 * fresh in-memory Response. `base` is looked up at call time when omitted. The
 * byte cap is `max` when given, else the request's budget (rpcReplyBudget).
 */
export function guardedRpcFetch(base?: typeof fetch, max?: number): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const url = urlOf(input);
		const budget: RpcReplyBudget =
			max !== undefined ? { maxBytes: max, requestSized: false } : rpcReplyBudget(init?.body);
		const res = await (base ?? globalThis.fetch)(input, { ...init, redirect: 'manual' });
		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel().catch(() => {});
			throw new RpcRedirectRefusedError(url, res.status);
		}
		const bytes = await readCappedBytes(res, budget.maxBytes, url, (u, m) =>
			budget.requestSized
				? new RpcReplyOverRequestBudgetError(u, m)
				: new RpcReplyTooLargeError(u, m)
		);
		checkRpcReplyShape(bytes, {}, url);
		return bufferedRpcResponse(bytes, {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers
		});
	}) as typeof fetch;
}

/**
 * The Response handed back: the bytes already read, decoded once when the
 * caller reads the body. `new Response(bytes)` would copy the bytes into a
 * stream and `.json()` would collect them into a further copy; at the history
 * budget that is two extra 40 MiB buffers per call, which is what the
 * MemoryMax proof (rpc-reply-bomb-smoke) cannot afford.
 */
function bufferedRpcResponse(bytes: Uint8Array<ArrayBuffer>, init: ResponseInit): Response {
	const res = new Response(null, init);
	const nullBody = init.status === 204 || init.status === 205 || init.status === 304;
	let held: Uint8Array<ArrayBuffer> | null = nullBody ? new Uint8Array(new ArrayBuffer(0)) : bytes;
	const take = (): Uint8Array<ArrayBuffer> => {
		const b = held;
		if (b === null) throw new TypeError('Body is unusable: Body has already been read');
		held = null;
		return b;
	};
	const text = async (): Promise<string> => new TextDecoder().decode(take());
	Object.defineProperties(res, {
		bodyUsed: { get: () => held === null },
		text: { value: text },
		json: { value: async (): Promise<unknown> => JSON.parse(await text()) as unknown },
		arrayBuffer: { value: async (): Promise<ArrayBuffer> => take().buffer }
	});
	return res;
}

/** Errors the guard itself raises (as opposed to the network's). */
function isGuardRefusal(err: unknown): err is Error {
	return (
		err instanceof RpcRedirectRefusedError ||
		err instanceof RpcReplyTooLargeError ||
		err instanceof RpcReplyOverRequestBudgetError ||
		err instanceof RpcReplyTooComplexError
	);
}

/** One guarded dblurt call. After the guard refuses a reply, every further
 *  fetch in the call fails with the same refusal without touching the network,
 *  and the call itself rejects at once (dblurt would otherwise re-request the
 *  same reply from the same node until its timeout). */
interface RpcScope {
	refused: Error | null;
	onRefused: ((err: Error) => void) | null;
}

const rpcScope = new AsyncLocalStorage<RpcScope>();
let installedWrapper: typeof fetch | null = null;

/** Wrap `globalThis.fetch` so requests made inside an RPC scope are guarded.
 *  Idempotent; re-wraps if something replaced the global since. */
export function installRpcFetchGuard(): void {
	if (installedWrapper !== null && globalThis.fetch === installedWrapper) return;
	const base = globalThis.fetch;
	const guarded = guardedRpcFetch(base);
	const wrapper = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const scope = rpcScope.getStore();
		if (scope === undefined) return base(input, init);
		if (scope.refused !== null) throw scope.refused;
		try {
			return await guarded(input, init);
		} catch (err) {
			if (isGuardRefusal(err)) {
				scope.refused = err;
				scope.onRefused?.(err);
			}
			throw err;
		}
	}) as typeof fetch;
	installedWrapper = wrapper;
	globalThis.fetch = wrapper;
}

/**
 * Make every RPC call through this dblurt `Client` use the guarded fetch.
 * `call` is dblurt's one public entry point — every helper (`condenser`,
 * `database`, `broadcast`, …) goes through it.
 */
export function guardDblurtClient<C extends { call: (...args: never[]) => Promise<unknown> }>(
	client: C
): C {
	installRpcFetchGuard();
	const inner = client.call.bind(client) as (...args: unknown[]) => Promise<unknown>;
	(client as { call: unknown }).call = (...args: unknown[]): Promise<unknown> => {
		installRpcFetchGuard();
		const scope: RpcScope = { refused: null, onRefused: null };
		return new Promise((resolve, reject) => {
			scope.onRefused = reject;
			// dblurt keeps retrying in the background until its timeout; each retry
			// now fails at once inside the scope, and its final rejection lands on
			// an already-settled promise.
			rpcScope.run(scope, () => inner(...args)).then(resolve, reject);
		});
	};
	return client;
}
