/**
 * Morphit indexer — how a fee explorer or a price source is reached.
 *
 * One `fetch` for every BTC/XMR explorer and every pricenode, so the rules are
 * decided in one place:
 *   - an `.onion` source goes through THIS node's Tor SOCKS port on a FRESH
 *     circuit per request (random SOCKS credentials — Tor's IsolateSOCKSAuth),
 *     never on a pooled connection: two lookups — two payers' fees — cannot be
 *     tied together by the circuit they share, and the source never learns the
 *     node's address. The SOCKS exchange may take SOURCE_TOR_HANDSHAKE_TIMEOUT_MS
 *     (an onion rendezvous measured up to ~40 s);
 *   - an I2P source goes through the process router (i2pd);
 *   - a clearnet source is only fetched where clearnet is allowed. On a
 *     zero-clearnet node it is refused BEFORE any name lookup
 *     (ClearnetRefusedError): no DNS question, no connection;
 *   - the User-Agent is a fixed role name, `morphit-indexer/<role>`, as for
 *     every third-party source (fee/explorerHttp.ts, price/priceFetchUtil.ts):
 *     no runtime default (`node`), no version, no contact URL — those are for
 *     Blurt RPC operators only (blurt/userAgent.ts). A caller's UA that is
 *     not such a name, or none, is replaced with SOURCE_USER_AGENT;
 *   - redirects are never followed (`redirect: 'manual'`, a 3xx is returned
 *     as a failed answer), and an onion answer is read under a byte cap here
 *     before it is handed on — the callers cap and shape-check it again.
 * Every request has its own ceiling (requestTimeoutMs, default
 * SOURCE_HIDDEN_REQUEST_TIMEOUT_MS), joined with any AbortSignal the caller
 * passes in `init`; the fee re-check and the price refresh run in background
 * loops, so a slow onion holds up no user request.
 */
import { Agent } from 'undici';
import {
	hiddenNetworkOf,
	parseHostPort,
	ProxyUnavailableError,
	asLocalTransportFault,
	type HiddenServiceProxyConfig
} from '@morphit/hidden-transport';
import {
	clearnetRefused,
	isClearnetOrigin,
	ClearnetRefusedError
} from '@morphit/hidden-transport/router';
import { freshTorIsolation, makeIsolatedTorConnector } from './hiddenServicePool';

/** How long the SOCKS exchange with Tor may take, onion rendezvous included. */
export const SOURCE_TOR_HANDSHAKE_TIMEOUT_MS = 45_000;
/** Per-request timeout for a source reached over Tor or I2P (measured 2–40 s). */
export const SOURCE_HIDDEN_REQUEST_TIMEOUT_MS = 60_000;
/** Largest answer read from an onion source (an address's tx page is the
 *  largest legitimate one, a few hundred KB). */
export const SOURCE_MAX_BODY_BYTES = 2 * 1024 * 1024;
/** The User-Agent a source sees when the caller names no role of its own. */
export const SOURCE_USER_AGENT = 'morphit-indexer/source-fetch';
/** The only User-Agent shape a third-party source may receive. */
const SOURCE_USER_AGENT_SHAPE = /^morphit-indexer\/[a-z][a-z-]*$/;

/** The caller's headers with the User-Agent held to the policy. */
function sourceHeaders(init: RequestInit | undefined): Headers {
	const headers = new Headers(init?.headers);
	const ua = headers.get('user-agent');
	if (ua === null || !SOURCE_USER_AGENT_SHAPE.test(ua))
		headers.set('user-agent', SOURCE_USER_AGENT);
	return headers;
}

export class SourceBodyTooLarge extends Error {
	constructor() {
		super('source answer exceeds the size cap');
		this.name = 'SourceBodyTooLarge';
	}
}

export interface SourceFetchOptions {
	readonly proxies: HiddenServiceProxyConfig;
	/** Whether a clearnet source may be fetched right now. Asked on every call. */
	readonly clearnetAllowed: () => boolean;
	readonly maxBodyBytes?: number;
	readonly torHandshakeTimeoutMs?: number;
	/** Ceiling for one request, whatever the caller's own signal says
	 *  (default SOURCE_HIDDEN_REQUEST_TIMEOUT_MS). Over Tor it covers the whole
	 *  answer; over clearnet it covers the request up to the response
	 *  headers, and the caller's own signal then bounds reading the body. */
	readonly requestTimeoutMs?: number;
	/** The fetch used for I2P and (where allowed) clearnet sources; the
	 *  global one (the process router) by default. */
	readonly baseFetch?: typeof fetch;
}

