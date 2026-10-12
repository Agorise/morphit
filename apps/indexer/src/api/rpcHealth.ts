/**
 * Morphit indexer — /v1/rpc-endpoints endpoint.
 *
 * Per-node health of the PUBLIC Blurt RPC nodes, as this indexer measures them,
 * so the stats page's RPC endpoints card can show how each one is doing and WHY
 * a failing one fails (the browser never contacts a node itself, for privacy).
 *
 * Privacy-first by construction:
 *   - It reports ONLY already-public nodes (publishedRpcEndpoints): the
 *     clearnet canon (`DEFAULT_BLURT_RPC_ENDPOINTS`, when this instance uses
 *     clearnet at all), the built-in hidden canon this instance uses, and the
 *     hidden nodes of the signed on-chain RPC directory. Anything the operator
 *     configured beyond those — a private upstream, their own onion or I2P
 *     node, a local or auto-detected loopback node — is neither listed nor
 *     probed.
 *   - Per node it exposes only coarse health: reachable-or-not, the latest
 *     round-trip, misses in a row, a closed-vocabulary failure reason (never an
 *     error text). Nothing per-account, nothing that correlates traders.
 *
 * Public, no auth, same rate-limit tier as the other read endpoints.
 *
 * v1.21.6 — WHERE THE NUMBERS COME FROM. The card used to open on the RPC
 * pool's passive state and then wait for one on-demand probe of every node:
 *   - the pool calls the hidden nodes seldom, so on page load they read as
 *     failed or "probing" with no latency, and clearnet figures were whatever
 *     the pool last smoothed (minutes old);
 *   - the probe answered only when the slowest node had answered or timed out
 *     (up to ~42 s), so the real figures arrived ~20 s after the page opened;
 *   - a refresh first repainted the passive state (red rows) and then waited
 *     for the probe again.
 * Now a background prober (RpcHealthProber) measures EVERY published node on
 * its own clock — each node every PROBE_EVERY_MS, independently, with one
 * retry before a miss counts — from the moment the indexer starts. A plain GET
 * answers at once from those measurements (each row carries `checked_at`); a
 * node not measured yet says so (no latency, no failures) instead of being
 * called down. `?probe=1` re-measures every node now (5 s global limit,
 * coalesced) and answers when that round is done. A GET probes nothing; its only
 * I/O is the node list's and the node names' directory reads (each cached 60 s).
 */

import { Hono } from 'hono';
import net from 'node:net';

import { morphitUserAgent } from '$blurt/userAgent';
import { INDEXER_VERSION } from './health';
import { hiddenNetworkOf, hiddenServiceProxyConfigFromEnv } from '$indexer/hiddenServiceFetch';
import { isHiddenRpcUrl, RPC_DIRECTORY_MAX_NODES } from '$blurt/rpcDirectoryOp';
import { readCappedBytes, RpcReplyTooLargeError } from '@morphit/hidden-transport/rpc-fetch';

/** A get_dynamic_global_properties reply is a few KB. */
const PROBE_REPLY_MAX_BYTES = 1024 * 1024;

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
 * WHY an active probe failed.
 *
 * Requirement: a flat red "unreachable" is useless — a node whose operator confirms
 * every response is a 200 was being labelled unreachable because probeOne
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
	 *  pingable" — Requirement: plain "Unreachable" is fine for this one. */
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
	/** The node answered its most recent measurement. */
	readonly healthy: boolean;
	/** Round-trip of that measurement in ms; null when it failed or the node has
	 *  not been measured yet. */
	readonly latency_ms: number | null;
	/** Misses in a row since the last success (each failed round is two, since a
	 *  round retries once); 0 when healthy or not measured yet. */
	readonly consecutive_failures: number;
	/** Always 0 since v1.21.6 (the pool's backoff is not this card's business);
	 *  kept so older clients keep parsing. */
	readonly cooldown_ms: number;
	/** WHY the node's most recent measurement failed, so the card can show a
	 *  one-line reason instead of a flat "unreachable". Null when healthy or not
	 *  measured yet. */
	readonly failure_reason?: RpcProbeFailure | null;
	/** HTTP status when `failure_reason === 'http'`, else null/absent. */
	readonly http_status?: number | null;
	/** Optional operator handle from the on-chain directory (morphit_rpc_v1 name).
	 *  Cosmetic + untrusted; absent when the node's operator published no name. */
	readonly name?: string;
	/** When this row was measured (ISO), or null when the node has not been
	 *  measured yet (v1.21.6; absent on the pool view). */
	readonly checked_at?: string | null;
}

