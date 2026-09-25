/**
 * hiddenServicePool — REUSED, kept-warm connections to hidden-service peers.
 *
 * WHY THIS EXISTS
 * `fetchJsonViaHiddenService` builds a brand-new undici `Agent`/`ProxyAgent` for
 * every call and closes it again in a `finally`. For the federation probe, which
 * runs once every ten minutes per peer, that is exactly right: no idle sockets,
 * no state.
 *
 * For chat it is fatal. A message that has to reach the other person in under
 * six seconds cannot spend the first part of that budget on a SOCKS handshake
 * and a fresh TCP connection through a Tor circuit or an I2P tunnel — and the
 * per-call agent guarantees it does, every single time, because the connection
 * it opened was thrown away as soon as the previous message finished.
 *
 * So this module keeps ONE dispatcher per (network, proxy) and lets undici pool
 * connections per origin underneath it. The first message to a peer pays setup;
 * every message after it reuses an established connection. A periodic warm-up
 * (see `warmHiddenOrigin`) pays even that first cost in the background, before
 * anyone is waiting, so the first message of a conversation is fast too — which
 * is the case that matters, because it is the one where the other person has no
 * reason to be looking at their screen yet.
 *
 * WHAT KEEPS A TUNNEL ALIVE
 * Tor drops an idle circuit after roughly ten minutes and I2P an idle tunnel on
 * a similar scale, so `keepAliveTimeout` is set below that and the warm-up runs
 * well inside it. Going quiet for longer than the warm-up interval is the one
 * case that still pays setup, which is why the interval is a few minutes and not
 * a few tens of minutes.
 *
 * The pool is process-wide and deliberately NOT closed per call. `closePool()`
 * exists for shutdown and for tests, which must not leak sockets between cases.
 */

import { Agent, type Dispatcher } from 'undici';
import {
	hiddenNetworkOf,
	parseHostPort,
	makeSocks5Connector,
	makeHttpConnectConnector,
	ProxyUnavailableError,
	asLocalTransportFault,
	isProxyUnavailable,
	isLocalTransportFault,
	localFaultConfidence,
	lokinetEnabled
} from '@morphit/hidden-transport';
import type {
	HiddenServiceProxyConfig,
	HiddenNetwork,
	LocalFaultConfidence
} from '@morphit/hidden-transport';

/**
 * Idle-socket lifetime, and a number with a live cliff on BOTH sides.
 *
 * Under Tor's ~10min circuit idle timeout, so we are not holding a connection
 * the network has already given up on. And ABOVE the warm-up interval
 * (`WARM_INTERVAL_MS`, 3 min, in chatFastDispatcher), because a keep-alive
 * shorter than the gap between warm-ups means every warm-up finds a closed
 * socket and pays a fresh tunnel build — which turns the warm-up from the thing
 * that removes the cold-start cost into the thing that pays it, on a timer,
 * forever. Nothing about that failure is visible: messages still arrive, the
 * warm-up still reports success, and only the latency moves.
 *
 * Exported so the relationship can be asserted rather than trusted — the two
 * constants live in different files and neither mentions the other's value.
 * See `hiddenPoolKeepAlive.test.ts`, which also demonstrates the cliff is real.
 */
export const KEEP_ALIVE_MS = 4 * 60 * 1000;
/** Ceiling undici will negotiate up to if a peer asks for longer. */
export const KEEP_ALIVE_MAX_MS = 8 * 60 * 1000;
/**
 * Per-origin connection cap — ONE, deliberately.
 *
 * This looks like a throughput mistake and is the opposite. On a clearnet
 * origin, letting undici open a second connection when the first is busy costs
 * a TCP handshake and buys parallelism, so a handful is the obvious setting.
 * On a hidden service the same second connection costs a CIRCUIT BUILD — tens
 * of seconds — and the whole six-second delivery target is gone.
 *
 * And undici will open one readily. It dispatches a request the moment it is
 * made; if the previous response has not yet been returned to the idle list —
 * a matter of a microtask — the pool sees no free connection and builds
 * another. The smoke caught exactly that: message one warmed a tunnel, and
 * message two, sent immediately after, opened a second one and paid the build
 * again. On loopback that costs a millisecond and is invisible. On Tor it is
 * the second message of every conversation.
 *
 * With one connection per origin, undici QUEUES instead. Queueing behind an
 * in-flight chat push costs one round trip; building a parallel circuit costs
 * thirty to sixty seconds. There is no version of this trade where the extra
 * connection wins.
 *
 * This does NOT serialise the federation. The cap is per ORIGIN, and the shared
 * dispatcher covers every peer on the network, so twenty peers still get twenty
 * independent connections and are still pushed to concurrently. What is
 * serialised is two messages to the SAME peer, which is precisely the case
 * where a second circuit would have been built for no reason.
 */
