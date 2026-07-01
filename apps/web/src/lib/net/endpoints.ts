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
 * User can customize the endpoint list in Settings; changes persist in
 * localStorage and survive reloads.
 */

import { browser } from '$app/environment';
import {
	DEFAULT_RPC_ENDPOINTS,
	ENDPOINTS_STORAGE_KEY,
	RPC_TIMEOUT_MS,
	RPC_MAX_CONSECUTIVE_FAILURES,
	RPC_MAX_RETRIES_PER_CALL
} from './config';

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
// Endpoint list persistence
// ────────────────────────────────────────────────────────────────────────────

/** Load the user's endpoint list from localStorage, or seed defaults. */
export function loadEndpoints(): string[] {
	if (!browser) return [...DEFAULT_RPC_ENDPOINTS];
	try {
		const raw = window.localStorage.getItem(ENDPOINTS_STORAGE_KEY);
		if (!raw) return [...DEFAULT_RPC_ENDPOINTS];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [...DEFAULT_RPC_ENDPOINTS];
		const valid = parsed.filter(
			(u): u is string => typeof u === 'string' && /^https?:\/\/.+/i.test(u)
		);
		return valid.length > 0 ? valid : [...DEFAULT_RPC_ENDPOINTS];
	} catch {
		return [...DEFAULT_RPC_ENDPOINTS];
	}
}

/** Persist the user's endpoint list. */
export function saveEndpoints(urls: string[]): void {
	if (!browser) return;
	try {
		window.localStorage.setItem(ENDPOINTS_STORAGE_KEY, JSON.stringify(urls));
	} catch {
		// Quota exhausted or Privacy Mode; silently ignore. User's
		// custom list is a nice-to-have, not a correctness feature.
	}
}