export interface RpcEndpointsResponse {
	readonly network: 'morphit';
	readonly generated_at: string;
	readonly endpoints: readonly RpcEndpointHealth[];
}

/**
 * ACTIVE per-node probe: one lightweight, universal Blurt read per node.
 *
 * DDoS guard for the card's refresh (`?probe=1`): at most one forced round per
 * `PROBE_MIN_INTERVAL_MS` across every caller and IP, a concurrent burst
 * sharing ONE round (RpcHealthProber.checkAllNow) — no volume of clicks makes
 * the indexer ping the Blurt nodes faster than that.
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
const PROBE_TIMEOUT_TOR_MS = 12_000;
const PROBE_TIMEOUT_I2P_MS = 20_000;
function probeTimeoutMs(url: string): number {
	const t = rpcTransportOf(url);
	// local = loopback (instant); clearnet 6s; tor/i2p need the wide window.
	return t === 'i2p' ? PROBE_TIMEOUT_I2P_MS : t === 'tor' ? PROBE_TIMEOUT_TOR_MS : PROBE_TIMEOUT_MS;
}

/** How long one per-transport proxy check may take (see transportProxyReachable). */
const PROXY_CHECK_TIMEOUT_MS = 1_200;

/**
 * The longest a `?probe=1` answer can take (v1.21.5). The nodes are probed in
 * parallel, but the reply waits for the slowest: a node that misses is tried
 * twice, and each miss on a hidden node may add a check of this instance's own
 * proxy — so two full I2P windows plus two proxy checks.
 *
 * The browser's wait for this reply has to be longer than this. It was the
 * ordinary 8 s indexer budget, so whenever one hidden node was slow or down the
 * browser gave up first and the stats card kept the pool's passive snapshot:
 * "Probing…" for the hidden nodes (which the pool seldom calls, so it has no
 * latency for them) and stale figures for the clearnet ones the pool had not
 * used lately. `RPC_PROBE_SERVER_WORST_MS` in apps/web/src/lib/net/transportBudget.ts
 * covers it; rpc-probe-budget-smoke holds the two together, and holds both
 * under the reverse proxy's 60 s read timeout for /v1/.
 */
export const PROBE_WORST_CASE_MS =
	2 * (Math.max(PROBE_TIMEOUT_MS, PROBE_TIMEOUT_TOR_MS, PROBE_TIMEOUT_I2P_MS) + PROXY_CHECK_TIMEOUT_MS);

