/**
 * @morphit/hidden-transport/router — the process-wide hidden-service routing
 * dispatcher, and the clearnet policy that goes with it.
 *
 * ONE HOME FOR BOTH PROCESSES. This lived in the indexer, and only the indexer
 * installed it. The RELAY — the component that broadcasts signups and relayed
 * transfers — had none: on a tor-only node the indexer read the chain over Tor
 * and I2P while the relay went to clearnet RPC operators from the box's own
 * address, and an `.onion` endpoint merged into its pool from the on-chain
 * directory could not be reached at all (F32). Moving the router here, rather
 * than copying it into the relay, is the lesson this codebase keeps relearning:
 * a decision with two homes is one that can disagree with itself.
 *
 * A SEPARATE ENTRY POINT, NOT PART OF `index.ts`. The package's main entry is
 * dependency-free so the ops-cli can bundle it offline; this file needs undici's
 * Agent and Dispatcher. Nothing that imports `@morphit/hidden-transport` pulls
 * it in — only an explicit `@morphit/hidden-transport/router` does, and every
 * such importer already depends on undici.
 *
 * What follows is the indexer's original design notes, unchanged in substance.
 */
/*
 * WHY THIS EXISTS
 * The chain RPC client is `@beblurt/dblurt`, whose `Client` makes calls with the
 * GLOBAL `fetch` (undici) and exposes no per-request dispatcher hook. So to let
 * the RPC pool include hidden-service endpoints (.onion / .b32.i2p) we install a
 * global undici dispatcher that routes PER ORIGIN:
 *
 *   - `.onion`  → the Tor SOCKS5 proxy (via `makeSocks5Connector`)
 *   - `.b32.i2p`/`.i2p` → the i2pd HTTP proxy (a CONNECT connector)
 *   - everything else (clearnet, `.loki`) → a plain `Agent`, i.e. undici's
 *     ordinary behaviour, UNCHANGED.
 *
 * SECURITY / BLAST-RADIUS REASONING (read before touching this)
 *  1. CLEARNET IS UNTOUCHED. A clearnet origin is delegated to a plain `Agent`
 *     with undici defaults — byte-for-byte the same path as if this dispatcher
 *     were never installed. The router only *diverts* the two hidden suffixes;
 *     it never alters, inspects, or proxies clearnet traffic.
 *  2. ONLY the two hidden suffixes divert, and via a STRICT classifier
 *     (`hiddenNetworkOf`: `.onion` must be a 56-char v3 address; `.i2p` suffix).
 *     A clearnet host can never be routed to a proxy.
 *  3. NO SSRF SURFACE. `.onion`/`.i2p` are not IP addresses, so they cannot
 *     target internal/loopback IPs through the proxy. The app-level SSRF guards
 *     (net-defense IP/DNS pinning) live above the transport and are unaffected.
 *  4. FAIL-SAFE, NEVER FAIL-OPEN. If the Tor/i2pd proxy is down, the hidden
 *     endpoint's connection fails and the pool marks it unhealthy and uses a
 *     clearnet endpoint — the node keeps working. A hidden request is NEVER
 *     silently downgraded onto the clear net, and NEVER handed to the direct
 *     agent: if the proxy for its network is unconfigured, or the name only
 *     looks hidden (a short `.onion`), or it is `.loki` on a node without
 *     Lokinet, the request is REFUSED before any lookup. Handing it to the
 *     direct agent would ask the system resolver (the ISP's) for the name, and
 *     that question is itself the leak (v1.18.0 review, S11; this comment said
 *     the opposite until v1.18.0 deep-deep, L4).
 *  5. ALWAYS INSTALLED (v1.18.0 deep-deep, L3). It used to be installed only
 *     when hidden RPC endpoints were configured, but the on-chain RPC directory
 *     merges hidden nodes into every pool, and with no router their names went
 *     to the system resolver. A clearnet node installs it in `allow` mode, where
 *     clearnet goes to a plain Agent — undici's own default — so its clearnet
 *     behaviour is unchanged. See `routerInstallPolicy`.
 */