const CONNECTIONS_PER_ORIGIN = 1;
/** Body cap for a peer's reply. The fast-path ack is a few bytes. */
const MAX_REPLY_BYTES = 64 * 1024;

/** One dispatcher per (network, proxy endpoint). */
const pool = new Map<string, Dispatcher>();

function poolKey(network: Exclude<HiddenNetwork, null>, config: HiddenServiceProxyConfig): string {
	if (network === 'tor') return `tor:${config.torSocks}`;
	if (network === 'i2p') return `i2p:${config.i2pHttpProxy}`;
	return 'loki';
}

/**
 * The shared dispatcher for this network. Created once and REUSED — the whole
 * point of this module. Throws {@link ProxyUnavailableError} when the local
 * daemon is not configured, so a caller can decline to blame the peer.
 */
export function dispatcherFor(url: string, config: HiddenServiceProxyConfig): Dispatcher {
	const network = hiddenNetworkOf(url);
	if (network === null) throw new Error(`not a hidden-service URL: ${url}`);

	const key = poolKey(network, config);
	const existing = pool.get(key);
	if (existing !== undefined) return existing;

	let dispatcher: Dispatcher;
	if (network === 'tor') {
		if (config.torSocks.length === 0) {
			throw new ProxyUnavailableError('Tor SOCKS proxy not configured');
		}
		const { host, port } = parseHostPort(config.torSocks, 9050);
		dispatcher = new Agent({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici's
			// connect type doesn't model a custom SOCKS connector cleanly.
			connect: makeSocks5Connector(host, port) as any,
			keepAliveTimeout: KEEP_ALIVE_MS,
			keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
			connections: CONNECTIONS_PER_ORIGIN
		});
	} else if (network === 'i2p') {
		if (config.i2pHttpProxy.length === 0) {
			throw new ProxyUnavailableError('I2P HTTP proxy not configured');
		}
		const { host, port } = parseHostPort(config.i2pHttpProxy, 4444);
		// A hand-written CONNECT connector rather than undici's `ProxyAgent`,
		// for the same reason Tor gets a hand-written SOCKS5 one: the failure
		// has to arrive as something a decision can be made from. `ProxyAgent`
		// reports a refused tunnel as `UND_ERR_ABORTED` with the status in
		// prose, and `UND_ERR_ABORTED` is also an ordinary abort — so a router
		// configured to refuse CONNECT was indistinguishable from a timeout,
		// and was silently recorded as the PEER's failure. Verified by reading
		// the real error off a real refusal, not inferred.
		dispatcher = new Agent({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici's
			// connect type doesn't model a custom tunnelling connector cleanly.
			connect: makeHttpConnectConnector(host, port) as any,
			keepAliveTimeout: KEEP_ALIVE_MS,
			keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
			connections: CONNECTIONS_PER_ORIGIN
		});
	} else {
		// .loki — routed by the lokinet tun, so a plain agent reaches it. Only
		// where lokinet RUNS: elsewhere the name would go to the system
		// resolver, which is the ISP's (v1.18.0 review, S3). Raised as the
		// same "not configured" marker a blanked Tor or I2P setting gives.
		if (!lokinetEnabled(config)) {
			throw new ProxyUnavailableError('Lokinet is not enabled on this node');
		}
		dispatcher = new Agent({
			keepAliveTimeout: KEEP_ALIVE_MS,
			keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
			connections: CONNECTIONS_PER_ORIGIN
		});
	}
	pool.set(key, dispatcher);
	return dispatcher;
}

