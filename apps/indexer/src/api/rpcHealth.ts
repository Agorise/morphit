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
import net from 'node:net';

import type { EndpointState } from '@morphit/rpc-pool';
import { morphitUserAgent } from '$blurt/userAgent';
import { INDEXER_VERSION } from './health';
import { hiddenNetworkOf, hiddenServiceProxyConfigFromEnv } from '$indexer/hiddenServiceFetch';

/** Classify a pool URL into the card's transport buckets. Loopback → local (a
 *  co-located node), `.onion` → tor, `.b32.i2p`/`.i2p` → i2p, everything else
 *  (incl. `.loki`, which Morphit's RPC tier doesn't use) → clearnet. */
export function rpcTransportOf(url: string): 'clearnet' | 'tor' | 'i2p' | 'local' {
	try {
		const h = new URL(url).hostname.toLowerCase();
		if (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]') return 'local';
	} catch {
		// fall through to hidden/clearnet classification
	}
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
	/** A hidden node (.onion / .b32.i2p) that this instance can't reach because
	 *  its OWN Tor/i2pd proxy isn't running — i.e. "this instance has no Tor/I2P",
	 *  NOT "the node is down". The card shows a calm "requires Tor/I2P" note
	 *  rather than a red error, so the baked hidden nodes read as intentional on a
	 *  node that hasn't enabled the transport. */
	| 'transport_off'
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
	readonly transport: 'clearnet' | 'tor' | 'i2p' | 'local';
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
	now: number = Date.now(),
	transportsOff: ReadonlySet<'tor' | 'i2p'> = new Set()
): RpcEndpointsResponse {
	const byUrl = new Map(snapshot.map((s) => [s.url, s]));
	const endpoints: RpcEndpointHealth[] = [];
	for (const url of canonicalUrls) {
		const s = byUrl.get(url);
		if (!s) continue; // canonical node not in THIS indexer's pool → omit
		const cooldownMs = Math.max(0, s.cooldownUntil - now);
		const transport = rpcTransportOf(url);
		const healthy = s.consecutiveFailures === 0 && cooldownMs === 0;
		// A hidden node that's failing while THIS instance's transport proxy is
		// down → calm "requires Tor/I2P", not a red error.
		const transportOff =
			!healthy && (transport === 'tor' || transport === 'i2p') && transportsOff.has(transport);
		endpoints.push({
			url,
			transport,
			healthy,
			latency_ms: s.ewmaLatencyMs,
			consecutive_failures: s.consecutiveFailures,
			cooldown_ms: cooldownMs,
			...(transportOff ? { failure_reason: 'transport_off' as const } : {})
		});
	}
	return {
		network: 'morphit',
		generated_at: new Date(now).toISOString(),
		endpoints
	};
}

/** Which hidden transports are UNREACHABLE from this instance right now (their
 *  Tor SOCKS / i2pd HTTP proxy isn't listening). Used to render hidden nodes as
 *  a calm "requires Tor/I2P" instead of a red error. */
export async function unreachableTransports(): Promise<Set<'tor' | 'i2p'>> {
	const off = new Set<'tor' | 'i2p'>();
	const [tor, i2p] = await Promise.all([
		transportProxyReachable('tor'),
		transportProxyReachable('i2p')
	]);
	if (!tor) off.add('tor');
	if (!i2p) off.add('i2p');
	return off;
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

/** Per-transport probe timeout. Clearnet is fast; a `.onion` over Tor pays
 *  circuit-build latency (tens of seconds on the FIRST hit, then a few), and a
 *  `.b32.i2p` over i2p is slower still (fresh i2pd spends minutes building
 *  tunnels, then requests run ~10-20s). A single 6s budget marks slow-but-HEALTHY
 *  hidden nodes as unreachable and undercounts the pool — so hidden transports
 *  get a wider window. Probes run in parallel, so this lengthens the check only
 *  when a hidden node is actually slow, and never blocks the request path. */
function probeTimeoutMs(url: string): number {
	const t = rpcTransportOf(url);
	// local = loopback (instant); clearnet 6s; tor/i2p need the wide window.
	return t === 'i2p' ? 20_000 : t === 'tor' ? 12_000 : PROBE_TIMEOUT_MS;
}

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
/** Cheap TCP-connect check (is anything listening?). Never throws. */
function tcpConnectable(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.connect({ host, port });
		let settled = false;
		const done = (up: boolean): void => {
			if (settled) return;
			settled = true;
			sock.destroy();
			resolve(up);
		};
		sock.setTimeout(timeoutMs, () => done(false));
		sock.once('connect', () => done(true));
		sock.once('error', () => done(false));
	});
}

// Cache per-transport proxy reachability so a probe cycle doesn't re-check it for
// every hidden node.
const proxyUpCache = new Map<'tor' | 'i2p', { up: boolean; at: number }>();
const PROXY_CHECK_TTL_MS = 20_000;

/** True when THIS instance can reach its own Tor SOCKS / i2pd HTTP proxy — i.e.
 *  the transport is actually enabled here. When it's false, a hidden node's
 *  failure means "this instance has no Tor/I2P", not "the node is down". */
async function transportProxyReachable(transport: 'tor' | 'i2p'): Promise<boolean> {
	const cached = proxyUpCache.get(transport);
	if (cached && Date.now() - cached.at < PROXY_CHECK_TTL_MS) return cached.up;
	const cfg = hiddenServiceProxyConfigFromEnv(process.env);
	const addr = transport === 'tor' ? cfg.torSocks : cfg.i2pHttpProxy;
	let up = false;
	if (addr && addr.length > 0) {
		const lastColon = addr.lastIndexOf(':');
		const host = lastColon > 0 ? addr.slice(0, lastColon) : addr;
		const port = lastColon > 0 ? Number(addr.slice(lastColon + 1)) : NaN;
		up = await tcpConnectable(host || '127.0.0.1', Number.isFinite(port) ? port : transport === 'tor' ? 9050 : 4444, 1200);
	}
	proxyUpCache.set(transport, { up, at: Date.now() });
	return up;
}

async function probeOne(url: string): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), probeTimeoutMs(url));
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
		// A hidden node that failed AND whose transport proxy isn't reachable on
		// this instance → "no Tor/I2P here", not "node down". Surface it calmly.
		const t = rpcTransportOf(url);
		if ((t === 'tor' || t === 'i2p') && !(await transportProxyReachable(t))) {
			return { latencyMs: null, ok: false, reason: 'transport_off', httpStatus: null };
		}
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
		// Passive snapshot: also fold in "which hidden transports can't be reached
		// from here" so a node whose Tor/i2pd isn't running reads as a calm
		// "requires Tor/I2P" rather than a red error on page load.
		const transportsOff = await unreachableTransports();
		return c.json(buildRpcEndpointsResponse(snapshotFn(), canonicalUrls, Date.now(), transportsOff));
	});
	return app;
}