/**
 * map a thrown fetch error to a stable {@link RpcProbeFailure}.
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
		// Certificate / TLS handshake. THE case the maintainer hit: the node's operator
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
export interface ProbeResult {
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
	// Steady clock: a wall clock stepped back must not freeze the cache.
	if (cached && performance.now() - cached.at < PROXY_CHECK_TTL_MS) return cached.up;
	const cfg = hiddenServiceProxyConfigFromEnv(process.env);
	const addr = transport === 'tor' ? cfg.torSocks : cfg.i2pHttpProxy;
	let up = false;
	if (addr && addr.length > 0) {
		const lastColon = addr.lastIndexOf(':');
		const host = lastColon > 0 ? addr.slice(0, lastColon) : addr;
		const port = lastColon > 0 ? Number(addr.slice(lastColon + 1)) : NaN;
		up = await tcpConnectable(host || '127.0.0.1', Number.isFinite(port) ? port : transport === 'tor' ? 9050 : 4444, PROXY_CHECK_TIMEOUT_MS);
	}
	proxyUpCache.set(transport, { up, at: performance.now() });
	return up;
}

async function probeOne(url: string): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), probeTimeoutMs(url));
	// Steady clock: a wall clock stepped mid-probe must not give a negative
	// or hour-long round trip.
	const started = performance.now();
	try {
		const res = await fetch(url, {
			method: 'POST',
			signal: controller.signal,
			// Never followed: the probed nodes are third
			// parties from the on-chain directory, and a 307 to our own loopback
			// made this probe re-POST there (a blind SSRF). A redirect is reported
			// as the HTTP status it is.
			redirect: 'manual',
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
			// Cancel the unread body so the socket is released now.
			await res.body?.cancel().catch(() => {});
			return { latencyMs: null, ok: false, reason: 'http', httpStatus: res.status };
		}
		let bytes: Uint8Array;
		try {
			// Capped: `res.json()` read whatever the node chose to send.
			bytes = await readCappedBytes(res, PROBE_REPLY_MAX_BYTES, url);
		} catch (err) {
			// The deadline cut the body off (headers, then a stall or a drip):
			// the node timed out, it did not send a bad body.
			if (controller.signal.aborted) {
				return { latencyMs: null, ok: false, reason: 'timeout', httpStatus: null };
			}
			// Past the cap: an answer no honest node sends.
			if (err instanceof RpcReplyTooLargeError) {
				return { latencyMs: null, ok: false, reason: 'bad_body', httpStatus: res.status };
			}
			// The connection failed in the middle of the answer (a Tor circuit
			// collapsing): a network failure, not an unreadable answer.
			return { latencyMs: null, ok: false, reason: classifyProbeError(err), httpStatus: null };
		}
		let body: { result?: unknown; error?: unknown } | null;
		try {
			body = JSON.parse(Buffer.from(bytes).toString('utf8')) as { result?: unknown; error?: unknown } | null;
		} catch {
			return { latencyMs: null, ok: false, reason: 'bad_body', httpStatus: res.status };
		}
		// `null` (or any non-object) parses but is no JSON-RPC envelope (reading
		// `.error` off null threw into the transport catch below → 'network'),
		// and a node whose chain state is `null` did not answer the read.
		if (
			body === null ||
			typeof body !== 'object' ||
			body.error !== undefined ||
			body.result === undefined ||
			body.result === null
		) {
			return { latencyMs: null, ok: false, reason: 'rpc_error', httpStatus: res.status };
		}
		return { latencyMs: Math.round(performance.now() - started), ok: true, reason: null, httpStatus: null };
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

/** One measurement round for one node: probe it, and on a miss probe once
 *  more before believing it. A single jittery Tor/I2P miss on a node that is up
 *  must not read as an outage; two misses in a row are a real signal. */
export async function probeNodeRound(url: string): Promise<ProbeResult> {
	const first = await probeOne(url);
	return first.ok ? first : await probeOne(url);
}

/** Fresh, on-demand health for every given node (parallel rounds). A live
 *  measurement — used by the tests; the route serves RpcHealthProber's. */
export async function probeEndpoints(
	canonicalUrls: readonly string[],
	now: number = Date.now()
): Promise<RpcEndpointsResponse> {
	const endpoints = await Promise.all(
		canonicalUrls.map(async (url): Promise<RpcEndpointHealth> => {
			const r = await probeNodeRound(url);
			return {
				url,
				transport: rpcTransportOf(url),
				healthy: r.ok,
				latency_ms: r.latencyMs,
				// A failed round is two misses in a row.
				consecutive_failures: r.ok ? 0 : 2,
				cooldown_ms: 0,
				failure_reason: r.reason,
				http_status: r.httpStatus,
				checked_at: new Date(now).toISOString()
			};
		})
	);
	return { network: 'morphit', generated_at: new Date(now).toISOString(), endpoints };
}