/** Outcome of a warm-up: did the route come up, and if not, was it our end? */
export interface WarmResult {
	readonly ok: boolean;
	/** True when the failure was OUR Tor/i2pd/lokinet rather than the peer. */
	readonly localFault: boolean;
	/**
	 * How far a local fault can be pinned on our end — see
	 * `LocalFaultConfidence`. Carried for the same reason the send path carries
	 * it (M47): without it the breaker falls back to what the NETWORK implies,
	 * and I2P is otherwise conclusive, so one peer whose tunnel the proxy
	 * REFUSED — an ambiguous shape, and one a registration can manufacture —
	 * took I2P away from every other peer (v1.18.0 review, S2).
	 */
	readonly confidence?: LocalFaultConfidence;
}

/**
 * The most of a warm-up response that is read (v1.18.0 review, S4).
 *
 * A warm-up does not care what comes back; it reads the body only so the
 * connection returns to the pool clean. It used to read ALL of it — up to forty
 * peers at once, every three minutes, bounded only by the sixty-second timeout —
 * so a hostile peer could stream hundreds of megabytes into this process per
 * pass. A health body is a few hundred bytes; past this, the body is cancelled
 * and the connection given up rather than drained.
 */
export const WARM_BODY_MAX_BYTES = 64 * 1024;

export interface HiddenPostResult {
	readonly status: number;
	readonly body: string;
}

/**
 * POST JSON to a hidden-service URL over the pooled dispatcher.
 *
 * There was no POST path at all before this: the probe only ever GETs. Delivery
 * needs to hand a peer a payload, and it needs to do it on a warm connection.
 */
/**
 * Read a response body, bounded. A peer that streams forever must not be able to
 * hold a connection — or the memory behind it — open.
 *
 * Exported and shared by BOTH peer transports. The hidden path had this and the
 * clearnet path did not, which meant the same hostile peer was cheap to defend
 * against over Tor and free to exploit over HTTPS. One definition, so the two
 * cannot diverge again.
 */
export async function readCappedText(res: { body?: unknown }): Promise<string> {
	const stream = res.body as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null;
	const reader = stream?.getReader?.();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			total += value.byteLength;
			if (total > MAX_REPLY_BYTES) {
				await reader.cancel();
				break;
			}
			chunks.push(value);
		}
	}
	return Buffer.concat(chunks).toString('utf8');
}

export async function postJsonViaHiddenService(
	url: string,
	body: unknown,
	config: HiddenServiceProxyConfig,
	timeoutMs: number,
	headers: Readonly<Record<string, string>> = {}
): Promise<HiddenPostResult> {
	const dispatcher = dispatcherFor(url, config);
	const network = hiddenNetworkOf(url);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'POST',
			signal: ctrl.signal,
			redirect: 'manual',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				'user-agent': 'morphit-indexer/federation-chat-fast',
				...headers
			},
			body: JSON.stringify(body),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fetch's
			// lib.dom type omits undici's `dispatcher`.
			dispatcher
		} as any);

		return { status: res.status, body: await readCappedText(res) };
	} catch (err) {
		// NORMALISED HERE, because here is the only place that knows both which
		// network was dialled and how this instance is configured to reach it.
		// A caller further up holds a peer and an error and cannot tell "their
		// instance is down" from "our i2pd is not running" — and the difference
		// decides whether the peer gets blamed or simply dialled another way.
		throw asLocalTransportFault(err, network, config);
	} finally {
		clearTimeout(timer);
		// NOT closed. The connection stays in the pool for the next message —
		// that reuse is this module's entire reason to exist.
	}
}

/**
 * Establish (or refresh) a connection to a peer so the next real message does
 * not pay for it.
 *
 * Deliberately cheap and deliberately forgiving: it GETs the peer's health
 * endpoint and does not care what comes back. A peer that is down, or a circuit
 * that will not build, is not an error here — the next warm-up tries again, and
 * a real message falls back to paying its own setup. Reports whether the
 * connection came up AND whether the reason it did not was ours, for metrics,
 * for the reachability tracker, and for the smoke to assert on.
 */
