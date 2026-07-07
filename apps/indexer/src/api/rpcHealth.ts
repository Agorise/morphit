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

export function rpcEndpointsRoute(
	snapshotFn: () => readonly EndpointState[],
	canonicalUrls: readonly string[]
): Hono {
	const app = new Hono();
	app.get('/', (c) => c.json(buildRpcEndpointsResponse(snapshotFn(), canonicalUrls)));
	return app;
}
