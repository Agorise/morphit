/**
 * Morphit — endpoint-rotation client.
 *
 * Health-aware round-robin across multiple Blurt RPC endpoints. Every
 * `call()` picks the currently-best endpoint, posts the request, and
 * transparently fails over on timeout / network error / non-200. A small
 * stats object tracks consecutive failures per endpoint; a failing one
 * gets deprioritized until it recovers.
 *
 * Why a custom client instead of just handing `dblurt` a single URL:
 *   - dblurt (and its dsteem ancestor) does not natively multi-endpoint.
 *   - Morphit specifically promises resilience when any single endpoint
 *     gets blocked or goes down. That promise needs code, not config.
 *   - This layer is transport-only — it doesn't know about Blurt ops.
 *     dblurt sits ON TOP OF this, passing its JSON-RPC calls through.
 *
 * In the browser its only user is the release check ($net/releaseFetch), the
 * one place the app reads the chain without the operator's indexer. That check
 * reads from the best node (`nodesInOrder` / `callAt`) and asks one other
 * operator's node only when it must ($net/releaseVerifyCore).
 */

import {
	DEFAULT_RPC_ENDPOINTS,
	DEFAULT_HIDDEN_RPC_ENDPOINTS,
	DEFAULT_I2P_RPC_ENDPOINTS,
	HIDDEN_RPC_OPERATORS,
	RPC_TIMEOUT_MS,
	RPC_MAX_CONSECUTIVE_FAILURES,
	RPC_MAX_RETRIES_PER_CALL
} from './config';
import { withHiddenFloor } from './transportBudget';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface EndpointStat {
	url: string;
	/** Number of consecutive failures since last success. */
	consecutiveFailures: number;
	/** Last measured round-trip in milliseconds (null = never called). */
	lastLatencyMs: number | null;
	/** Unix ms of the last successful call. */
	lastOkAt: number | null;
	/** Unix ms when this endpoint becomes eligible to retry after
	 *  consecutive failures tripped RPC_MAX_CONSECUTIVE_FAILURES. */
	cooldownUntil: number;
	/** HTTP status from the most recent transport failure (e.g. 429,
	 *  503), or null when the failure wasn't an HTTP response (timeout /
	 *  network / CORS) or when the last call succeeded. Surfaced in the
	 *  endpoint-settings panel as "Error: 429" so the operator can see
	 *  WHY a node is failing, not just that it is. */
	lastErrorCode: number | null;
	/** Category of the most recent transport failure, so the endpoint-settings
	 *  panel can say WHY a node failed, not just that it did:
	 *    'http'    — the node answered with a non-2xx (see lastErrorCode);
	 *    'timeout' — the request hit the per-call deadline (AbortError);
	 *    'network' — fetch threw before any response: DNS, offline, TLS, or a
	 *                CORS rejection. The browser deliberately collapses these
	 *                into one opaque TypeError, so we cannot tell them apart and
	 *                must not claim a specific one.
	 *  null when the last call succeeded or none has happened. */
	lastErrorKind: 'http' | 'timeout' | 'network' | null;
}

/** Classify a transport Error for display. fetchWithTimeout throws
 *  `HTTP <status> from <url>` for non-2xx, an AbortError on the deadline, and
 *  lets the browser's TypeError ("Failed to fetch") through for everything
 *  before a response (network/DNS/TLS/CORS — indistinguishable by design). */
export function classifyEndpointError(err: Error): {
	kind: 'http' | 'timeout' | 'network';
	code: number | null;
} {
	const httpMatch = /^HTTP (\d{3})\b/.exec(err.message);
	if (httpMatch) return { kind: 'http', code: Number(httpMatch[1]) };
	if (err.name === 'AbortError' || /\b(timed out|timeout|aborted)\b/i.test(err.message)) {
		return { kind: 'timeout', code: null };
	}
	return { kind: 'network', code: null };
}

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: number | string;
	method: string;
	params?: unknown;
}
export interface JsonRpcSuccess<T = unknown> {
	jsonrpc: '2.0';
	id: number | string;
	result: T;
}
export interface JsonRpcError {
	jsonrpc: '2.0';
	id: number | string;
	error: { code: number; message: string; data?: unknown };
}
export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