/** How often the background prober re-measures each node. */
export const PROBE_EVERY_MS = 20_000;
/** How often it looks for nodes that are due (and for a changed node list). */
const PROBER_TICK_MS = 2_000;

/** The latest measurement of one node. */
interface NodeCheck {
	readonly result: ProbeResult;
	/** Wall-clock end of the round (published as `checked_at`). */
	readonly checkedAt: number;
	/** Failed rounds in a row (0 after a success). */
	readonly failedRounds: number;
}

/** A clock that never steps back (the schedule and the refresh limit). */
const monotonicMs = (): number => performance.now();

/**
 * Measures every published RPC node continuously, so /v1/rpc-endpoints can
 * answer at once with real, current figures (see the module doc).
 *
 *  - Each node is re-measured `everyMs` after the START of its last round, on
 *    its own: one slow or dead node never delays the others' figures. A round
 *    that takes longer than that (a dead hidden node: two full timeouts) is
 *    followed by the next one at the next tick.
 *  - The schedule and the refresh limit run on a monotonic clock: a wall clock
 *    stepped back (NTP, a restored VM) must not freeze every figure until it
 *    catches up. `checked_at` is wall-clock time.
 *  - A node is never measured twice at once (a round still running is shared).
 *  - `checkAllNow()` (the card's refresh) re-measures every node now — at most
 *    once per PROBE_MIN_INTERVAL_MS across all callers, concurrent callers
 *    sharing one round — so no number of clicks makes the indexer ping the
 *    nodes faster than that.
 *  - The node list is re-read every tick (it follows the on-chain directory);
 *    a node that leaves the list is forgotten, and its last round, if one was
 *    running, is not recorded. A tick never starts while the previous one is
 *    still reading the list.
 *  - stop() ends it: nothing more is probed, not even by a tick already
 *    under way.
 */
export class RpcHealthProber {
	private readonly checks = new Map<string, NodeCheck>();
	private readonly running = new Map<string, Promise<void>>();
	/** Monotonic start of each node's latest round (the schedule). */
	private readonly startedAt = new Map<string, number>();
	/** The last node list read successfully, as read and as a set. */
	private lastList: readonly string[] = [];
	private listed: ReadonlySet<string> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private ticking: Promise<void> | null = null;
	private stopped = false;
	private lastForcedAt = -Infinity;
	private forced: Promise<void> | null = null;
	private readonly everyMs: number;
	private readonly tickMs: number;
	private readonly probe: (url: string) => Promise<ProbeResult>;
	/** Wall clock: `checked_at`, `generated_at`. */
	private readonly now: () => number;
	/** Monotonic clock: the schedule and the refresh limit. */
	private readonly clock: () => number;

	constructor(
		private readonly urlsFn: () => readonly string[] | Promise<readonly string[]>,
		opts: {
			everyMs?: number;
			tickMs?: number;
			probe?: (url: string) => Promise<ProbeResult>;
			/** Wall clock; when given without `clock`, it drives the schedule too (tests). */
			now?: () => number;
			clock?: () => number;
		} = {}
	) {
		this.everyMs = opts.everyMs ?? PROBE_EVERY_MS;
		this.tickMs = opts.tickMs ?? PROBER_TICK_MS;
		this.probe = opts.probe ?? probeNodeRound;
		this.now = opts.now ?? Date.now;
		this.clock = opts.clock ?? opts.now ?? monotonicMs;
	}