/** True when `url` names a public clearnet host (not a hidden service, not
 *  this box). PURE. */
export function isClearnetSource(url: string): boolean {
	try {
		return isClearnetOrigin(new URL(url).origin);
	} catch {
		return true;
	}
}

/** Statuses whose Response must carry no body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
	const cl = res.headers.get('content-length');
	if (cl !== null && Number.isFinite(Number(cl)) && Number(cl) > max) {
		await res.body?.cancel().catch(() => undefined);
		throw new SourceBodyTooLarge();
	}
	const reader = res.body?.getReader();
	if (!reader) return new Uint8Array(0);
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
		total += r.value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => undefined);
			throw new SourceBodyTooLarge();
		}
		parts.push(r.value);
	}
	return Buffer.concat(parts);
}

/** One request over a fresh, isolated Tor circuit; the answer is read in full
 *  (capped) before the circuit is torn down, then handed back as a Response.
 *  `ceiling` is makeSourceFetch's AbortController signal: the request timeout
 *  joined with the caller's own signal. It bounds the whole answer. */
async function torIsolatedFetch(
	url: string,
	init: RequestInit | undefined,
	ceiling: AbortSignal,
	opts: SourceFetchOptions
): Promise<Response> {
	const proxies = opts.proxies;
	if (proxies.torSocks.length === 0) {
		throw new ProxyUnavailableError('Tor SOCKS proxy not configured');
	}
	const { host, port } = parseHostPort(proxies.torSocks, 9050);
	const dispatcher = new Agent({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici's
		// connect type doesn't model a custom SOCKS connector cleanly.
		connect: makeIsolatedTorConnector(
			host,
			port,
			freshTorIsolation(),
			opts.torHandshakeTimeoutMs ?? SOURCE_TOR_HANDSHAKE_TIMEOUT_MS
		) as any,
		connections: 1,
		pipelining: 0
	});
	try {
		const res = await fetch(url, {
			...init,
			signal: ceiling,
			redirect: 'manual',
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fetch's
			// lib.dom type omits undici's `dispatcher`.
			dispatcher
		} as any);
		const body = await readCapped(res, opts.maxBodyBytes ?? SOURCE_MAX_BODY_BYTES);
		const headers = new Headers(res.headers);
		// The body is already decoded and complete.
		headers.delete('content-encoding');
		headers.delete('content-length');
		headers.delete('transfer-encoding');
		return new Response(NULL_BODY.has(res.status) ? null : body, {
			status: res.status,
			statusText: res.statusText,
			headers
		});
	} catch (err) {
		throw asLocalTransportFault(err, 'tor', proxies);
	} finally {
		// Never reused: the next request gets a new circuit.
		await dispatcher.destroy().catch(() => undefined);
	}
}

/** The `fetch` every fee explorer and price source is reached with. */
export function makeSourceFetch(opts: SourceFetchOptions): typeof fetch {
	const base: typeof fetch = opts.baseFetch ?? globalThis.fetch;
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;
		const network = hiddenNetworkOf(url);
		if (network !== 'tor' && isClearnetSource(url) && !opts.clearnetAllowed()) {
			let origin = url;
			try {
				origin = new URL(url).origin;
			} catch {
				/* keep the raw string */
			}
			throw new ClearnetRefusedError(origin);
		}
		// Our own ceiling, joined with the caller's signal: a caller that
		// passes none (or a slow one) still cannot hang on a silent source.
		const ac = new AbortController();
		const timer = setTimeout(
			() => ac.abort(),
			opts.requestTimeoutMs ?? SOURCE_HIDDEN_REQUEST_TIMEOUT_MS
		);
		const callerSignal = init?.signal ?? null;
		const onCallerAbort = (): void => ac.abort();
		if (callerSignal !== null) {
			if (callerSignal.aborted) ac.abort();
			else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
		}
		try {
			const sent: RequestInit = { ...init, headers: sourceHeaders(init) };
			if (network === 'tor') return await torIsolatedFetch(url, sent, ac.signal, opts);
			return await base(url, { ...sent, signal: ac.signal, redirect: 'manual' });
		} finally {
			clearTimeout(timer);
			callerSignal?.removeEventListener('abort', onCallerAbort);
		}
	}) as typeof fetch;
}

/** Is clearnet allowed for sources on this node? Not on a hidden-only node
 *  (no clearnet RPC), and not while the process router refuses clearnet. */
export function sourceClearnetAllowed(config: {
	readonly blurtRpcEndpoints: readonly unknown[];
}): () => boolean {
	return () => config.blurtRpcEndpoints.length > 0 && !clearnetRefused();
}
