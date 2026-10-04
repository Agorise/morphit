/**
 * HTTP(S) agents that connect through a SOCKS5 proxy (Tor), handing the proxy
 * the host NAME (SOCKS5 address type "domain"), so nothing is resolved on this
 * machine — a .onion name is only meaningful to Tor, and a clearnet name looked
 * up locally would leak the lookup.
 *
 * Self-contained (node:net / node:tls only): the bot needs one proxy hop for
 * one homeserver, and a dependency for that would be more code to trust than
 * this.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';

export interface SocksProxy {
	readonly host: string;
	readonly port: number;
}

/** Parse `socks5h://host:port` (or `socks5://`, treated the same: the name is
 *  always sent to the proxy). Null for anything else. */
export function parseSocksProxy(raw: string | undefined): SocksProxy | null {
	if (raw === undefined || raw.trim() === '') return null;
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return null;
	}
	if (u.protocol !== 'socks5h:' && u.protocol !== 'socks5:') return null;
	const port = Number(u.port || '1080');
	if (!Number.isInteger(port) || port < 1 || port > 65535 || u.hostname === '') return null;
	return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
}

/** Loopback targets are reached directly, never through the proxy. */
export function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '');
	return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Open a TCP stream to host:port through the SOCKS5 proxy (no auth, CONNECT,
 *  address type domain). Resolves with the socket once the proxy has
 *  connected; the socket then carries the target's bytes. */
export function socksConnect(proxy: SocksProxy, host: string, port: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const name = Buffer.from(host, 'utf8');
		if (name.length === 0 || name.length > 255) {
			reject(new Error(`SOCKS5: host name length ${name.length} out of range`));
			return;
		}
		const sock = net.connect(proxy.port, proxy.host);
		let buf = Buffer.alloc(0);
		let stage: 'greeting' | 'connect' = 'greeting';
		const fail = (msg: string): void => {
			sock.destroy();
			reject(new Error(`SOCKS5 proxy ${proxy.host}:${proxy.port}: ${msg}`));
		};
		sock.on('error', (err) => fail(err.message));
		sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
		const onData = (chunk: Buffer): void => {
			buf = Buffer.concat([buf, chunk]);
			if (stage === 'greeting') {
				if (buf.length < 2) return;
				if (buf[0] !== 5 || buf[1] !== 0) return fail('refused the no-auth greeting');
				buf = buf.subarray(2);
				stage = 'connect';
				const req = Buffer.alloc(7 + name.length);
				req.set([5, 1, 0, 3, name.length], 0);
				name.copy(req, 5);
				req.writeUInt16BE(port, 5 + name.length);
				sock.write(req);
			}
			if (stage === 'connect') {
				if (buf.length < 5) return;
				if (buf[0] !== 5) return fail('bad reply');
				if (buf[1] !== 0) return fail(`CONNECT to ${host}:${port} failed (code ${buf[1]})`);
				const atyp = buf[3];
				const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buf[4]! : -1;
				if (addrLen < 0) return fail('bad reply address type');
				const total = 4 + addrLen + 2;
				if (buf.length < total) return;
				sock.off('data', onData);
				sock.removeAllListeners('error');
				const rest = buf.subarray(total);
				if (rest.length > 0) sock.unshift(rest);
				resolve(sock);
			}
		};
		sock.on('data', onData);
	});
}

type ConnectCallback = (err: Error | null, stream: Duplex) => void;

/** http.Agent whose connections go through the proxy (loopback: direct). */
export class SocksHttpAgent extends http.Agent {
	constructor(private readonly proxy: SocksProxy) {
		super({ keepAlive: true });
	}
	override createConnection(
		options: http.ClientRequestArgs,
		callback?: ConnectCallback
	): undefined {
		const cb = callback ?? (() => undefined);
		const host = String(options.hostname ?? options.host ?? '');
		const port = Number(options.port ?? 80);
		if (isLoopbackHost(host)) {
			const s = net.connect(port, host);
			s.once('connect', () => cb(null, s));
			s.once('error', (e) => cb(e, s));
			return undefined;
		}
		socksConnect(this.proxy, host, port).then(
			(s) => cb(null, s),
			(e: Error) => cb(e, new net.Socket())
		);
		return undefined;
	}
}

/** https.Agent whose connections go through the proxy, TLS on top (loopback: direct). */
export class SocksHttpsAgent extends https.Agent {
	constructor(private readonly proxy: SocksProxy) {
		super({ keepAlive: true });
	}
	override createConnection(options: https.RequestOptions, callback?: ConnectCallback): undefined {
		const cb = callback ?? (() => undefined);
		const host = String(options.hostname ?? options.host ?? '');
		const port = Number(options.port ?? 443);
		const wrap = (raw: net.Socket): void => {
			const t = tls.connect({
				...(options as tls.ConnectionOptions),
				socket: raw,
				servername: options.servername ?? host
			});
			t.once('secureConnect', () => cb(null, t));
			t.once('error', (e) => cb(e, t));
		};
		if (isLoopbackHost(host)) {
			const s = net.connect(port, host);
			s.once('connect', () => wrap(s));
			s.once('error', (e) => cb(e, s));
			return undefined;
		}
		socksConnect(this.proxy, host, port).then(wrap, (e: Error) => cb(e, new net.Socket()));
		return undefined;
	}
}