// ────────────────────────────────────────────────────────────────────────────
// Endpoint list
// ────────────────────────────────────────────────────────────────────────────
//
// The pool is fixed per page origin (`selectRpcPool` below); there is no
// user-supplied list. A list an older build stored under ENDPOINTS_STORAGE_KEY
// is ignored.

/** Who runs an endpoint, for counting independent answers: a hidden node's
 *  name (its `.onion` and `.b32.i2p` are one operator), otherwise the URL's
 *  hostname (two ports on one host are one operator). */
export function rpcOperatorOf(url: string): string {
	const named = HIDDEN_RPC_OPERATORS[url];
	if (named !== undefined) return `name:${named}`;
	try {
		return `host:${new URL(url).hostname.toLowerCase()}`;
	} catch {
		return `url:${url}`;
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Rotator
// ────────────────────────────────────────────────────────────────────────────

/** True if a URL's host is a hidden-service address (.onion / .i2p / .b32.i2p).
 *  Used by the privacy-first rotator to try these before any clearnet node. */
export function isHiddenEndpoint(url: string): boolean {
	try {
		const h = new URL(url).hostname.toLowerCase();
		return h.endsWith('.onion') || h.endsWith('.i2p');
	} catch {
		return false;
	}
}

export class EndpointRotator {
	private readonly stats: Map<string, EndpointStat>;
	private order: string[];
	/** Incrementing JSON-RPC id counter, per rotator instance. */
	private nextRpcId = 1;
	/** When true, hidden-service endpoints (.onion / .b32.i2p) are always tried
	 *  BEFORE any clearnet endpoint, regardless of latency — so a visitor on Tor
	 *  Browser / with an I2P proxy reaches the chain without their IP ever
	 *  touching the clear net. Latency still orders WITHIN each tier. */
	private readonly privacyFirst: boolean;

	constructor(endpoints: readonly string[], opts: { privacyFirst?: boolean } = {}) {
		if (endpoints.length === 0) {
			throw new Error('EndpointRotator requires at least one endpoint URL');
		}
		this.privacyFirst = opts.privacyFirst ?? false;
		this.stats = new Map();
		// Randomize the initial order so the default pool doesn't
		// centralize load on whichever URL appears first.
		this.order = shuffle([...endpoints]);
		for (const url of this.order) {
			this.stats.set(url, {
				url,
				consecutiveFailures: 0,
				lastLatencyMs: null,
				lastOkAt: null,
				cooldownUntil: 0,
				lastErrorCode: null,
				lastErrorKind: null
			});
		}
	}

	/** All endpoints, including ones in cooldown, in current priority order. */
	getAll(): readonly EndpointStat[] {
		return this.order.map((u) => this.stats.get(u)!);
	}

	/** Endpoints eligible to try right now, best-first. */
	private eligible(): EndpointStat[] {
		const now = Date.now();
		const healthy: EndpointStat[] = [];
		const cooling: EndpointStat[] = [];
		for (const url of this.order) {
			const s = this.stats.get(url)!;
			if (s.cooldownUntil > now) {
				cooling.push(s);
			} else {
				healthy.push(s);
			}
		}
		// Sort healthy endpoints by:
		//   0. (privacyFirst only) hidden-service endpoints before clearnet —
		//      privacy beats latency for the one-time direct-to-chain check.
		//   1. Fewer consecutive failures first
		//   2. Then by last latency (unknown = treat as infinity, so known-fast wins)
		healthy.sort((a, b) => {
			if (this.privacyFirst) {
				const at = isHiddenEndpoint(a.url) ? 0 : 1;
				const bt = isHiddenEndpoint(b.url) ? 0 : 1;
				if (at !== bt) return at - bt;
			}
			if (a.consecutiveFailures !== b.consecutiveFailures) {
				return a.consecutiveFailures - b.consecutiveFailures;
			}
			const aLat = a.lastLatencyMs ?? Number.POSITIVE_INFINITY;
			const bLat = b.lastLatencyMs ?? Number.POSITIVE_INFINITY;
			return aLat - bLat;
		});
		// If nothing is healthy, try the coolest (expired-soonest) cooldowns —
		// still hidden-first under privacyFirst.
		if (healthy.length === 0) {
			cooling.sort((a, b) => {
				if (this.privacyFirst) {
					const at = isHiddenEndpoint(a.url) ? 0 : 1;
					const bt = isHiddenEndpoint(b.url) ? 0 : 1;
					if (at !== bt) return at - bt;
				}
				return a.cooldownUntil - b.cooldownUntil;
			});
			return cooling;
		}
		return healthy;
	}

	/** Record a failed transport attempt on `target` and cool it down after
	 *  RPC_MAX_CONSECUTIVE_FAILURES in a row. */
	private demote(target: EndpointStat, err: Error): void {
		target.consecutiveFailures++;
		const cls = classifyEndpointError(err);
		target.lastErrorCode = cls.code;
		target.lastErrorKind = cls.kind;
		if (target.consecutiveFailures >= RPC_MAX_CONSECUTIVE_FAILURES) {
			// Exponential-ish cooldown capped at 5 minutes.
			const base = 1_500;
			const cool = Math.min(
				5 * 60_000,
				base * 2 ** (target.consecutiveFailures - RPC_MAX_CONSECUTIVE_FAILURES)
			);
			target.cooldownUntil = Date.now() + cool;
		}
	}

	/** One JSON-RPC request to one endpoint. Resolves with the result; throws an
	 *  RpcError when the node answered with a JSON-RPC error (the node is not
	 *  demoted — it answered), or the transport error otherwise (demoted). */
	private async callOne<T>(target: EndpointStat, method: string, params: unknown): Promise<T> {
		const started = performance.now();
		const body: JsonRpcRequest = {
			jsonrpc: '2.0',
			id: this.nextRpcId++,
			method,
			params: params ?? {}
		};
		let json: JsonRpcResponse<T>;
		try {
			// A hidden endpoint gets the hidden-transport timeout floor: a flat 8 s
			// cannot survive a cold Tor/I2P circuit.
			const res = await fetchWithTimeout(
				target.url,
				body,
				withHiddenFloor(RPC_TIMEOUT_MS, target.url)
			);
			json = (await res.json()) as JsonRpcResponse<T>;
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			this.demote(target, e);
			throw e;
		}
		target.lastLatencyMs = Math.round(performance.now() - started);
		target.consecutiveFailures = 0;
		target.lastOkAt = Date.now();
		target.lastErrorCode = null;
		target.lastErrorKind = null;
		if (json !== null && typeof json === 'object' && 'error' in json && json.error) {
			throw new RpcError(json.error.message, json.error.code, target.url);
		}
		return (json as JsonRpcSuccess<T>).result;
	}

	/**
	 * Call a JSON-RPC method. Tries up to `RPC_MAX_RETRIES_PER_CALL`
	 * endpoints before giving up. Throws if all eligible endpoints fail.
	 */
	async call<T = unknown>(method: string, params?: unknown): Promise<T> {
		const eligible = this.eligible();
		const tried: string[] = [];
		let lastErr: Error | null = null;

		for (
			let attempt = 0;
			attempt < Math.min(RPC_MAX_RETRIES_PER_CALL, eligible.length);
			attempt++
		) {
			const target = eligible[attempt]!;
			tried.push(target.url);
			try {
				return await this.callOne<T>(target, method, params);
			} catch (err) {
				// A JSON-RPC error is the caller's problem (the node answered, it
				// said no): re-raise at once. A transport error tries the next node.
				if (err instanceof RpcError) throw err;
				lastErr = err instanceof Error ? err : new Error(String(err));
			}
		}
		throw new EndpointRotationError(
			`All ${tried.length} endpoint(s) failed for method ${method}`,
			tried,
			lastErr
		);
	}

	/** The endpoints to try, best first (healthy before cooling down; with
	 *  privacyFirst, hidden-service nodes before clearnet ones). */
	nodesInOrder(): readonly string[] {
		return this.eligible().map((s) => s.url);
	}

	/** The operator behind `url` (see rpcOperatorOf): operators are counted
	 *  by node name, or by host name for a node without one. They are not
	 *  proven independent; the default hidden nodes are run by the project. */
	operatorOf(url: string): string {
		return rpcOperatorOf(url);
	}

	/** One JSON-RPC request to the endpoint `url` (no failover: the caller
	 *  chooses the node). Throws like `call` does when that node fails. */
	async callAt<T = unknown>(url: string, method: string, params?: unknown): Promise<T> {
		const target = this.stats.get(url);
		if (target === undefined) throw new Error(`not in this rotator's pool: ${url}`);
		return this.callOne<T>(target, method, params);
	}

	/** Replace the endpoint list. Preserves stats for endpoints that
	 *  survive the change; new URLs start with a clean slate. */
	setEndpoints(urls: string[]): void {
		const kept = new Map<string, EndpointStat>();
		for (const u of urls) {
			const existing = this.stats.get(u);
			kept.set(
				u,
				existing ?? {
					url: u,
					consecutiveFailures: 0,
					lastLatencyMs: null,
					lastOkAt: null,
					cooldownUntil: 0,
					lastErrorCode: null,
					lastErrorKind: null
				}
			);
		}
		this.stats.clear();
		for (const [u, s] of kept) this.stats.set(u, s);
		this.order = shuffle([...urls]);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, body: JsonRpcRequest, ms: number): Promise<Response> {
	const ac = new AbortController();
	// This is a PRIVATE copy of the shared helper (it POSTs a JSON-RPC body and
	// omits credentials), so it does not inherit the shared one's behaviour and
	// has to repeat both of its guarantees: the hidden-transport floor, and a
	// timer that stays armed across the body read. Callers already raise `ms`,
	// but applying it here too means a future caller cannot forget — and this
	// helper talks DIRECTLY to `.onion` endpoints, where the clearnet number is
	// never survivable.
	const timer = setTimeout(() => ac.abort(), withHiddenFloor(ms, url));
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: ac.signal,
			// Never send credentials to RPC endpoints — they're third-party
			// infrastructure from Morphit's perspective.
			credentials: 'omit',
			// No referer leakage.
			referrerPolicy: 'no-referrer',
			// A moderate cache hint; the rotator itself handles retries.
			cache: 'no-store'
		});
		if (!res.ok) {
			clearTimeout(timer);
			throw new Error(`HTTP ${res.status} from ${url}`);
		}
		// NOT cleared on success: `fetch()` resolves on headers and the caller
		// reads the body next. Clearing here left that read unbounded, so a
		// connection that stalled after headers never settled at all — the same
		// defect the shared helper had. unref() so a pending timer cannot hold a
		// Node process open; it is a no-op in the browser.
		(timer as unknown as { unref?: () => void }).unref?.();
		return res;
	} catch (err) {
		clearTimeout(timer);
		throw err;
	}
}

