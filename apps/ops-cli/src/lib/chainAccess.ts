/**
 * How ops-cli reaches the Blurt chain.
 *
 * WHAT WAS WRONG. `lookupBlurtAccount` walked DEFAULT_BLURT_RPC_ENDPOINTS in a
 * fixed order (always hammering the same first node, paying a full timeout on
 * whichever was down), and `register` called dblurt's `sendOperations` once PER
 * ENDPOINT — which signs inside the call, so every failover produced a NEW
 * signature/transaction. Morphit's rule is: always use the best node from the
 * FULL pool, and sign once.
 *
 * NOW (every node, not only hidden-only):
 *   READS  — this node's own indexer first (it holds the full 20-node pool and
 *            its health); if it does not answer AND the node is not hidden-only,
 *            an EndpointPool over the configured clearnet list sharing the
 *            indexer/relay health file (fastest known first, dead last); if
 *            the nodes cannot be reached either and the indexer was there but
 *            slow, the indexer once more with a long wait (its read may go over
 *            Tor/I2P, the only way out of a censored network).
 *            Hidden-only: the indexer or nothing — never clearnet.
 *   WRITES — the transaction is built and SIGNED ONCE, locally. The signed
 *            object goes to the local indexer's POST /v1/broadcast; if the
 *            indexer is unreachable (or cannot reach the chain) and the node is
 *            not hidden-only, the SAME signed object goes to the pool via
 *            condenser_api.broadcast_transaction_synchronous. A "duplicate
 *            transaction" answer means it already landed: success.
 *
 * Every dependency is injectable so the routing is tested against a mock
 * indexer and mock nodes (test/chainAccess.test.ts).
 */
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import { EndpointPool, isHiddenEndpointUrl, isTransportError } from '@morphit/rpc-pool';
import { existsSync } from 'node:fs';
import {
	configuredClearnetRpcEndpoints,
	indexerEnvFiles,
	isHiddenOnlyNode,
	localCondenser,
	localIndexerJson,
	LocalIndexerAnswerError,
	LocalIndexerUnreachableError
} from './hiddenOnly.ts';

/** The Blurt chain id (mainnet). */
export const BLURT_CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';

/** Where the indexer/relay persist per-endpoint health (shared view). */
export function rpcHealthStatePath(): string {
	return process.env.MORPHIT_RPC_HEALTH_STATE ?? '/var/lib/morphit/rpc-health.json';
}

export interface ChainAccessDeps {
	/** Hidden-only node? (default: root-owned indexer.env says so) */
	readonly hiddenOnly?: () => boolean;
	/** Local indexer bases (default: from indexer.env + the standard ones). */
	readonly indexerBases?: readonly string[];
	/** Clearnet pool list (default: configured, else the shipped default). */
	readonly clearnetEndpoints?: readonly string[];
	/** Shared health file (default: rpcHealthStatePath()). */
	readonly healthStatePath?: string;
	/** How long to wait for the local indexer on a READ when a clearnet
	 *  fallback exists (a fresh wizard box has no indexer yet). */
	readonly localReadTimeoutMs?: number;
	/** How long the local indexer gets when it is asked again because the
	 *  clearnet nodes failed too (its chain read may go over Tor/I2P). */
	readonly localRetryTimeoutMs?: number;
	/** v1.21.18: how long a READ on a hidden-only node waits for the local
	 *  indexer, which relays it over Tor/I2P (default 20 s, enough for the
	 *  chain head or an account; a page of history needs longer). */
	readonly hiddenReadTimeoutMs?: number;
	/** Epoch ms after which nothing new is started: no retry runs past it, and
	 *  a broadcast is not signed or sent after it (a caller that has already
	 *  told the operator it gave up must not have the op land later). */
	readonly deadlineAt?: number;
}

/** The clearnet Blurt RPC nodes this process may dial (configured, else the
 *  shipped default; never a hidden one). A hidden-only node must not call it. */
export function clearnetEndpoints(deps: ChainAccessDeps = {}): string[] {
	return clearnetList(deps);
}

