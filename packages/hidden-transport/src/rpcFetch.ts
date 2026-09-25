/**
 * @morphit/hidden-transport/rpc-fetch — how a Blurt RPC request is fetched.
 * (v1.18.0 deep-deep, M2)
 *
 * WHAT WAS WRONG. Chain RPC went out with fetch's defaults: redirects FOLLOWED,
 * bodies read whole. An RPC node is a third party — any operator can publish one
 * in the on-chain directory — so:
 *   - a node answering `307 Location: http://127.0.0.1:6379/` turned the
 *     indexer or relay into a blind SSRF against its own loopback (and, before
 *     C1 was fixed, on a hidden-only node a redirect to `10.<attacker>` was a
 *     deanonymisation path);
 *   - a node answering with an endless body was read into memory until the
 *     per-call timeout, per call, per endpoint.
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
 * The errors are worded for the RPC pool: its `isTransportError` rotates on the
 * word "network", and a node that redirects or floods is exactly a node to rotate
 * away from.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Largest RPC reply read. A batch of 20 full Blurt blocks is a few MB; 32 MiB
 *  is far above any honest reply and far below what hurts the process. */
export const RPC_REPLY_MAX_BYTES = 32 * 1024 * 1024;

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

function urlOf(input: unknown): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	return (input as { url?: string } | null)?.url ?? String(input);
}

/** Read a body up to `max` bytes; past that, cancel it and throw. */
export async function readCappedBytes(res: Response, max: number, url = ''): Promise<Uint8Array> {
	const reader = res.body?.getReader();
	if (reader === undefined) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw new RpcReplyTooLargeError(url, max);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

/**
 * A fetch for RPC: redirects are refused (the 3xx is never followed, its body
 * cancelled), and the reply is read here, capped, and handed back as a fresh
 * in-memory Response. `base` is looked up at call time when omitted.
 */
export function guardedRpcFetch(
	base?: typeof fetch,
	max: number = RPC_REPLY_MAX_BYTES
): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const url = urlOf(input);
		const res = await (base ?? globalThis.fetch)(input, { ...init, redirect: 'manual' });
		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel().catch(() => {});
			throw new RpcRedirectRefusedError(url, res.status);
		}
		const bytes = await readCappedBytes(res, max, url);
		const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
		return new Response(nullBody ? null : bytes, {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers
		});
	}) as typeof fetch;
}

const rpcScope = new AsyncLocalStorage<true>();
let installedWrapper: typeof fetch | null = null;

/** Wrap `globalThis.fetch` so requests made inside an RPC scope are guarded.
 *  Idempotent; re-wraps if something replaced the global since. */
export function installRpcFetchGuard(): void {
	if (installedWrapper !== null && globalThis.fetch === installedWrapper) return;
	const base = globalThis.fetch;
	const guarded = guardedRpcFetch(base);
	const wrapper = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
		rpcScope.getStore() === true ? guarded(input, init) : base(input, init)) as typeof fetch;
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
		return rpcScope.run(true, () => inner(...args));
	};
	return client;
}