export async function warmHiddenOrigin(
	origin: string,
	config: HiddenServiceProxyConfig,
	timeoutMs: number
): Promise<WarmResult> {
	const network = hiddenNetworkOf(origin);
	let dispatcher: Dispatcher;
	try {
		dispatcher = dispatcherFor(origin, config);
	} catch (err) {
		// The operator blanked this network's setting. That IS a local fault,
		// and the most clear-cut kind — worth reporting rather than swallowing.
		return { ok: false, localFault: isProxyUnavailable(err) };
	}
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`${origin.replace(/\/+$/, '')}/v1/health`, {
			method: 'GET',
			signal: ctrl.signal,
			redirect: 'manual',
			headers: { accept: 'application/json', 'user-agent': 'morphit-indexer/federation-warmup' },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			dispatcher
		} as any);
		// Drain so the connection returns to the pool ready for reuse. An
		// undrained body leaves the socket unusable, which would defeat the
		// warm-up completely while looking like it worked. CAPPED — see
		// WARM_BODY_MAX_BYTES — so a peer cannot stream memory into us.
		await drainCapped(res, WARM_BODY_MAX_BYTES);
		return { ok: true, localFault: false };
	} catch (err) {
		// A warm-up is the CHEAPEST detector this instance has for its own
		// transports being down: it runs at boot, before anyone has sent
		// anything, and again every few minutes. Reporting WHY it failed — as
		// opposed to the bare `false` this used to return — is what lets the
		// first chat message of the day take a working route immediately
		// instead of discovering the dead daemon for itself.
		// CLASSIFIED HERE RATHER THAN BY THE MARKER CLASS ALONE, because this
		// function calls `fetch` directly instead of going through
		// `postJsonViaHiddenService` — so nothing has normalised the error and
		// only Tor would carry the marker. An earlier version of this line asked
		// `isProxyUnavailable` and was therefore blind to a dead i2pd and a
		// missing lokinet tun: it reported them as the peer's fault, which meant
		// boot-time detection — the thing this function is most useful for —
		// worked on exactly one of the three networks.
		const localFault = isLocalTransportFault(err, network, config);
		return localFault
			? { ok: false, localFault, confidence: localFaultConfidence(err, network) }
			: { ok: false, localFault };
	} finally {
		clearTimeout(timer);
	}
}

/** Read and discard a response body, cancelling it past `max` bytes. */
async function drainCapped(res: Response, max: number): Promise<void> {
	const reader = res.body?.getReader();
	if (reader === undefined) return;
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			total += value?.byteLength ?? 0;
			if (total > max) {
				await reader.cancel().catch(() => undefined);
				return;
			}
		}
	} catch {
		/* a body that fails mid-read has told the warm-up all it needs */
	}
}

/**
 * Close every pooled dispatcher. Shutdown and tests only.
 *
 * `close()` is graceful: it waits for every in-flight request to finish. On
 * shutdown that includes a warm-up already under way, which may run for up to
 * WARM_TIMEOUT_MS — so a restart could stall for a minute behind a peer nobody
 * is waiting for. Given a deadline, whatever has not closed by then is
 * DESTROYED (v1.18.0 review, S6). Without one, the old graceful behaviour.
 */
export async function closePool(deadlineMs?: number): Promise<void> {
	const all = [...pool.values()];
	pool.clear();
	const graceful = Promise.all(all.map((d) => d.close().catch(() => undefined)));
	if (deadlineMs === undefined) {
		await graceful;
		return;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = await Promise.race([
		graceful.then(() => false),
		new Promise<boolean>((r) => {
			timer = setTimeout(() => r(true), deadlineMs);
			timer.unref?.();
		})
	]);
	if (timer !== undefined) clearTimeout(timer);
	if (late) await Promise.all(all.map((d) => d.destroy().catch(() => undefined)));
}

/** Pooled dispatcher count — for the smoke, to prove reuse rather than assume it. */
export function pooledDispatcherCount(): number {
	return pool.size;
}