function clearnetList(deps: ChainAccessDeps): string[] {
	const list =
		deps.clearnetEndpoints ?? configuredClearnetRpcEndpoints() ?? DEFAULT_BLURT_RPC_ENDPOINTS;
	// Only clearnet URLs belong in a pool this process dials directly.
	return list.filter((u) => !isHiddenEndpointUrl(u));
}

function makePool(deps: ChainAccessDeps, endpoints?: readonly string[]): EndpointPool {
	const list = endpoints ? [...endpoints] : clearnetList(deps);
	if (list.length === 0) throw new Error('no clearnet Blurt RPC endpoint is configured');
	return new EndpointPool({
		endpoints: list,
		healthStatePath: deps.healthStatePath ?? rpcHealthStatePath()
	});
}

/** One JSON-RPC call to a node. HTTP failures are phrased `HTTP <status>` so
 *  the pool classifies 5xx/429 as transport (rotate) and 4xx as application. */
export async function jsonRpc(
	url: string,
	method: string,
	params: readonly unknown[],
	signal?: AbortSignal,
	timeoutMs = 30_000
): Promise<unknown> {
	// Own hard timeout (a hung node must never hang the CLI), still honouring
	// the pool's per-attempt signal: whichever fires first aborts the fetch.
	const ac = new AbortController();
	const timer = setTimeout(
		() => ac.abort(new Error(`timeout after ${timeoutMs} ms from ${url}`)),
		timeoutMs
	);
	const onOuter = (): void => ac.abort(signal?.reason);
	if (signal?.aborted) onOuter();
	else signal?.addEventListener('abort', onOuter);
	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
			signal: ac.signal
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
		const json = (await resp.json()) as { result?: unknown; error?: unknown };
		if (json.error !== undefined && json.error !== null) {
			throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
		}
		return json.result;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onOuter);
	}
}

/**
 * One read-only condenser reader per configured clearnet node, asked directly
 * (never through the pool's first-answer race): for reads where a single
 * node's answer can be incomplete and every node is worth asking — the
 * release record, whose signature makes WHO answered irrelevant. Empty on a
 * hidden-only node, which never dials clearnet.
 */
export function directNodeReaders(
	deps: ChainAccessDeps = {},
	timeoutMs = 10_000
): Array<(method: string, params: readonly unknown[]) => Promise<unknown>> {
	if ((deps.hiddenOnly ?? (() => isHiddenOnlyNode()))()) return [];
	return clearnetList(deps).map(
		(url) => (method: string, params: readonly unknown[]) =>
			jsonRpc(url, `condenser_api.${method}`, params, undefined, timeoutMs)
	);
}

/** A read-only condenser call: local indexer first, then (not hidden-only) the
 *  health-ordered clearnet pool, then — when the pool could not be reached and
 *  this box's indexer is there but was slow — the indexer once more with time
 *  to answer. Hidden-only never touches clearnet. */