function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
}

export class RpcError extends Error {
	constructor(
		message: string,
		public readonly code: number,
		public readonly endpoint: string
	) {
		super(message);
		this.name = 'RpcError';
	}
}

export class EndpointRotationError extends Error {
	constructor(
		message: string,
		public readonly tried: readonly string[],
		public readonly lastError: Error | null
	) {
		super(message);
		this.name = 'EndpointRotationError';
	}
}

// ────────────────────────────────────────────────────────────────────────────
// App-wide singleton
// ────────────────────────────────────────────────────────────────────────────

let singleton: EndpointRotator | null = null;

/** The page context the RPC pool is chosen from. */
export interface PageOrigin {
	/** `location.protocol`, e.g. "https:" — including the colon. */
	readonly protocol: string;
	/** `location.hostname`, any case. */
	readonly hostname: string;
}

/**
 * Choose the browser's Blurt RPC pool for a given page origin.
 *
 * Pure and exported so it can be executed against every origin shape rather
 * than reasoned about. See `rpc-pool-mixed-content-smoke.ts`.
 *
 * Three cases:
 *
 * 1. SERVED FROM A HIDDEN ORIGIN — that network's hidden endpoints ONLY: the
 *    `.onion` nodes on a `.onion` page, the `.b32.i2p` nodes on an `.i2p`
 *    page. The visitor is on Tor or I2P and their browser must never open a
 *    clearnet connection, not even as a fallback, so there is no clearnet tier
 *    to fall through to.
 *
 * 2. SERVED OVER PLAIN HTTP FROM A CLEARNET NAME OR ADDRESS (e.g. a LAN or
 *    home box without TLS) — clearnet ONLY, like https. The page's
 *    Content-Security-Policy (the default host's, in
 *    ops/bunkerweb/frontend/nginx.conf and ops/nginx/web.conf) allows only the
 *    clearnet nodes, so a hidden node would be blocked before any connection
 *    and, with the release check's two-node budget, the check would never
 *    reach a node at all. A visitor on Tor reaches the private path through
 *    the instance's own .onion (case 1).
 *
 * 3. SERVED OVER HTTPS — clearnet ONLY.
 *
 *    The hidden endpoints are `http://…onion:8091`. Fetching http from an https
 *    page is MIXED ACTIVE CONTENT: Firefox blocks it outright, before any
 *    connection is attempted. The old comment here claimed these "fail fast
 *    because a .onion host is not a real DNS name, and fall through to
 *    clearnet" — the fallback happened, but the mechanism was wrong and the
 *    cost was real. Every visitor to an https instance took two guaranteed
 *    blocked requests on boot and got a mixed-content error in the console for
 *    each, on every page load. That is alarming in a project whose whole pitch
 *    is that you can audit what it does in your browser.
 *
 *    Nothing is lost by dropping them here. Browsers disagree on an http
 *    `.onion` origin (Tor Browser treats it as secure; Chromium does not: no
 *    secure context, no crypto.subtle, no service worker), so the behaviour
 *    was never consistent anyway — and the privacy path it was reaching for is
 *    served properly by Onion-Location (`$lib/seo/onionLocation`): Tor Browser
 *    is offered the instance's own `.onion`, and once there, case 1 applies and
 *    the pool is hidden-only. That is a stronger guarantee than a best-effort
 *    first attempt from the clearnet origin, not a weaker one.
 */
