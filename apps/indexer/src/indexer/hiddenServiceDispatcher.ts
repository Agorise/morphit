/**
 * Morphit indexer — global per-host hidden-service routing dispatcher.
 *
 * WHY THIS EXISTS
 * The chain RPC client is `@beblurt/dblurt`, whose `Client` makes calls with the
 * GLOBAL `fetch` (undici) and exposes no per-request dispatcher hook. So to let
 * the RPC pool include hidden-service endpoints (.onion / .b32.i2p) we install a
 * global undici dispatcher that routes PER ORIGIN:
 *
 *   - `.onion`  → the Tor SOCKS5 proxy (via `makeSocks5Connector`)
 *   - `.b32.i2p`/`.i2p` → the i2pd HTTP proxy (`ProxyAgent`)
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
 *     silently downgraded onto the clear net: if the proxy for its network is
 *     unconfigured we still hand it to the (plain) direct agent, where a `.onion`
 *     host simply fails DNS resolution — it cannot leak, because there is no real
 *     host to leak to.
 *  5. GATED INSTALL. `main.ts` installs this ONLY when hidden RPC endpoints are
 *     actually configured. A clearnet-only node never sets a global dispatcher,
 *     so its behaviour is exactly as before.
 */

import { Agent, ProxyAgent, Dispatcher, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import {
	hiddenNetworkOf,
	makeSocks5Connector,
	parseHostPort,
	type HiddenServiceProxyConfig
} from './hiddenServiceFetch';
import { logger } from '$log';

const log = logger('hidden-dispatcher');

export type HiddenRoute = 'tor' | 'i2p' | 'direct';

/** Which transport an origin must use. PURE + total — the security-critical
 *  routing decision, exhaustively unit-tested. `.loki` and clearnet both go
 *  `direct` (lokinet resolves `.loki` on its tun; clearnet is normal). */
export function hiddenRouteOf(origin: string): HiddenRoute {
	const net = hiddenNetworkOf(origin);
	return net === 'tor' ? 'tor' : net === 'i2p' ? 'i2p' : 'direct';
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
 *  SOCKS-connector Agent for Tor, an HTTP ProxyAgent for i2pd. Separated from the
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
		subs.i2p = new ProxyAgent(`http://${host}:${port}`);
	}
	return subs;
}

/**
 * A composed undici Dispatcher that delegates each request to one of three
 * sub-dispatchers by origin. It owns no connection logic of its own — it is pure
 * routing over `Agent`/`ProxyAgent`.
 */
export class HiddenServiceRoutingDispatcher extends Dispatcher {
	readonly #subs: HiddenSubDispatchers;

	constructor(subs: HiddenSubDispatchers) {
		super();
		this.#subs = subs;
	}

	/** Route by origin. Falls back to the direct agent when a hidden network's
	 *  proxy wasn't configured — where a `.onion`/`.i2p` host fails to resolve
	 *  (safe: nothing to leak to), rather than silently proxying it wrong. */
	override dispatch(
		opts: Dispatcher.DispatchOptions,
		handler: Dispatcher.DispatchHandler
	): boolean {
		const route = hiddenRouteOf(originOf(opts));
		const sub =
			route === 'tor'
				? (this.#subs.tor ?? this.#subs.direct)
				: route === 'i2p'
					? (this.#subs.i2p ?? this.#subs.direct)
					: this.#subs.direct;
		return sub.dispatch(opts, handler);
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
 * it can be restored (used by tests / clean shutdown). Call ONLY when hidden RPC
 * endpoints are configured — see the gating in main.ts.
 */
export function installHiddenServiceDispatcher(
	config: HiddenServiceProxyConfig
): HiddenDispatcherHandle {
	const previous = getGlobalDispatcher();
	const router = new HiddenServiceRoutingDispatcher(buildHiddenSubDispatchers(config));
	setGlobalDispatcher(router);
	log.info('hidden_dispatcher_installed', {
		tor: config.torSocks.length > 0 ? config.torSocks : '(disabled)',
		i2p: config.i2pHttpProxy.length > 0 ? config.i2pHttpProxy : '(disabled)',
		note: 'clearnet unchanged; .onion→Tor, .b32.i2p→i2pd'
	});
	return {
		async uninstall(): Promise<void> {
			setGlobalDispatcher(previous);
			await router.closeAll().catch(() => {});
		}
	};
}
