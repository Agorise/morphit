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
 * DESIGN: a small, dependency-free SOCKS5 connector over `node:net` feeding
 * undici's global dispatcher — the same technique the indexer uses in
 * apps/indexer/src/indexer/hiddenServiceFetch.ts, kept SELF-CONTAINED here so
 * the operator-auditable canary scripts don't reach into the indexer's
 * internals. The wire helpers are pure (unit-tested without a socket).
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
import net from 'node:net';
import { Agent, setGlobalDispatcher } from 'undici';

const HANDSHAKE_TIMEOUT_MS = 20_000;

/** SOCKS5 greeting: version 5, one method, "no authentication". */
export function socks5Greeting(): Buffer {
	return Buffer.from([0x05, 0x01, 0x00]);
}

/** Parse the greeting reply. Valid = `[0x05, 0x00]` (no-auth chosen). */
export function parseSocks5Greeting(reply: Buffer): { ok: boolean; error?: string } {
	if (reply.length < 2) return { ok: false, error: 'short greeting reply' };
	if (reply[0] !== 0x05) return { ok: false, error: `bad version 0x${reply[0]?.toString(16)}` };
	if (reply[1] !== 0x00) return { ok: false, error: 'proxy requires authentication' };
	return { ok: true };
}

/** SOCKS5 CONNECT with ATYP=domain — the proxy resolves the host, so DNS never
 *  leaks off the box (the `socks5h` semantics; a local resolve would defeat the
 *  whole point on a tor-only node). */
export function socks5ConnectRequest(host: string, port: number): Buffer {
	const h = Buffer.from(host, 'ascii');
	if (h.length > 255) throw new Error('socks5: hostname too long');
	const buf = Buffer.alloc(4 + 1 + h.length + 2);
	buf[0] = 0x05; // version
	buf[1] = 0x01; // CONNECT
	buf[2] = 0x00; // reserved
	buf[3] = 0x03; // ATYP = domain name
	buf[4] = h.length;
	h.copy(buf, 5);
	buf.writeUInt16BE(port, 5 + h.length);
	return buf;
}

const SOCKS5_REPLY: Record<number, string> = {
	0x00: 'succeeded',
	0x01: 'general failure',
	0x02: 'connection not allowed',
	0x03: 'network unreachable',
	0x04: 'host unreachable',
	0x05: 'connection refused',
	0x06: 'ttl expired',
	0x07: 'command not supported',
	0x08: 'address type not supported'
};

/** Parse the CONNECT reply. rep byte 0x00 = success. */
export function parseSocks5ConnectReply(reply: Buffer): { ok: boolean; error?: string } {
	if (reply.length < 2) return { ok: false, error: 'short connect reply' };
	if (reply[0] !== 0x05) return { ok: false, error: `bad version 0x${reply[0]?.toString(16)}` };
	const rep = reply[1] ?? 0xff;
	if (rep === 0x00) return { ok: true };
	return { ok: false, error: SOCKS5_REPLY[rep] ?? `reply 0x${rep.toString(16)}` };
}

export function parseHostPort(hp: string, fallbackPort: number): { host: string; port: number } {
	const i = hp.lastIndexOf(':');
	if (i === -1) return { host: hp, port: fallbackPort };
	return { host: hp.slice(0, i), port: Number(hp.slice(i + 1)) || fallbackPort };
}

/** Build an undici `connect` function that tunnels the target origin through a
 *  SOCKS5 proxy. undici then drives HTTP/TLS over the returned raw socket. */
export function makeSocks5Connector(socksHost: string, socksPort: number) {
	return (
		opts: { hostname: string; port: number | string },
		cb: (err: Error | null, socket: net.Socket | null) => void
	): void => {
		const targetHost = opts.hostname;
		const targetPort = typeof opts.port === 'string' ? Number(opts.port) || 443 : opts.port || 443;
		const sock = net.connect({ host: socksHost, port: socksPort });
		let stage: 'greet' | 'connect' = 'greet';
		let acc = Buffer.alloc(0);
		const fail = (err: Error): void => {
			sock.destroy();
			cb(err, null);
		};
		sock.once('error', (err) =>
			fail(new Error(`canary: Tor SOCKS proxy ${socksHost}:${socksPort} unreachable: ${err.message}`))
		);
		sock.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail(new Error('canary: SOCKS handshake timeout')));
		sock.once('connect', () => sock.write(socks5Greeting()));
		sock.on('data', (chunk: Buffer) => {
			acc = Buffer.concat([acc, chunk]);
			if (stage === 'greet') {
				if (acc.length < 2) return;
				const g = parseSocks5Greeting(acc);
				if (!g.ok) return fail(new Error(`canary: SOCKS greeting: ${g.error}`));
				acc = Buffer.alloc(0);
				stage = 'connect';
				sock.write(socks5ConnectRequest(targetHost, targetPort));
				return;
			}
			if (acc.length < 10) return; // CONNECT reply ≥ 10 bytes (IPv4 BND.ADDR)
			const r = parseSocks5ConnectReply(acc);
			if (!r.ok) return fail(new Error(`canary: target unreachable via Tor: ${r.error}`));
			sock.removeAllListeners('data');
			sock.removeAllListeners('timeout');
			sock.setTimeout(0);
			cb(null, sock);
		});
	};
}

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