	/** Start measuring (the first round starts at once). Idempotent. */
	start(): void {
		if (this.timer !== null) return;
		this.stopped = false;
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.tickMs);
		this.timer.unref?.();
	}

	/** Stop measuring. A round already running ends on its own timeout. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}

	/** The node list, never throwing (a failed read keeps the last good list). */
	async urls(): Promise<readonly string[]> {
		try {
			const urls = [...(await this.urlsFn())];
			this.lastList = urls;
			this.listed = new Set(urls);
			return urls;
		} catch {
			return this.lastList;
		}
	}

	/** Measure every node that is due (joins a tick still reading the list).
	 *  Exposed for tests. */
	tick(): Promise<void> {
		if (this.ticking !== null) return this.ticking;
		this.ticking = this.runTick().finally(() => {
			this.ticking = null;
		});
		return this.ticking;
	}

	private async runTick(): Promise<void> {
		const urls = await this.urls();
		if (this.stopped) return;
		const listed = new Set(urls);
		for (const url of this.checks.keys()) if (!listed.has(url)) this.checks.delete(url);
		for (const url of this.startedAt.keys()) if (!listed.has(url)) this.startedAt.delete(url);
		const now = this.clock();
		// Half a tick of slack: a round that started a few ms after its tick
		// (the list read) is due at the tick 20 s later, not the one after.
		const due = this.everyMs - this.tickMs / 2;
		for (const url of urls) {
			const started = this.startedAt.get(url);
			if (started === undefined || now - started >= due) void this.check(url);
		}
	}

	/** Measure one node now (or join the round already running for it). */
	private check(url: string): Promise<void> {
		const already = this.running.get(url);
		if (already !== undefined) return already;
		this.startedAt.set(url, this.clock());
		const round = this.probe(url)
			.then((result) => {
				// A node that left the list while this round ran stays forgotten.
				if (this.listed !== null && !this.listed.has(url)) return;
				const prev = this.checks.get(url);
				this.checks.set(url, {
					result,
					checkedAt: this.now(),
					failedRounds: result.ok ? 0 : (prev?.failedRounds ?? 0) + 1
				});
			})
			.catch(() => {
				// probeOne never throws; nothing to record if a custom probe did.
			})
			.finally(() => this.running.delete(url));
		this.running.set(url, round);
		return round;
	}

	/** Re-measure every node now and wait for the round (the card's refresh).
	 *  Rate-limited globally; see the class doc. */
	async checkAllNow(): Promise<void> {
		if (this.stopped) return;
		if (this.forced !== null) return this.forced;
		if (this.clock() - this.lastForcedAt < PROBE_MIN_INTERVAL_MS) return;
		this.lastForcedAt = this.clock();
		const run = (async () => {
			const urls = await this.urls();
			if (this.stopped) return;
			await Promise.all(urls.map((u) => this.check(u)));
		})();
		this.forced = run.finally(() => {
			this.forced = null;
		});
		return this.forced;
	}

	/** The latest figures for `urls`, in that order. A node not measured yet has
	 *  no latency and no failures (the card says "checking"), never "down". */
	snapshot(urls: readonly string[], now: number = this.now()): RpcEndpointsResponse {
		const endpoints = urls.map((url): RpcEndpointHealth => {
			const c = this.checks.get(url);
			const transport = rpcTransportOf(url);
			if (c === undefined) {
				return {
					url,
					transport,
					healthy: false,
					latency_ms: null,
					consecutive_failures: 0,
					cooldown_ms: 0,
					failure_reason: null,
					http_status: null,
					checked_at: null
				};
			}
			return {
				url,
				transport,
				healthy: c.result.ok,
				latency_ms: c.result.ok ? c.result.latencyMs : null,
				// Every failed round is two misses in a row.
				consecutive_failures: c.result.ok ? 0 : c.failedRounds * 2,
				cooldown_ms: 0,
				failure_reason: c.result.reason,
				http_status: c.result.httpStatus,
				checked_at: new Date(c.checkedAt).toISOString()
			};
		});
		return { network: 'morphit', generated_at: new Date(now).toISOString(), endpoints };
	}
}

