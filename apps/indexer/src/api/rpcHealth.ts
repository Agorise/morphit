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
import { morphitUserAgent } from '$blurt/userAgent';
import { INDEXER_VERSION } from './health';
import { hiddenNetworkOf } from '$indexer/hiddenServiceFetch';

/** Classify a pool URL into the card's transport buckets. `.onion` → tor,
 *  `.b32.i2p`/`.i2p` → i2p, everything else (incl. `.loki`, which Morphit's RPC
 *  tier doesn't use) → clearnet. */
export function rpcTransportOf(url: string): 'clearnet' | 'tor' | 'i2p' {
	const net = hiddenNetworkOf(url);
	return net === 'tor' ? 'tor' : net === 'i2p' ? 'i2p' : 'clearnet';
}

/**
 * cp471 (tt.txt C) — WHY an active probe failed.
 *
 * Ken: a flat red "unreachable" is useless — a node whose operator confirms
 * "all responses are 200" was being labelled unreachable because probeOne
 * collapsed EVERY failure mode (TLS, non-2xx, JSON-RPC error, timeout, DNS)
 * into a bare `ok:false`. These codes are a CLOSED, stable vocabulary.
 *
 * PRIVACY (#1) + safety: a raw error message can carry internal paths, IPs, or
 * upstream hostnames, and this endpoint is PUBLIC. So we publish only this enum
 * plus a numeric HTTP status — never the underlying message.
 *
 * NOTE there is no 'cors' code and there never can be: this probe runs
 * SERVER-SIDE in the indexer (the browser never touches a Blurt node — that's
 * the privacy design locked by endpoint-error-classify-smoke). CORS is a
 * browser-only concept, so it cannot be the cause of a node showing red here.
 */
export type RpcProbeFailure =
	/** Deadline hit — no response within PROBE_TIMEOUT_MS. */
	| 'timeout'
	/** TLS/certificate problem (expired, untrusted chain, wrong host). */
	| 'tls'
	/** DNS name resolution failed. */
	| 'dns'
	/** Connection actively refused. */
	| 'refused'
	/** Any other transport-level failure (reset, unroutable). Truly "not
	 *  pingable" — Ken: plain "Unreachable" is fine for this one. */
	| 'network'
	/** The node ANSWERED with a non-2xx (see `http_status`) — e.g. a WAF /
	 *  security policy returning 403, or a bad gateway. */
	| 'http'
	/** HTTP 200, but the JSON-RPC envelope carried an error / no result. */
	| 'rpc_error'
	/** HTTP 200, but the body wasn't parseable JSON. */
	| 'bad_body';