export function selectRpcPool(origin: PageOrigin | null): readonly string[] {
	// No `location` (SSR, prerender): assume the safest reachable pool.
	if (origin === null) return [...DEFAULT_RPC_ENDPOINTS];

	// Each hidden network gets its own nodes: an I2P proxy cannot route .onion
	// and Tor cannot route .b32.i2p.
	const host = origin.hostname.toLowerCase();
	if (host.endsWith('.onion')) return [...DEFAULT_HIDDEN_RPC_ENDPOINTS];
	if (host.endsWith('.i2p')) return [...DEFAULT_I2P_RPC_ENDPOINTS];

	// Any clearnet origin, https or plain http: the clearnet nodes its CSP
	// allows (an https page could not fetch the http hidden nodes anyway —
	// mixed active content).
	return [...DEFAULT_RPC_ENDPOINTS];
}

/** Get or create the app-wide rotator: the release check's pool for this page
 *  origin (selectRpcPool above; privacyFirst keeps hidden nodes ahead should a
 *  pool ever hold both tiers). The release check (fetchVerifiedRelease in ./releaseFetch.ts) is
 *  its only user. */
export function getRotator(): EndpointRotator {
	if (singleton) return singleton;
	const urls = selectRpcPool(
		typeof location === 'undefined'
			? null
			: { protocol: location.protocol, hostname: location.hostname }
	);
	singleton = new EndpointRotator(urls, { privacyFirst: true });
	// No warm-up probe: probing would send the visitor's IP to every node in the
	// pool. The rotator learns latency and health from the real requests.
	return singleton;
}