/**
 * the public-node allow-list for the /v1/rpc-endpoints route. On a
 * tor-only instance (emptied its clearnet pool) the clearnet canon is
 * EXCLUDED: the active `?probe=1` path fetches each URL directly, so probing a
 * clearnet RPC from a tor-only box would leak the box's real IP to those
 * operators — the exact exposure tor-only exists to prevent — and would list
 * phantom clearnet endpoints the node never actually syncs from. Pure + total,
 * unit-tested. `usesClearnet` is simply "does this instance have a clearnet
 * sync pool" (config.blurtRpcEndpoints.length > 0).
 */
/**
 * The list /v1/rpc-endpoints may publish and probe: the public lists only,
 * never what the operator configured privately. PURE.
 */
export function publishedRpcEndpoints(opts: {
	/** This instance reads the chain over clearnet at all. */
	usesClearnet: boolean;
	clearnetCanon: readonly string[];
	/** The built-in public hidden nodes. */
	hiddenCanon: readonly string[];
	/** This instance's configured hidden pool (only canon members of it are published). */
	configuredHidden: readonly string[];
	/** Hidden nodes of the signed on-chain directory. */
	directoryHidden: readonly string[];
}): string[] {
	const configured = new Set(opts.configuredHidden);
	return canonicalProbeUrls({
		usesClearnet: opts.usesClearnet,
		clearnetCanon: opts.clearnetCanon,
		hidden: unionHidden(
			opts.hiddenCanon.filter((u) => configured.has(u)),
			opts.directoryHidden
		),
		local: [],
		autoLocal: []
	});
}

export function canonicalProbeUrls(opts: {
	usesClearnet: boolean;
	clearnetCanon: readonly string[];
	hidden: readonly string[];
	local: readonly string[];
	autoLocal: readonly string[];
}): string[] {
	return [
		...(opts.usesClearnet ? opts.clearnetCanon : []),
		...opts.hidden,
		...opts.local,
		...opts.autoLocal
	];
}

/** Live hidden-RPC endpoints from the on-chain directory (persisted in
 *  rpc_directory id=1, latest-wins → reflects add/update/remove). Cached ~60s so
 *  the /v1/rpc-endpoints route re-derives its canonical list per request cheaply.
 *  This is what makes a newly-pinned hidden node appear on the stats card
 *  network-wide WITHOUT an indexer restart or a Morphit release. */
let _dirHiddenCache: { at: number; urls: readonly string[] } | null = null;
const DIRECTORY_HIDDEN_TTL_MS = 60_000;
export async function directoryHiddenEndpoints(
	db: { query(sql: string): Promise<{ rows: Array<{ endpoints: string[] }> }> },
	// Steady clock (a wall clock stepped back would freeze the cache).
	now: number = performance.now()
): Promise<readonly string[]> {
	if (_dirHiddenCache && now - _dirHiddenCache.at < DIRECTORY_HIDDEN_TTL_MS) {
		return _dirHiddenCache.urls;
	}
	try {
		const r = await db.query('SELECT endpoints FROM rpc_directory WHERE id = 1');
		// At most what a valid signed directory can hold (an onion and an I2P
		// address per node): the row is read before the boot-time proof
		// (rpcDirectoryReload) and the prober measures every URL it returns,
		// all at once, every PROBE_EVERY_MS.
		const urls = (r.rows[0]?.endpoints ?? [])
			.filter((u) => isHiddenRpcUrl(u, 'onion') || isHiddenRpcUrl(u, 'i2p'))
			.slice(0, 2 * RPC_DIRECTORY_MAX_NODES);
		_dirHiddenCache = { at: now, urls };
		return urls;
	} catch {
		// Never throw into the route on a DB hiccup; serve the last good cache.
		return _dirHiddenCache?.urls ?? [];
	}
}

