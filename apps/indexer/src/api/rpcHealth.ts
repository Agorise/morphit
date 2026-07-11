/**
 * Morphit indexer — /v1/rpc-endpoints endpoint (cp407).
 *
 * Per-node health for the Blurt RPC pool the indexer reads/writes through, so
 * the browser's Settings → RPC endpoints card can show WHY a server-only node
 * (one the browser can't probe directly, for privacy) is or isn't being used.
 *
 * Privacy-first by construction:
 *   - It reports ONLY the canonical, already-public Blurt nodes
 *     (`DEFAULT_BLURT_RPC_ENDPOINTS`). Any operator-custom endpoint the
 *     operator added via MORPHIT_INDEXER_RPC_ENDPOINTS is filtered OUT — the
 *     public body never reveals a private/internal upstream URL.
 *   - Per node it exposes only coarse health: reachable-or-not, smoothed
 *     latency, consecutive-failure count, remaining cooldown. Nothing
 *     per-account, nothing that correlates traders.
 *
 * Public, no auth, same rate-limit tier as the other read endpoints. Reads a
 * live in-memory snapshot from the poller's RPC pool — no DB, no I/O.
 */

import { Hono } from 'hono';

import type { EndpointState } from '@morphit/rpc-pool';

/** Health of one canonical RPC node, as the indexer currently sees it. */
export interface RpcEndpointHealth {
	readonly url: string;
	/** Currently usable: no consecutive failures AND not parked in cooldown. */
	readonly healthy: boolean;
	/** Smoothed successful-call latency in ms, or null if never observed. */
	readonly latency_ms: number | null;
	/** Consecutive transport failures since the last success (0 when healthy). */
	readonly consecutive_failures: number;
	/** Remaining cooldown in ms before the node is retried (0 when available). */
	readonly cooldown_ms: number;
}

export interface RpcEndpointsResponse {
	readonly network: 'morphit';
	readonly generated_at: string;
	readonly endpoints: readonly RpcEndpointHealth[];
}

/**
 * Shape the /v1/rpc-endpoints response from a pool snapshot. Pure + total —
 * exported so the privacy filter (canonical-only) and the health derivation
 * can be unit-tested from tsx without a running poller.
 *
 * `canonicalUrls` is the allow-list of already-public nodes
 * (`DEFAULT_BLURT_RPC_ENDPOINTS`). Snapshot rows for any other URL are dropped.
 * Output is ordered by the canonical list so the response is stable.
 */
export function buildRpcEndpointsResponse(
	snapshot: readonly EndpointState[],
	canonicalUrls: readonly string[],
	now: number = Date.now()
): RpcEndpointsResponse {
	const byUrl = new Map(snapshot.map((s) => [s.url, s]));
	const endpoints: RpcEndpointHealth[] = [];
	for (const url of canonicalUrls) {
		const s = byUrl.get(url);
		if (!s) continue; // canonical node not in THIS indexer's pool → omit
		const cooldownMs = Math.max(0, s.cooldownUntil - now);
		endpoints.push({
			url,
			healthy: s.consecutiveFailures === 0 && cooldownMs === 0,
			latency_ms: s.ewmaLatencyMs,
			consecutive_failures: s.consecutiveFailures,
			cooldown_ms: cooldownMs
		});
	}
	return {
		network: 'morphit',
		generated_at: new Date(now).toISOString(),
		endpoints
	};
}

/**
 * cp453 (t.txt #1) — ACTIVE per-node probe. The passive snapshot above only
 * reflects the pool's own traffic and barely moves; the Settings "refresh"
 * button wants FRESH latency for every canonical node on demand. This pings each
 * node once, in parallel, and reports the round-trip.
 *
 * DDoS guard: a GLOBAL 5s cache (`PROBE_MIN_INTERVAL_MS`) shared across every
 * caller and IP — no volume of clicks can make the indexer ping the Blurt nodes
 * more than once per 5s (a concurrent burst is coalesced onto ONE in-flight
 * probe). So a kid mashing refresh gets cached bytes, and the upstream nodes see
 * at most one probe every 5s regardless.
 */
const PROBE_MIN_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 6_000;

/** Ping one node with a lightweight, universal Blurt read; return round-trip ms
 *  on success or null on any failure/timeout. Never throws. */
async function probeOne(url: string): Promise<{ latencyMs: number | null; ok: boolean }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const started = Date.now();
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'condenser_api.get_dynamic_global_properties',
				params: []
			}),
			signal: controller.signal
		});
		if (!res.ok) return { latencyMs: null, ok: false };
		const body = (await res.json()) as { result?: unknown; error?: unknown };
		if (body.error !== undefined || body.result === undefined) return { latencyMs: null, ok: false };
		return { latencyMs: Date.now() - started, ok: true };
	} catch {
		return { latencyMs: null, ok: false };
	} finally {
		clearTimeout(timer);
	}
}

/** Fresh, on-demand health for every canonical node (parallel probes). Pure of
 *  the pool's passive state — this is a live measurement. */
export async function probeEndpoints(
	canonicalUrls: readonly string[],
	now: number = Date.now()
): Promise<RpcEndpointsResponse> {
	const endpoints = await Promise.all(
		canonicalUrls.map(async (url): Promise<RpcEndpointHealth> => {
			const { latencyMs, ok } = await probeOne(url);
			return {
				url,
				healthy: ok,
				latency_ms: latencyMs,
				consecutive_failures: ok ? 0 : 1,
				cooldown_ms: 0
			};
		})
	);
	return { network: 'morphit', generated_at: new Date(now).toISOString(), endpoints };
}

// Global 5s probe cache (shared across all requests/IPs).
let probeInFlight: Promise<RpcEndpointsResponse> | null = null;
let probeCache: { at: number; data: RpcEndpointsResponse } | null = null;

/** Rate-limited active probe: returns the cached result if the last real probe
 *  was <5s ago, coalesces concurrent callers onto one probe, else probes fresh. */
export async function cachedProbeEndpoints(
	canonicalUrls: readonly string[]
): Promise<RpcEndpointsResponse> {
	const now = Date.now();
	if (probeCache && now - probeCache.at < PROBE_MIN_INTERVAL_MS) return probeCache.data;
	if (probeInFlight) return probeInFlight;
	probeInFlight = (async () => {
		try {
			const data = await probeEndpoints(canonicalUrls, Date.now());
			probeCache = { at: Date.now(), data };
			return data;
		} finally {
			probeInFlight = null;
		}
	})();
	return probeInFlight;
}

/** Test-only: reset the module-level probe cache between unit runs. */
export function __resetProbeCacheForTests(): void {
	probeInFlight = null;
	probeCache = null;
}

export function rpcEndpointsRoute(
	snapshotFn: () => readonly EndpointState[],
	canonicalUrls: readonly string[]
): Hono {
	const app = new Hono();
	app.get('/', async (c) => {
		// `?probe=1` → fresh active ping of every node (5s-rate-limited server-side,
		// t.txt #1). Anything else → the cheap passive pool snapshot.
		if (c.req.query('probe') === '1') {
			return c.json(await cachedProbeEndpoints(canonicalUrls));
		}
		return c.json(buildRpcEndpointsResponse(snapshotFn(), canonicalUrls));
	});
	return app;
}