import { Agent, Dispatcher, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import {
	hiddenNetworkOf,
	makeSocks5Connector,
	makeHttpConnectConnector,
	parseHostPort,
	lokinetEnabled,
	isLocalHost,
	ProxyUnavailableError,
	type HiddenServiceProxyConfig
} from './index.js';

export type HiddenRoute = 'tor' | 'i2p' | 'direct';

/** Which transport an origin must use. PURE + total — the security-critical
 *  routing decision, exhaustively unit-tested. `.loki` and clearnet both go
 *  `direct` (lokinet resolves `.loki` on its tun; clearnet is normal). */
export function hiddenRouteOf(origin: string): HiddenRoute {
	const net = hiddenNetworkOf(origin);
	return net === 'tor' ? 'tor' : net === 'i2p' ? 'i2p' : 'direct';
}

/** Does this origin's host end in `.onion` or `.i2p`? */
function hasHiddenSuffix(origin: string): boolean {
	try {
		const h = new URL(origin).hostname.toLowerCase();
		return h.endsWith('.onion') || h.endsWith('.i2p');
	} catch {
		return false;
	}
}

/** Is this a `.loki` origin (including a malformed URL that names one)? */
function isLokiOrigin(origin: string): boolean {
	try {
		return new URL(origin).hostname.toLowerCase().endsWith('.loki');
	} catch {
		return /\.loki(?::\d+)?(?:\/|$)/i.test(origin);
	}
}

/**
 * Is this origin a PUBLIC clearnet host — the thing a hidden-only node must
 * never touch? PURE. True for every DNS name that is not `localhost` or a
 * hidden/`.loki` name, and for every public IP. Returns FALSE for: `.onion`/
 * `.i2p` (hidden), `.loki` (lokinet's own tun), `localhost`, and loopback /
 * RFC1918 / link-local / ULA IP LITERALS — local services (the DB, a local
 * IPFS, a docker bridge) that carry no clearnet-exit / deanonymisation risk.
 * Used by the fail-closed hidden-only policy below to refuse (never proxy,
 * never leak) public clearnet.
 */
export function isClearnetOrigin(origin: string): boolean {
	if (hiddenRouteOf(origin) !== 'direct') return false; // tor/i2p → not clearnet
	let host: string;
	try {
		host = new URL(origin).hostname.toLowerCase();
	} catch {
		return false;
	}
	host = host.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
	if (host === '') return false;
	if (host.endsWith('.loki') || host.endsWith('.onion') || host.endsWith('.i2p')) return false;
	// Local ONLY as an address: an IP literal in a loopback / RFC1918 /
	// link-local / ULA range (IPv4-mapped unwrapped), or exactly `localhost`.
	// (v1.18.0 deep-deep, C1) This used to match the host's TEXT against
	// `10.`, `127.`, `192.168.` … — so the DNS name `10.attacker.example` was
	// "local", and a hidden-only node resolved it with the system resolver and
	// connected to wherever the attacker's DNS pointed, from its own address.
	// Anyone could register such an origin and be pushed chat on every message.
	// A NAME is public: somebody else's DNS decides where it goes.
	if (isLocalHost(host)) return false;
	return true; // a public name or a public IP → clearnet
}

/**
 * THE PROCESS'S CLEARNET POLICY, readable by any code that does not go through
 * the global dispatcher.
 *
 * The router below refuses public clearnet on a hidden-only node — but only for
 * requests that reach it. Anything that passes its OWN dispatcher to `fetch`
 * bypasses the router entirely, and `federationProbe.fetchJson` does exactly
 * that: it resolves the host with the system resolver and connects through an
 * IP-pinned agent (the DNS-rebinding defence). On a hidden-only node that was a
 * system DNS query plus a direct TCP connection from the node's own address to
 * every clearnet peer in the directory, on every probe scan — the one thing the
 * fail-closed router exists to prevent, and under a "Zero use of clearnet
 * internet" label. Demonstrated before this was written: with the router
 * installed in 'refuse' mode, a global `fetch` was refused and `fetchJson`
 * reached the listener.
 *
 * So the policy is state here, set by the install, and any path that carries
 * its own transport asks it first.
 */
let clearnetPolicy: 'allow' | 'refuse' = 'allow';

/** True when this process is hidden-only: a public clearnet origin must not be
 *  contacted by ANY path, including one with its own dispatcher. */
export function clearnetRefused(): boolean {
	return clearnetPolicy === 'refuse';
}

/** Thrown by a path that consulted {@link clearnetRefused} and declined. Named,
 *  so a caller can tell "our policy" from "the peer failed" — a hidden-only
 *  node must never record a peer as unreachable for a request it chose not to
 *  make. */
export class ClearnetRefusedError extends Error {
	constructor(origin: string) {
		super(
			`clearnet blocked (hidden-only, fail-closed): refusing to reach ${origin} over the open internet`
		);
		this.name = 'ClearnetRefusedError';
	}
}

/** Extract the origin string undici hands us (it may pass a string or URL). */
function originOf(opts: { origin?: string | URL | null }): string {
	const o = opts.origin;
	if (o === null || o === undefined) return '';
	return typeof o === 'string' ? o : o.href;
}

/** The three sub-dispatchers the router delegates to. `tor`/`i2p` are optional
 *  (a network whose proxy is unconfigured falls back to `direct`). */
export interface HiddenSubDispatchers {
	readonly direct: Dispatcher;
	readonly tor?: Dispatcher;
	readonly i2p?: Dispatcher;
}

/** Build the sub-dispatchers from proxy config: a plain Agent for clearnet, a
 *  SOCKS-connector Agent for Tor, a CONNECT-connector Agent for i2pd. Separated from the
 *  router so tests can inject mocks and assert routing without a network. */
export function buildHiddenSubDispatchers(config: HiddenServiceProxyConfig): HiddenSubDispatchers {
	const subs: { direct: Dispatcher; tor?: Dispatcher; i2p?: Dispatcher } = {
		// Clearnet: undici defaults — identical to no dispatcher at all.
		direct: new Agent()
	};
	if (config.torSocks.length > 0) {
		const { host, port } = parseHostPort(config.torSocks, 9050);
		// undici's connect typing doesn't model a custom SOCKS connector.
		subs.tor = new Agent({ connect: makeSocks5Connector(host, port) as never });
	}
	if (config.i2pHttpProxy.length > 0) {
		const { host, port } = parseHostPort(config.i2pHttpProxy, 4444);
		// The SAME connector the chat pool uses, not undici's ProxyAgent — so
		// that the probe and the sender agree about what a refused CONNECT is.
		// This module is the probe's copy of a decision the pool also makes, and
		// a decision with two homes is one that can disagree with itself: fixing
		// the pool alone would leave the probe still reading a router that
		// refuses CONNECT as every peer being unreachable.
		subs.i2p = new Agent({ connect: makeHttpConnectConnector(host, port) as never });
	}
	return subs;
}

/**
 * A composed undici Dispatcher that delegates each request to one of three
 * sub-dispatchers by origin. It owns no connection logic of its own — it is pure
 * routing over `Agent`s.
 */
export class HiddenServiceRoutingDispatcher extends Dispatcher {
	readonly #subs: HiddenSubDispatchers;
	readonly #clearnetPolicy: 'allow' | 'refuse';
	readonly #lokinet: boolean;

	constructor(
		subs: HiddenSubDispatchers,
		clearnetPolicy: 'allow' | 'refuse' = 'allow',
		/** Whether `.loki` may be dialled — see HiddenServiceProxyConfig.lokinet.
		 *  Defaults to true only so a caller that predates the flag keeps its
		 *  behaviour; installHiddenServiceDispatcher always passes the config's. */
		lokinet = true
	) {
		super();
		this.#subs = subs;
		this.#clearnetPolicy = clearnetPolicy;
		this.#lokinet = lokinet;
	}

	/** Error a request through the handler per undici's contract. */
	#refuse(handler: Dispatcher.DispatchHandler, err: Error): boolean {
		try {
			handler.onConnect?.(() => {});
		} catch {
			/* older handler shape without onConnect */
		}
		handler.onError?.(err);
		return false;
	}

	/** Route by origin. A hidden origin whose proxy was not configured is
	 *  REFUSED, never handed to the direct agent (v1.18.0 review, S11). The old
	 *  comment called that fallback safe because the name "fails to resolve";
	 *  the resolution attempt IS the leak — the `.onion` or `.i2p` name goes to
	 *  the system resolver, which is the ISP's. The same for `.loki` on a node
	 *  that does not run lokinet.
	 *  In `refuse` (hidden-only) mode a PUBLIC clearnet origin is FAIL-CLOSED:
	 *  the request is errored, never handed to the direct agent — so a
	 *  hidden-only node can never leak its IP even if some code path slips a
	 *  clearnet URL through. Local/loopback/`.loki` are unaffected. */
	override dispatch(
		opts: Dispatcher.DispatchOptions,
		handler: Dispatcher.DispatchHandler
	): boolean {
		const origin = originOf(opts);
		if (this.#clearnetPolicy === 'refuse' && isClearnetOrigin(origin)) {
			// Reject through the handler per undici's contract, never dispatch.
			return this.#refuse(handler, new ClearnetRefusedError(origin));
		}
		const route = hiddenRouteOf(origin);
		if (route === 'tor' || route === 'i2p') {
			const sub = route === 'tor' ? this.#subs.tor : this.#subs.i2p;
			if (sub === undefined) {
				return this.#refuse(
					handler,
					new ProxyUnavailableError(
						`no ${route === 'tor' ? 'Tor' : 'I2P'} proxy configured for ${origin}`
					)
				);
			}
			return sub.dispatch(opts, handler);
		}
		// A name that LOOKS hidden but did not classify — a short `.onion`, say
		// — would otherwise go to the direct agent and so to the system resolver.
		// Nothing can legitimately be reached that way; refuse without asking.
		if (hasHiddenSuffix(origin)) {
			return this.#refuse(
				handler,
				new Error(`not a valid hidden-service address; not resolving ${origin}`)
			);
		}
		if (!this.#lokinet && isLokiOrigin(origin)) {
			return this.#refuse(
				handler,
				new ProxyUnavailableError(`Lokinet is not enabled on this node; not resolving ${origin}`)
			);
		}
		return this.#subs.direct.dispatch(opts, handler);
	}

	/** Close all three sub-dispatchers. Named to avoid clashing with undici's
	 *  overloaded `close`/`destroy` signatures; called by the install handle. */
	async closeAll(): Promise<void> {
		await Promise.all(
			[this.#subs.direct, this.#subs.tor, this.#subs.i2p]
				.filter((d): d is Dispatcher => d !== undefined)
				.map((d) => d.close().catch(() => {}))
		);
	}
}