/** Dedupe-preserving union of the operator's configured hidden endpoints and
 *  the on-chain directory's. PURE — configured first so the operator's own seed
 *  keeps priority ordering. */
export function unionHidden(
	configured: readonly string[],
	directory: readonly string[]
): string[] {
	return [...new Set([...configured, ...directory])];
}

/** Live per-node operator handles from the on-chain directory (rpc_directory
 *  node_names jsonb, url→name). Cached like {@link directoryHiddenEndpoints}, so
 *  a newly-pinned/renamed node surfaces on /v1/rpc-endpoints within the TTL and
 *  a restart isn't needed. Cosmetic + untrusted. */
let _dirNamesCache: { at: number; names: ReadonlyMap<string, string> } | null = null;
export async function directoryNodeNames(
	db: { query(sql: string): Promise<{ rows: Array<{ node_names: Record<string, unknown> }> }> },
	now: number = performance.now()
): Promise<ReadonlyMap<string, string>> {
	if (_dirNamesCache && now - _dirNamesCache.at < DIRECTORY_HIDDEN_TTL_MS) {
		return _dirNamesCache.names;
	}
	try {
		const r = await db.query('SELECT node_names FROM rpc_directory WHERE id = 1');
		const raw = r.rows[0]?.node_names ?? {};
		const names = new Map<string, string>();
		for (const [url, name] of Object.entries(raw)) {
			if (typeof name === 'string') names.set(url, name);
		}
		_dirNamesCache = { at: now, names };
		return names;
	} catch {
		return _dirNamesCache?.names ?? new Map();
	}
}

/** Ascending-latency comparator; unmeasured (null) latency sorts LAST. */
function byLatencyAsc(a: number | null, b: number | null): number {
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return a - b;
}

/** Decorate an endpoints response with optional operator names (by URL) and sort
 *  it by measured latency ascending — clearnet + hidden together, fastest first,
 *  unmeasured last. Applied to every /v1/rpc-endpoints response so the public
 *  JSON always carries names and a stable latency order. PURE. */
export function withNamesSorted(
	resp: RpcEndpointsResponse,
	names: ReadonlyMap<string, string>
): RpcEndpointsResponse {
	const endpoints = resp.endpoints
		.map((e) => {
			const name = names.get(e.url);
			return name ? { ...e, name } : e;
		})
		.sort((a, b) => byLatencyAsc(a.latency_ms, b.latency_ms));
	return { ...resp, endpoints };
}

/** Test seam: reset the directory caches so a unit test sees a fresh read. */
export function __resetDirectoryHiddenCacheForTest(): void {
	_dirHiddenCache = null;
	_dirNamesCache = null;
}

export function rpcEndpointsRoute(
	// The background prober (started by main.ts) — the source of every figure.
	prober: Pick<RpcHealthProber, 'snapshot' | 'checkAllNow'>,
	// A getter (not a fixed array) so the canonical list re-derives per request:
	// newly-pinned on-chain hidden-RPC nodes appear WITHOUT an indexer restart or
	// a Morphit release. May be async (it can read the persisted rpc_directory).
	canonicalUrlsFn: () => readonly string[] | Promise<readonly string[]>,
	// Optional per-node operator handles (url→name) from the on-chain directory,
	// attached to each row; also drives nothing else (cosmetic). Defaults to none.
	namesFn: () =>
		| ReadonlyMap<string, string>
		| Promise<ReadonlyMap<string, string>> = () => new Map()
): Hono {
	const app = new Hono();
	app.get('/', async (c) => {
		// `?probe=1` → re-measure every node now (5 s global limit, coalesced),
		// then answer. Anything else → the prober's latest figures, at once.
		if (c.req.query('probe') === '1') await prober.checkAllNow();
		const canonicalUrls = await canonicalUrlsFn();
		const names = await namesFn();
		return c.json(withNamesSorted(prober.snapshot(canonicalUrls), names));
	});
	return app;
}