/** Health of one canonical RPC node, as the indexer currently sees it. */
export interface RpcEndpointHealth {
	readonly url: string;
	/** Transport the indexer reaches this node over. `clearnet` = ordinary
	 *  HTTP(S); `tor` = a `.onion` (probed via the Tor SOCKS proxy); `i2p` = a
	 *  `.b32.i2p` (probed via the i2pd HTTP proxy). Lets the Settings card badge
	 *  hidden-service nodes so the operator can see the pool spans clearnet AND
	 *  censorship-resistant transports — the browser never reaches these itself;
	 *  the indexer probes them server-side and reports what it sees. */
	readonly transport: 'clearnet' | 'tor' | 'i2p';
	/** Currently usable: no consecutive failures AND not parked in cooldown. */
	readonly healthy: boolean;
	/** Smoothed successful-call latency in ms, or null if never observed. */
	readonly latency_ms: number | null;
	/** Consecutive transport failures since the last success (0 when healthy). */
	readonly consecutive_failures: number;
	/** Remaining cooldown in ms before the node is retried (0 when available). */
	readonly cooldown_ms: number;
	/** cp471 (tt.txt C): WHY the most recent ACTIVE probe failed, so the card
	 *  can show a one-line reason instead of a flat "unreachable". Null/absent
	 *  when healthy, or on the passive pool snapshot (the pool doesn't retain a
	 *  reason — the card falls back to the generic label there). */
	readonly failure_reason?: RpcProbeFailure | null;
	/** HTTP status when `failure_reason === 'http'`, else null/absent. */
	readonly http_status?: number | null;
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
			transport: rpcTransportOf(url),
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

/**
 * cp471 (tt.txt C) — map a thrown fetch error to a stable {@link RpcProbeFailure}.
 *
 * Node's fetch wraps transport errors as `TypeError: fetch failed` with the real
 * cause on `err.cause` carrying a `code`. An aborted request surfaces as an
 * AbortError (name), not a code. Anything we don't recognize degrades to
 * 'network' — the honest "not pingable" bucket.
 *
 * Exported for the smoke: this mapping is the whole point of the feature, so it
 * is tested directly rather than through a live socket.
 */
export function classifyProbeError(err: unknown): RpcProbeFailure {
	const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
	if (e?.name === 'AbortError' || e?.cause?.name === 'AbortError') return 'timeout';
	const code = e?.cause?.code ?? e?.code;
	switch (code) {
		// Certificate / TLS handshake. THE case Ken hit: the node's operator
		// renovated the balancer certificate, so the node answered 200 to him
		// while our probe was failing the TLS handshake — and we rendered that
		// as "unreachable", which sent him chasing the wrong problem.
		case 'CERT_HAS_EXPIRED':
		case 'CERT_NOT_YET_VALID':
		case 'DEPTH_ZERO_SELF_SIGNED_CERT':
		case 'SELF_SIGNED_CERT_IN_CHAIN':
		case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
		case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
		case 'ERR_TLS_CERT_ALTNAME_INVALID':
		case 'ERR_SSL_WRONG_VERSION_NUMBER':
		case 'EPROTO':
			return 'tls';
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
			return 'dns';
		case 'ECONNREFUSED':
			return 'refused';
		case 'UND_ERR_HEADERS_TIMEOUT':
		case 'UND_ERR_BODY_TIMEOUT':
		case 'UND_ERR_CONNECT_TIMEOUT':
		case 'ETIMEDOUT':
			return 'timeout';
		default:
			return 'network';
	}
}

/** Result of one active probe: latency on success, or WHY it failed. */
interface ProbeResult {
	latencyMs: number | null;
	ok: boolean;
	reason: RpcProbeFailure | null;
	httpStatus: number | null;
}

/** Ping one node with a lightweight, universal Blurt read; return round-trip ms
 *  on success, or the classified reason on failure. Never throws. */
async function probeOne(url: string): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const started = Date.now();
	try {
		const res = await fetch(url, {
			method: 'POST',
			signal: controller.signal,
			headers: {
				'content-type': 'application/json',
				// Identify ourselves to the node being probed (a 403 from a
				// bot-trap is otherwise indistinguishable from a real outage).
				// This is the only indexer fetch that lacked its own UA; it
				// no longer relies on the retired global wrapper.
				'user-agent': morphitUserAgent(INDEXER_VERSION)
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'condenser_api.get_dynamic_global_properties',
				params: []
			})
		});
		// The node ANSWERED — a non-2xx is a very different diagnosis from
		// "unreachable" (403 = a WAF / security policy in front of the node,
		// 502 = the balancer can't reach its backend), so carry the status.
		if (!res.ok) {
			return { latencyMs: null, ok: false, reason: 'http', httpStatus: res.status };
		}
		let body: { result?: unknown; error?: unknown };
		try {
			body = (await res.json()) as { result?: unknown; error?: unknown };
		} catch {
			return { latencyMs: null, ok: false, reason: 'bad_body', httpStatus: res.status };
		}
		if (body.error !== undefined || body.result === undefined) {
			return { latencyMs: null, ok: false, reason: 'rpc_error', httpStatus: res.status };
		}
		return { latencyMs: Date.now() - started, ok: true, reason: null, httpStatus: null };
	} catch (err) {
		return { latencyMs: null, ok: false, reason: classifyProbeError(err), httpStatus: null };
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
			const { latencyMs, ok, reason, httpStatus } = await probeOne(url);
			return {
				url,
				transport: rpcTransportOf(url),
				healthy: ok,
				latency_ms: latencyMs,
				consecutive_failures: ok ? 0 : 1,
				cooldown_ms: 0,
				failure_reason: reason,
				http_status: httpStatus
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