export interface HiddenDispatcherHandle {
	/** Restore the dispatcher that was global before install, and close ours. */
	uninstall(): Promise<void>;
}

/**
 * Install the routing dispatcher globally so dblurt's `fetch` reaches hidden
 * endpoints. Idempotent-ish: keeps a handle to the previous global dispatcher so
 * it can be restored (used by tests / clean shutdown). Every indexer and relay
 * installs it, whatever endpoints are configured — see `routerInstallPolicy`
 * and each app's main.ts.
 *
 * Logs nothing: this package has no logger. Each app logs the install in its
 * own format (the indexer's wrapper, the relay's main).
 */
export function installHiddenServiceDispatcher(
	config: HiddenServiceProxyConfig,
	policy: 'allow' | 'refuse' = 'allow'
): HiddenDispatcherHandle {
	const previous = getGlobalDispatcher();
	const previousPolicy = clearnetPolicy;
	const router = new HiddenServiceRoutingDispatcher(
		buildHiddenSubDispatchers(config),
		policy,
		lokinetEnabled(config)
	);
	setGlobalDispatcher(router);
	clearnetPolicy = policy;
	return {
		async uninstall(): Promise<void> {
			setGlobalDispatcher(previous);
			clearnetPolicy = previousPolicy;
			await router.closeAll().catch(() => {});
		}
	};
}

/**
 * The policy to INSTALL, given a process's configured one. Never "none".
 * (v1.18.0 deep-deep, L3) A process whose own endpoint lists name no hidden
 * service used to install no router — but the on-chain RPC directory merges
 * `.onion`/`.i2p` nodes into every pool, and without the router those names
 * went to the system resolver (the ISP's). With it, clearnet goes to a plain
 * Agent exactly as before (`allow`), and a hidden name goes to its proxy or is
 * refused before any lookup. PURE.
 */
export function routerInstallPolicy(configured: 'refuse' | 'allow' | null): 'refuse' | 'allow' {
	return configured ?? 'allow';
}