export async function chainRead<T>(
	method: string,
	params: readonly unknown[],
	deps: ChainAccessDeps = {},
	explicitEndpoints?: readonly string[]
): Promise<T> {
	const hidden = (deps.hiddenOnly ?? (() => isHiddenOnlyNode()))();
	const askIndexer = explicitEndpoints === undefined || hidden;
	let indexerErr: unknown = null;
	if (askIndexer) {
		try {
			return await localCondenser<T>(method, params, {
				bases: deps.indexerBases,
				timeoutMs: hidden
					? (deps.hiddenReadTimeoutMs ?? 20_000)
					: (deps.localReadTimeoutMs ?? 4_000)
			});
		} catch (err) {
			if (hidden) throw err; // the indexer or nothing — never clearnet
			indexerErr = err;
		}
	}
	const pool = makePool(deps);
	let poolErr: unknown;
	try {
		// `read`: a node's generic RPC error on a read is that node's fault, so the
		// pool fails over past it; broadcasts below stay without it.
		return (await pool.call(
			(url, signal) => jsonRpc(url, `condenser_api.${method}`, params, signal),
			{
				hedge: true,
				read: true
			}
		)) as T;
	} catch (e) {
		poolErr = e;
	}
	// Third strategy: the indexer again, with time to answer — only when that
	// can help. The quick try gives it 4 s so a box with no indexer yet (the
	// install wizard) falls through to the nodes at once; but on a box that
	// cannot reach the clearnet nodes, the indexer — which reaches the chain
	// over Tor/I2P too — is the one path that works, and over Tor a read takes
	// longer than 4 s (morphitir, 2026-10-07: the v1.21.1 upgrade refused for
	// that reason). Not when the nodes ANSWERED (a real error every node would
	// repeat), not when no indexer is installed, not when the indexer answered
	// with a request error, and never past the caller's deadline.
	const poolUnreachable =
		isTransportError(poolErr) || /all RPC endpoints unavailable/i.test(errText(poolErr));
	const indexerInstalled =
		deps.indexerBases !== undefined || indexerEnvFiles().some((f) => existsSync(f));
	const indexerWasSlow =
		(indexerErr instanceof LocalIndexerUnreachableError && indexerErr.timedOut) ||
		(indexerErr instanceof LocalIndexerAnswerError && indexerErr.status >= 500);
	const left =
		deps.deadlineAt === undefined ? Number.POSITIVE_INFINITY : deps.deadlineAt - Date.now();
	const retryMs = Math.min(deps.localRetryTimeoutMs ?? 45_000, left);
	if (!askIndexer || !poolUnreachable || !indexerInstalled || !indexerWasSlow || retryMs < 1_000) {
		if (!askIndexer || indexerErr === null || !poolUnreachable) throw poolErr;
		throw new Error(
			`could not read the chain: this node's own indexer ${indexerProblem(indexerErr)}, ` +
				`and the Blurt RPC nodes could not be reached (${errText(poolErr)})`
		);
	}
	try {
		return await localCondenser<T>(method, params, {
			bases: deps.indexerBases,
			timeoutMs: retryMs
		});
	} catch (againErr) {
		throw new Error(
			`could not read the chain: this node's own indexer ${indexerProblem(indexerErr)}, ` +
				`then ${indexerProblem(againErr)} when asked again for ${Math.round(retryMs / 1000)} s; ` +
				`and the Blurt RPC nodes could not be reached (${errText(poolErr)})`
		);
	}
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** What the local indexer did, in words that fit "this node's own indexer …". */
function indexerProblem(e: unknown): string {
	if (e instanceof LocalIndexerUnreachableError) return `did not answer (${e.detail})`;
	if (e instanceof LocalIndexerAnswerError) return `answered with an error (${e.message})`;
	return `failed (${errText(e)})`;
}

/** "Duplicate transaction" from a node means the SAME signed tx already
 *  reached the chain — i.e. success. */
export function isDuplicateTxError(err: unknown): boolean {
	const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return (
		m.includes('duplicate transaction') ||
		m.includes('duplicate_transaction') ||
		m.includes('duplicate trx')
	);
}

/**
 * The broadcast got no final answer, after the signed transaction may already
 * have reached a Blurt node: this node's indexer took the request and did not
 * answer in time (or answered that it could not finish), or a node was being
 * sent it when the wait ran out. It may still land on the chain — until the
 * transaction expires (60 s after the chain head it was built on) and the
 * block that holds it becomes final.
 *
 * WHAT WAS WRONG (review, 2026-10-29): those cases came out as ordinary
 * errors — "could not reach this node's own indexer", "all Blurt RPC endpoints
 * rejected the broadcast" — which `register` classed as "could not complete
 * the broadcast": the operator was told it failed and nothing looked for it,
 * while it could land (on a hidden-only node every time the indexer's 120 s
 * ran out before register's own 200 s; on clearnet whenever the pool's abort
 * beat register's timer). Callers treat this like their own timeout: they look
 * for the result before saying anything about it.
 */
export class BroadcastOutcomeUnknownError extends Error {
	readonly trxId: string;
	readonly detail: string;
	constructor(trxId: string, detail: string) {
		super(
			`No final answer to the broadcast: the signed transaction ${trxId} may already have ` +
				`reached the Blurt network, so it can still land on the chain (${detail})`
		);
		this.name = 'BroadcastOutcomeUnknownError';
		this.trxId = trxId;
		this.detail = detail;
	}
}

/** Could this failed POST to the local indexer's /v1/broadcast have handed the
 *  transaction on? Yes when the indexer took the request (no answer in time, an
 *  answer cut off) or answered that it could not finish (5xx: it may have sent
 *  it to a node whose answer it then lost). No when no local address took the
 *  connection, or the indexer refused it (4xx: the chain's or its own reason). */
function indexerPostMayHaveReached(err: unknown): boolean {
	if (err instanceof LocalIndexerAnswerError) return err.status >= 500;
	if (err instanceof LocalIndexerUnreachableError)
		return err.timedOut || /answer was (cut off|too large)/.test(err.detail);
	return false;
}

/** Network errors that happen before a single byte of the request is sent. */
const NOT_CONNECTED_CODES = new Set([
	'ECONNREFUSED',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EADDRNOTAVAIL',
	'ERR_INVALID_URL',
	'CERT_HAS_EXPIRED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'ERR_TLS_CERT_ALTNAME_INVALID'
]);

/** Could this failed broadcast call to one node have reached it? No only when
 *  it certainly did not: the connection was never made, or the node turned
 *  the request away unread (4xx, 503). A timeout, an answer cut off, a 5xx or
 *  an RPC error after the node took it: it may have. */
function nodeCallMayHaveReached(err: unknown): boolean {
	if (/^HTTP (4\d\d|503)\b/.test(errText(err))) return false;
	const codeOf = (e: unknown): string =>
		e !== null && typeof e === 'object' ? String((e as { code?: unknown }).code ?? '') : '';
	const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
	return !NOT_CONNECTED_CODES.has(codeOf(err)) && !NOT_CONNECTED_CODES.has(codeOf(cause));
}

/** A node's answer that rejects the transaction ITSELF (the same signed bytes
 *  fail everywhere): no other node will take them, so the outcome is known. */
function isDefiniteTxRejection(err: unknown): boolean {
	return /missing (required )?(active |posting |owner )?authority|signature|insufficient|not enough|does not have sufficient|overdrawn/i.test(
		errText(err)
	);
}

interface DblurtCrypto {
	PrivateKey: { fromString(wif: string): unknown };
	cryptoUtils: {
		signTransaction(tx: unknown, keys: unknown, chainId?: Buffer): unknown;
		generateTrxId(tx: unknown): string;
	};
}

/**
 * Build + sign ONE transaction locally and broadcast it (see module doc).
 * Returns the trx id. Throws with the chain's own reason on a rejection;
 * `all Blurt RPC endpoints rejected the broadcast …` when nothing is reachable
 * and nothing was sent; and BroadcastOutcomeUnknownError when no final answer
 * came after the transaction may already have reached a node — the caller
 * must look for it before saying it failed.
 */
export async function signOnceAndBroadcast(
	args: { op: unknown; wif: string },
	deps: ChainAccessDeps = {},
	dblurtOverride?: DblurtCrypto
): Promise<{ trx_id: string; signed: unknown }> {
	const hidden = (deps.hiddenOnly ?? (() => isHiddenOnlyNode()))();
	const dblurt = dblurtOverride ?? ((await import('@beblurt/dblurt')) as unknown as DblurtCrypto);

	// Chain head for the reference block — through the same read routing.
	const props = await chainRead<{
		head_block_number?: unknown;
		head_block_id?: unknown;
		time?: unknown;
	} | null>('get_dynamic_global_properties', [], deps);
	if (
		props === null ||
		typeof props.head_block_number !== 'number' ||
		typeof props.head_block_id !== 'string' ||
		typeof props.time !== 'string'
	) {
		throw new Error('could not read the chain head to build the transaction');
	}
	if (deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt) {
		throw new Error('gave up before signing: the time allowed for this broadcast ran out');
	}
	const tx = {
		ref_block_num: props.head_block_number & 0xffff,
		ref_block_prefix: Buffer.from(props.head_block_id, 'hex').readUInt32LE(4),
		// 60 s after the head block, as dblurt and the web wallet do.
		expiration: new Date(new Date(props.time + 'Z').getTime() + 60_000).toISOString().slice(0, -5),
		operations: [args.op],
		extensions: [] as unknown[]
	};
	// SIGN ONCE. Every later attempt sends these exact bytes.
	const signed = dblurt.cryptoUtils.signTransaction(
		tx,
		[dblurt.PrivateKey.fromString(args.wif)],
		Buffer.from(BLURT_CHAIN_ID, 'hex')
	);
	const trxId = dblurt.cryptoUtils.generateTrxId(tx);
	/** What is left of the caller's deadline, never below 1 s (a send already
	 *  started gets a moment to be answered) and never above `capMs`. */
	const budget = (capMs: number): number =>
		Math.max(1_000, Math.min(capMs, (deps.deadlineAt ?? Infinity) - Date.now()));

	// 1. The local indexer's /v1/broadcast (it treats a duplicate as success).
	//    Its wait ends with the caller's deadline: a POST still open after the
	//    caller has told the operator it gave up could land the op later.
	let indexerErr: unknown = null;
	/** Set once the signed bytes may have reached a node (see
	 *  BroadcastOutcomeUnknownError): from then on, no failure is final. */
	let mayHaveSent = false;
	try {
		const res = await localIndexerJson<{ trx_id?: unknown; id?: unknown } | null>(
			'/v1/broadcast',
			{ method: 'POST', body: { trx: signed } },
			{ timeoutMs: budget(hidden ? 120_000 : 60_000), bases: deps.indexerBases }
		);
		const id =
			typeof res?.trx_id === 'string' ? res.trx_id : typeof res?.id === 'string' ? res.id : trxId;
		return { trx_id: id, signed };
	} catch (err) {
		indexerErr = err;
		// The indexer ANSWERED with a chain rejection (4xx): every node would say
		// the same — surface the chain's reason, do not resend.
		if (err instanceof LocalIndexerAnswerError && err.status < 500) throw err;
		mayHaveSent = indexerPostMayHaveReached(err);
		if (hidden) {
			if (mayHaveSent)
				throw new BroadcastOutcomeUnknownError(
					trxId,
					`this node's own indexer took it but gave no final answer over Tor/I2P: ${errText(err)}`
				);
			if (err instanceof LocalIndexerAnswerError) {
				throw new Error(
					`this node's own indexer could not reach the Blurt network over Tor/I2P (${err.message})`
				);
			}
			throw err; // never clearnet
		}
	}

	if (deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt) {
		if (mayHaveSent)
			throw new BroadcastOutcomeUnknownError(
				trxId,
				`the time allowed ran out after this node's own indexer took it without a final answer: ${errText(indexerErr)}`
			);
		throw new Error(
			`gave up: the time allowed for this broadcast ran out after this node's own indexer did not take it (${errText(indexerErr)})`
		);
	}
	// 2. Not hidden-only and the indexer could not carry it: the SAME signed
	//    object to the health-ordered clearnet pool.
	try {
		const pool = makePool(deps);
		const res = (await pool.call(
			async (url, signal) => {
				// Not sent to another node once the deadline has passed (a plain
				// error, not a transport one: the pool stops instead of rotating).
				if (deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt) {
					throw new Error(
						'gave up: the time allowed for this broadcast ran out before another Blurt RPC node could be tried'
					);
				}
				try {
					return await jsonRpc(
						url,
						'condenser_api.broadcast_transaction_synchronous',
						[signed],
						signal,
						budget(30_000)
					);
				} catch (err) {
					if (isDuplicateTxError(err)) return { id: trxId, duplicate: true };
					if (nodeCallMayHaveReached(err)) mayHaveSent = true;
					throw err;
				}
			},
			{ timeoutMs: budget(30_000) }
		)) as { id?: unknown } | null;
		const id = typeof res?.id === 'string' ? res.id : trxId;
		return { trx_id: id, signed };
	} catch (err) {
		// The bytes may be out there: only a rejection of the transaction itself
		// is final. Anything else (a timeout, the deadline, a node error) is not.
		if (mayHaveSent && !isDefiniteTxRejection(err)) {
			throw new BroadcastOutcomeUnknownError(trxId, errText(err));
		}
		if (isTransportError(err)) {
			throw new Error(
				`all Blurt RPC endpoints rejected the broadcast. Last error: ${err instanceof Error ? err.message : String(err)}` +
					(indexerErr
						? ` (local indexer: ${indexerErr instanceof Error ? indexerErr.message : String(indexerErr)})`
						: '')
			);
		}
		throw err; // an application-level chain rejection — the chain's own reason
	}
}
