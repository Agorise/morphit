/**
 * scripts/canary/torSocksDispatcher.ts
 *
 * tor-only privacy for the warrant-canary freshness proofs.
 *
 * WHY: on a tor-only node the canary's outbound freshness-proof fetches (Blurt
 * chain-head, Bitcoin head) went straight to clearnet endpoints, revealing the
 * node's real IP to those operators — the exact exposure tor-only exists to
 * avoid, and the same leak a later change closed for the indexer's own chain reads. This
 * module lets those fetches reach the SAME clearnet sources THROUGH the node's
 * co-located Tor SOCKS5 proxy, so the IP is hidden behind a Tor exit while the
 * freshness-proof diversity (real RPC nodes, real explorers) is preserved.
 *
 * DESIGN: undici's global dispatcher fed by the SHARED SOCKS5 connector from
 * @morphit/hidden-transport — the one the indexer, relay and ops-cli use.
 * This file used to carry its own copy "so the canary
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
import tls from 'node:tls';
import { isIP } from 'node:net';
import type net from 'node:net';
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
		new Agent({ connect: makeCanaryTorConnector(host, port) as any })
	);
	return `tor-only (SOCKS ${host}:${port})`;
}

type ConnectOpts = {
	hostname: string;
	port: number | string;
	protocol?: string;
	servername?: string;
};
type ConnectCb = (err: Error | null, socket: net.Socket | null) => void;

/** How long a TLS handshake inside the Tor tunnel may take. undici gives a
 *  custom connector no timeout of its own, and aborting a fetch does not stop
 *  a connect already under way: without this, one Tor exit that took the
 *  connection and never answered kept the helper process alive after the next
 *  explorer had already answered (generate.sh waits for it, with no limit). */
export const CANARY_TLS_HANDSHAKE_MS = 20_000;

/**
 * The canary's connector: the shared SOCKS5 tunnel, plus TLS for https://
 * CLEARNET hosts reached through a Tor exit.
 *
 * The shared connector refuses https: on purpose — it is built for .onion and
 * .b32.i2p, which carry plain HTTP — and the canary used it unchanged for its
 * https:// Bitcoin explorers, so on a Tor-only box every explorer "fetch
 * failed" at once and the canary never carried a Bitcoin block height
 * (morphitlat, 2026-10-07). For an https:// clearnet host the tunnel is opened
 * to its port (443 by default), and TLS runs inside it with the certificate
 * checked against the host name, as for a direct connection. The name is still
 * resolved by Tor (the CONNECT carries the domain). A hidden-network https://
 * URL is still refused by the shared connector.
 */
export function makeCanaryTorConnector(
	socksHost: string,
	socksPort: number,
	handshakeMs: number = CANARY_TLS_HANDSHAKE_MS
) {
	const tunnel = makeSocks5Connector(socksHost, socksPort);
	return (opts: ConnectOpts, cb: ConnectCb): void => {
		const hidden = /\.(onion|i2p)\.?$/i.test(opts.hostname);
		if (opts.protocol !== 'https:' || hidden) {
			tunnel(opts, cb);
			return;
		}
		const port = typeof opts.port === 'string' ? Number(opts.port) || 443 : opts.port || 443;
		const name = opts.hostname.replace(/\.$/, '');
		tunnel({ hostname: opts.hostname, port, protocol: 'http:' }, (err, raw) => {
			if (err !== null || raw === null) {
				// The shared connector words its failures for onions; this is a
				// clearnet host reached through a Tor exit.
				const why = err?.message.replace(/^onion unreachable via Tor: /, '') ?? 'no tunnel';
				cb(new Error(`${name} unreachable through Tor: ${why}`, { cause: err ?? undefined }), null);
				return;
			}
			let settled = false;
			const secure = tls.connect({
				socket: raw,
				// The certificate is checked against this name. SNI carries it
				// too, except for an IP literal (SNI must not be an address).
				host: name,
				...(isIP(name) === 0 ? { servername: opts.servername || name } : {}),
				ALPNProtocols: ['http/1.1']
			});
			const fail = (e: Error): void => {
				if (settled) return;
				settled = true;
				secure.destroy();
				raw.destroy();
				cb(e, null);
			};
			secure.setTimeout(handshakeMs, () =>
				fail(
					new Error(`${name}: no TLS answer through Tor within ${Math.round(handshakeMs / 1000)} s`)
				)
			);
			secure.once('secureConnect', () => {
				if (settled) return;
				settled = true;
				secure.setTimeout(0);
				cb(null, secure);
			});
			secure.once('error', fail);
		});
	};
}
