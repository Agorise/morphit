/**
 * @morphit/hidden-transport — dependency-free hidden-network transport core.
 *
 * The SOCKS5 connector + wire helpers + network classifier + proxy config,
 * extracted so BOTH the indexer's hidden-service fetch and the ops-cli hidden
 * upgrade fetch use ONE copy (no drift on security-critical code). Pure
 * `node:net` + Buffers — NO external dependency — so it bundles into the
 * release tarball and installs/upgrades fully offline (USB-stick distribution).
 *
 * The undici `Agent`/`ProxyAgent` wrapping stays in each consumer (they already
 * carry undici); this package is intentionally undici-free so it stays maximally
 * portable and offline-safe.
 */
import net from 'node:net';

/** Per-connect handshake timeout. */
export const HIDDEN_HANDSHAKE_TIMEOUT_MS = 20_000;

export interface HiddenServiceProxyConfig {
	/** Tor SOCKS5 proxy `host:port` (for `.onion`). Empty disables onion. */
	readonly torSocks: string;
	/** i2pd HTTP proxy `host:port` (for `.i2p`/`.b32.i2p`). Empty disables I2P. */
	readonly i2pHttpProxy: string;
}

/** Read the proxy config from the environment (defaults match a standard
 *  co-located Tor + i2pd install; the same daemons the indexer uses). */
export function hiddenServiceProxyConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env
): HiddenServiceProxyConfig {
	return {
		torSocks: (env.MORPHIT_INDEXER_TOR_SOCKS ?? '127.0.0.1:9050').trim(),
		i2pHttpProxy: (env.MORPHIT_INDEXER_I2P_HTTP_PROXY ?? '127.0.0.1:4444').trim()
	};
}

// ─── which network a URL belongs to ──────────────────────────────

export type HiddenNetwork = 'tor' | 'i2p' | 'loki' | null;

/** Classify a URL's host into a hidden-service network, or null for clearnet. */
export function hiddenNetworkOf(url: string): HiddenNetwork {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
	if (/^[a-z2-7]{56}\.onion$/.test(host)) return 'tor';
	if (host.endsWith('.i2p')) return 'i2p';
	if (host.endsWith('.loki')) return 'loki';
	return null;
}

// ─── SOCKS5 wire helpers (pure — unit-tested without a socket) ────

/** SOCKS5 greeting: version 5, one method, "no authentication". */
export function socks5Greeting(): Buffer {
	return Buffer.from([0x05, 0x01, 0x00]);
}

/** Parse the server's greeting reply. Valid = `[0x05, 0x00]` (no-auth chosen). */
export function parseSocks5Greeting(reply: Buffer): { ok: boolean; error?: string } {
	if (reply.length < 2) return { ok: false, error: 'short greeting reply' };
	if (reply[0] !== 0x05) return { ok: false, error: `bad version 0x${reply[0]?.toString(16)}` };
	if (reply[1] !== 0x00) return { ok: false, error: 'proxy requires authentication' };
	return { ok: true };
}

/** SOCKS5 CONNECT request to `host:port` using ATYP=domain (Tor resolves the
 *  .onion itself — we never resolve it locally). */
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

/** Parse the CONNECT reply. rep byte 0x00 = success; anything else = the target
 *  (the .onion) is unreachable — NOT a proxy fault. */
export function parseSocks5ConnectReply(reply: Buffer): { ok: boolean; error?: string } {
	if (reply.length < 2) return { ok: false, error: 'short connect reply' };
	if (reply[0] !== 0x05) return { ok: false, error: `bad version 0x${reply[0]?.toString(16)}` };
	const rep = reply[1] ?? 0xff;
	if (rep === 0x00) return { ok: true };
	return { ok: false, error: SOCKS5_REPLY[rep] ?? `reply 0x${rep.toString(16)}` };
}

/** Marker on errors that mean the PROXY itself is unreachable (Tor down / wrong
 *  port) rather than the target onion — the scheduler uses this to avoid
 *  penalising a healthy peer for our own daemon being offline. */
export class ProxyUnavailableError extends Error {}

// ─── SOCKS5 undici connector ─────────────────────────────────────

export function parseHostPort(hp: string, fallbackPort: number): { host: string; port: number } {
	const i = hp.lastIndexOf(':');
	if (i === -1) return { host: hp, port: fallbackPort };
	return { host: hp.slice(0, i), port: Number(hp.slice(i + 1)) || fallbackPort };
}

/** Build an undici `connect` function that tunnels to the requested origin via a
 *  SOCKS5 proxy. undici calls this with the TARGET host/port (the onion); we
 *  hand back a socket already tunneled to it. Returned as a plain function so
 *  this module needs no undici dependency (the consumer casts it into
 *  `new Agent({ connect })`). */
export function makeSocks5Connector(socksHost: string, socksPort: number) {
	return (
		opts: { hostname: string; port: number | string },
		cb: (err: Error | null, socket: net.Socket | null) => void
	): void => {
		const targetHost = opts.hostname;
		const targetPort = typeof opts.port === 'string' ? Number(opts.port) || 80 : opts.port || 80;
		const sock = net.connect({ host: socksHost, port: socksPort });
		let stage: 'greet' | 'connect' = 'greet';
		let acc = Buffer.alloc(0);
		const fail = (err: Error): void => {
			sock.destroy();
			cb(err, null);
		};
		sock.once('error', (err) =>
			fail(new ProxyUnavailableError(`SOCKS proxy ${socksHost}:${socksPort} unreachable: ${err.message}`))
		);
		sock.setTimeout(HIDDEN_HANDSHAKE_TIMEOUT_MS, () => fail(new Error('SOCKS handshake timeout')));
		sock.once('connect', () => sock.write(socks5Greeting()));
		sock.on('data', (chunk: Buffer) => {
			acc = Buffer.concat([acc, chunk]);
			if (stage === 'greet') {
				if (acc.length < 2) return;
				const g = parseSocks5Greeting(acc);
				if (!g.ok) return fail(new ProxyUnavailableError(`SOCKS greeting: ${g.error}`));
				acc = Buffer.alloc(0);
				stage = 'connect';
				sock.write(socks5ConnectRequest(targetHost, targetPort));
				return;
			}
			// connect stage — reply is at least 10 bytes for an IPv4 BND.ADDR.
			if (acc.length < 10) return;
			const r = parseSocks5ConnectReply(acc);
			if (!r.ok) return fail(new Error(`onion unreachable via Tor: ${r.error}`));
			// Tunnel established. Detach our handlers and hand the raw socket to
			// undici for the HTTP exchange.
			sock.removeAllListeners('data');
			sock.removeAllListeners('timeout');
			sock.setTimeout(0);
			cb(null, sock);
		});
	};
}
