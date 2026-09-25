/**
 * scripts/canary/torSocksDispatcher.ts
 *
 * cp761 — tor-only privacy for the warrant-canary freshness proofs.
 *
 * WHY: on a tor-only node the canary's outbound freshness-proof fetches (Blurt
 * chain-head, Bitcoin head) went straight to clearnet endpoints, revealing the
 * node's real IP to those operators — the exact exposure tor-only exists to
 * avoid, and the same leak cp755 closed for the indexer's own chain reads. This
 * module lets those fetches reach the SAME clearnet sources THROUGH the node's
 * co-located Tor SOCKS5 proxy, so the IP is hidden behind a Tor exit while the
 * freshness-proof diversity (real RPC nodes, real explorers) is preserved.
 *
 * DESIGN: undici's global dispatcher fed by the SHARED SOCKS5 connector from
 * @morphit/hidden-transport — the one the indexer, relay and ops-cli use.
 * (v1.18.0 deep-deep, L1) This file used to carry its own copy "so the canary
 * would not reach into the indexer's internals"; the copy never received the
 * shared connector's fixes (S8 settle-once, S10 early close, X5 reply sized from
 * its address type and bytes after the reply kept), so a pooled tunnel's later
 * error could call undici's callback twice, a domain-typed reply left its tail in
 * front of the HTTP bytes, and a proxy hanging up mid-handshake waited out the
 * full 20 s. The shared package is a package, not indexer internals, and one
 * copy cannot drift. The wire helpers are re-exported for the routing smoke.
 *
 * FAIL-SAFE: when tor-only is on, EVERY fetch is pinned to the SOCKS proxy. If
 * the proxy is unreachable the fetch FAILS (the connector errors) — it never
 * silently falls back to a direct clearnet connection. The callers already
 * handle a failed proof: the Blurt head is fatal by design (a stale canary must
 * not publish), and the BTC head degrades to "unavailable". So a down Tor proxy
 * degrades or blocks the canary — it can never leak.
 *
 * NOTE (.i2p): a co-located Tor proxy is installed on tor-only nodes by default
 * (enable_tor defaults true), so routing over Tor SOCKS hides the IP on both
 * .onion and .b32.i2p origins. Reaching clearnet freshness sources over I2P
 * alone would need an outproxy and is out of scope; Tor is the universal path.
 */
import { Agent, setGlobalDispatcher } from 'undici';
import { makeSocks5Connector, parseHostPort } from '@morphit/hidden-transport';

export {
	socks5Greeting,
	parseSocks5Greeting,
	socks5ConnectRequest,
	parseSocks5ConnectReply,
	parseHostPort,
	makeSocks5Connector
} from '@morphit/hidden-transport';

/** True when the canary should route over Tor — set by generate.sh from the
 *  instance origin (.onion/.b32.i2p) or an explicit MORPHIT_CANARY_TOR_ONLY. */
export function canaryIsTorOnly(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.MORPHIT_CANARY_TOR_ONLY ?? '').trim() === '1';
}

/**
 * When tor-only, pin undici's GLOBAL dispatcher to the Tor SOCKS proxy so every
 * `fetch()` in this process tunnels through Tor (fail-closed: no clearnet
 * fallback). No-op on a clearnet node — the global dispatcher is left untouched,
 * so clearnet behavior is byte-identical. Returns a short status string for the
 * helper to log to stderr.
 */
export function installTorDispatcherIfTorOnly(env: NodeJS.ProcessEnv = process.env): string {
	if (!canaryIsTorOnly(env)) return 'clearnet (direct)';
	const socks = (env.MORPHIT_CANARY_TOR_SOCKS ?? '127.0.0.1:9050').trim();
	const { host, port } = parseHostPort(socks, 9050);
	setGlobalDispatcher(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici's
		// connect type doesn't model a custom SOCKS connector cleanly.
		new Agent({ connect: makeSocks5Connector(host, port) as any })
	);
	return `tor-only (SOCKS ${host}:${port})`;
}
