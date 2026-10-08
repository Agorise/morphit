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
	/** Epoch ms after which nothing new is started: no retry runs past it, and
	 *  a broadcast is not signed or sent after it (a caller that has already
	 *  told the operator it gave up must not have the op land later). */
	readonly deadlineAt?: number;
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
				timeoutMs: hidden ? 20_000 : (deps.localReadTimeoutMs ?? 4_000)
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

interface DblurtCrypto {
	PrivateKey: { fromString(wif: string): unknown };
	cryptoUtils: {
		signTransaction(tx: unknown, keys: unknown, chainId?: Buffer): unknown;
		generateTrxId(tx: unknown): string;
	};
}

/**
 * Build + sign ONE transaction locally and broadcast it (see module doc).
 * Returns the trx id. Throws with the chain's own reason on a rejection, or
 * `all Blurt RPC endpoints rejected the broadcast …` when nothing is reachable,
 * so chainErrors' classifier still recognises every case.
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

	// 1. The local indexer's /v1/broadcast (it treats a duplicate as success).
	let indexerErr: unknown = null;
	try {
		const res = await localIndexerJson<{ trx_id?: unknown; id?: unknown } | null>(
			'/v1/broadcast',
			{ method: 'POST', body: { trx: signed } },
			{ timeoutMs: hidden ? 120_000 : 60_000, bases: deps.indexerBases }
		);
		const id =
			typeof res?.trx_id === 'string' ? res.trx_id : typeof res?.id === 'string' ? res.id : trxId;
		return { trx_id: id, signed };
	} catch (err) {
		indexerErr = err;
		// The indexer ANSWERED with a chain rejection (4xx): every node would say
		// the same — surface the chain's reason, do not resend.
		if (err instanceof LocalIndexerAnswerError && err.status < 500) throw err;
		if (hidden) {
			if (err instanceof LocalIndexerAnswerError) {
				throw new Error(
					`this node's own indexer could not reach the Blurt network over Tor/I2P (${err.message})`
				);
			}
			throw err; // never clearnet
		}
	}

	if (deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt) {
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
				try {
					return await jsonRpc(
						url,
						'condenser_api.broadcast_transaction_synchronous',
						[signed],
						signal
					);
				} catch (err) {
					if (isDuplicateTxError(err)) return { id: trxId, duplicate: true };
					throw err;
				}
			},
			{ timeoutMs: 30_000 }
		)) as { id?: unknown } | null;
		const id = typeof res?.id === 'string' ? res.id : trxId;
		return { trx_id: id, signed };
	} catch (err) {
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