/** Reset to the default pool. */
export function resetEndpoints(): void {
	if (!browser) return;
	try {
		window.localStorage.removeItem(ENDPOINTS_STORAGE_KEY);
	} catch {
		// ignore
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Rotator
// ────────────────────────────────────────────────────────────────────────────

export class EndpointRotator {
	private readonly stats: Map<string, EndpointStat>;
	private order: string[];
	/** Incrementing JSON-RPC id counter, per rotator instance. */
	private nextRpcId = 1;

	constructor(endpoints: readonly string[]) {
		if (endpoints.length === 0) {
			throw new Error('EndpointRotator requires at least one endpoint URL');
		}
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
		//   1. Fewer consecutive failures first
		//   2. Then by last latency (unknown = treat as infinity, so known-fast wins)
		healthy.sort((a, b) => {
			if (a.consecutiveFailures !== b.consecutiveFailures) {
				return a.consecutiveFailures - b.consecutiveFailures;
			}
			const aLat = a.lastLatencyMs ?? Number.POSITIVE_INFINITY;
			const bLat = b.lastLatencyMs ?? Number.POSITIVE_INFINITY;
			return aLat - bLat;
		});
		// If nothing is healthy, try the coolest (expired-soonest) cooldowns.
		if (healthy.length === 0) {
			cooling.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
			return cooling;
		}
		return healthy;
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
				const started = performance.now();
				const body: JsonRpcRequest = {
					jsonrpc: '2.0',
					id: this.nextRpcId++,
					method,
					params: params ?? {}
				};
				const res = await fetchWithTimeout(target.url, body, RPC_TIMEOUT_MS);
				const json = (await res.json()) as JsonRpcResponse<T>;
				const elapsed = performance.now() - started;
				if ('error' in json && json.error) {
					// JSON-RPC error — not a transport issue, don't demote the
					// endpoint for it. (e.g. method not supported, bad params.)
					target.lastLatencyMs = Math.round(elapsed);
					target.consecutiveFailures = 0;
					target.lastOkAt = Date.now();
					target.lastErrorCode = null;
					target.lastErrorKind = null;
					throw new RpcError(json.error.message, json.error.code, target.url);
				}
				target.lastLatencyMs = Math.round(elapsed);
				target.consecutiveFailures = 0;
				target.lastOkAt = Date.now();
				target.lastErrorCode = null;
				target.lastErrorKind = null;
				return (json as JsonRpcSuccess<T>).result;
			} catch (err) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				// Do not demote for JSON-RPC-level errors (the server
				// answered, it just said no).
				if (!(err instanceof RpcError)) {
					target.consecutiveFailures++;
					// Capture WHY it failed so the endpoint-settings panel can
					// show it (HTTP status / timeout / unreachable), not just a
					// failure count.
					const cls = classifyEndpointError(lastErr);
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
				} else {
					// Re-raise RPC-level errors immediately; they're the
					// caller's problem, not a transport problem.
					throw err;
				}
			}
		}
		throw new EndpointRotationError(
			`All ${tried.length} endpoint(s) failed for method ${method}`,
			tried,
			lastErr
		);
	}

	/**
	 * Audit 2026-05 finding 2-7: call up to `maxN` endpoints in
	 * parallel and return all individual results.  Caller compares
	 * the results to detect a single hostile endpoint lying about
	 * chain state.
	 *
	 * Unlike `call`, this method does NOT fail on individual
	 * endpoint errors — it returns an array of per-endpoint
	 * outcomes (success or error).  The caller decides what
	 * constitutes "quorum agreement."
	 *
	 * Endpoints are picked from `eligible()` (best-first).  At
	 * minimum 1 outcome is returned (or the array is empty when
	 * no endpoints are configured).  Each outcome has the URL so
	 * the caller can correlate.
	 */
	async callMany<T = unknown>(
		method: string,
		params: unknown,
		maxN: number
	): Promise<
		ReadonlyArray<
			| {
					readonly url: string;
					readonly ok: true;
					readonly result: T;
			  }
			| {
					readonly url: string;
					readonly ok: false;
					readonly error: Error;
			  }
		>
	> {
		const eligible = this.eligible();
		const targets = eligible.slice(0, Math.max(1, Math.min(maxN, eligible.length)));
		const promises = targets.map(async (target) => {
			try {
				const started = performance.now();
				const body: JsonRpcRequest = {
					jsonrpc: '2.0',
					id: this.nextRpcId++,
					method,
					params: params ?? {}
				};
				const res = await fetchWithTimeout(target.url, body, RPC_TIMEOUT_MS);
				const json = (await res.json()) as JsonRpcResponse<T>;
				const elapsed = performance.now() - started;
				if ('error' in json && json.error) {
					target.lastLatencyMs = Math.round(elapsed);
					target.consecutiveFailures = 0;
					target.lastOkAt = Date.now();
					target.lastErrorCode = null;
					target.lastErrorKind = null;
					return {
						url: target.url,
						ok: false as const,
						error: new RpcError(json.error.message, json.error.code, target.url)
					};
				}
				target.lastLatencyMs = Math.round(elapsed);
				target.consecutiveFailures = 0;
				target.lastOkAt = Date.now();
				target.lastErrorCode = null;
				target.lastErrorKind = null;
				return {
					url: target.url,
					ok: true as const,
					result: (json as JsonRpcSuccess<T>).result
				};
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));
				if (!(e instanceof RpcError)) {
					target.consecutiveFailures++;
					const cls = classifyEndpointError(e);
					target.lastErrorCode = cls.code;
					target.lastErrorKind = cls.kind;
					if (target.consecutiveFailures >= RPC_MAX_CONSECUTIVE_FAILURES) {
						const base = 1_500;
						const cool = Math.min(
							5 * 60_000,
							base * 2 ** (target.consecutiveFailures - RPC_MAX_CONSECUTIVE_FAILURES)
						);
						target.cooldownUntil = Date.now() + cool;
					}
				}
				return {
					url: target.url,
					ok: false as const,
					error: e
				};
			}
		});
		return Promise.all(promises);
	}

	/**
	 * Warm up by pinging each endpoint once. Populates lastLatencyMs so
	 * the initial call uses meaningful priority. Non-blocking on the
	 * caller — returns a promise that resolves when all probes complete
	 * (or timeout).
	 */
	async warmup(): Promise<void> {
		await Promise.allSettled(
			this.order.map(async (url) => {
				const target = this.stats.get(url)!;
				try {
					const started = performance.now();
					const body: JsonRpcRequest = {
						jsonrpc: '2.0',
						id: this.nextRpcId++,
						method: 'database_api.get_dynamic_global_properties',
						params: {}
					};
					const res = await fetchWithTimeout(url, body, RPC_TIMEOUT_MS);
					if (res.ok) {
						const elapsed = performance.now() - started;
						target.lastLatencyMs = Math.round(elapsed);
						target.lastOkAt = Date.now();
						target.consecutiveFailures = 0;
						target.lastErrorCode = null;
						target.lastErrorKind = null;
					}
				} catch (err) {
					// The endpoint-settings panel probes via warmup(), so this is
					// where its "why did this node fail" detail comes from — capture
					// and classify the error instead of discarding it.
					target.consecutiveFailures++;
					const cls = classifyEndpointError(err instanceof Error ? err : new Error(String(err)));
					target.lastErrorCode = cls.code;
					target.lastErrorKind = cls.kind;
				}
			})
		);
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
	const timer = setTimeout(() => ac.abort(), ms);
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
			throw new Error(`HTTP ${res.status} from ${url}`);
		}
		return res;
	} finally {
		clearTimeout(timer);
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

/** Get or create the app-wide rotator. Warmup is kicked off on first
 *  access and runs in the background — calls made before warmup completes
 *  still work, just without latency-informed priority. */
export function getRotator(): EndpointRotator {
	if (singleton) return singleton;
	const urls = loadEndpoints();
	singleton = new EndpointRotator(urls);
	// cp268 privacy (#1): do NOT warmup-probe every endpoint here.
	// getRotator() runs on ordinary pages (the layout's per-session
	// release-integrity check reaches it), and an eager warmup POSTed
	// `get_dynamic_global_properties` to ALL configured Blurt RPC nodes
	// from the user's browser on every page load — leaking the user's IP
	// to several third-party operators at once (and throwing CORS errors
	// on any node whose server-side CORS headers are misconfigured, e.g.
	// a missing or doubled Access-Control-Allow-Origin). It was also
	// redundant: `call()` records each endpoint's latency / health on
	// every real request, so the rotator self-tunes organically. warmup()
	// is now OPT-IN — invoked explicitly only from the endpoint-settings
	// UI, where probing every node is a deliberate user action.
	return singleton;
}

/** Reset singleton. Mainly useful after the user edits the endpoint list. */
export function refreshRotator(): EndpointRotator {
	singleton = null;
	return getRotator();
}
