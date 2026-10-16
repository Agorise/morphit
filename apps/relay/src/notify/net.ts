/**
 * Offline notices — how the relay reaches a mail, Matrix, XMPP, Telegram or
 * Session server.
 *
 * Three rules, decided here and nowhere else:
 *   1. A `.onion` server is reached through this box's Tor (SOCKS5, the name
 *      handed to Tor, never resolved here).
 *   2. A zero-clearnet (hidden-only) relay reaches NOTHING else: every other
 *      host is refused before a connection or a DNS lookup is made.
 *   3. A caller may ask for Tor for a clearnet host too (`viaTor`) — Session
 *      always does, so the Session nodes that store her notice never see which
 *      instance sent it.
 *
 * HTTP is spoken by node:http over the socket opened here (TLS added here when
 * the URL is https), so one code path covers direct, Tor and pinned-TLS
 * connections. Responses are capped in size and time: every request has one
 * deadline for all of it (connect, TLS, headers, body) — a server that sends
 * a byte now and then cannot keep it open — and a cap on headers and body.
 */

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import {
	socks5ConnectRequest,
	socks5Greeting,
	parseSocks5ConnectReply,
	parseHostPort
} from '@morphit/hidden-transport';

export interface NetPolicy {
	/** This box's Tor SOCKS proxy `host:port`; '' when it runs none. */
	readonly torSocks: string;
	/** Zero-clearnet relay: only .onion servers may be contacted. */
	readonly hiddenOnly: boolean;
}

export class NetRefusedError extends Error {
	constructor(why: string) {
		super(why);
		this.name = 'NetRefusedError';
	}
}

export function isOnionHost(host: string): boolean {
	return /\.onion\.?$/i.test(host);
}

/** May this host be contacted at all, and how? PURE. */
export function routeFor(host: string, policy: NetPolicy, wantTor: boolean): 'tor' | 'direct' {
	if (isOnionHost(host)) {
		if (policy.torSocks === '')
			throw new NetRefusedError('this server runs no Tor, so a .onion server cannot be reached');
		return 'tor';
	}
	if (policy.hiddenOnly) {
		throw new NetRefusedError('this site is zero-clearnet: only .onion servers can be contacted');
	}
	if (wantTor) {
		if (policy.torSocks === '') throw new NetRefusedError('this server runs no Tor');
		return 'tor';
	}
	return 'direct';
}

/** A host and port a connection may be asked for: a name SOCKS can carry
 *  (1–255 bytes, no control characters) and a real port. A Session node's
 *  address comes from a server's answer, so it is checked like any input. */
export function checkTarget(host: string, port: number): void {
	const n = Buffer.byteLength(host, 'utf8');
	if (n < 1 || n > 255 || /[\u0000-\u0020\u007f]/.test(host))
		throw new NetRefusedError('not a server name');
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NetRefusedError('not a port');
}

function socksConnect(
	socks: string,
	host: string,
	port: number,
	timeoutMs: number
): Promise<net.Socket> {
	const { host: sh, port: sp } = parseHostPort(socks, 9050);
	return new Promise((resolve, reject) => {
		const sock = net.connect({ host: sh, port: sp });
		let stage: 'greet' | 'connect' = 'greet';
		let acc = Buffer.alloc(0);
		let done = false;
		const fail = (err: Error): void => {
			if (done) return;
			done = true;
			sock.destroy();
			reject(err);
		};
		sock.setTimeout(timeoutMs, () => fail(new Error('Tor did not connect in time')));
		sock.once('error', (e) => fail(new Error(`Tor SOCKS ${socks}: ${e.message}`)));
		sock.once('close', () => fail(new Error('Tor closed the connection')));
		sock.once('connect', () => sock.write(socks5Greeting()));
		// Whatever goes wrong in here fails this connection — never the relay
		// (a throw in a socket listener would be an uncaught exception).
		sock.on('data', (chunk: Buffer) => {
			try {
				onData(chunk);
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		});
		const onData = (chunk: Buffer): void => {
			if (done) return;
			acc = Buffer.concat([acc, chunk]);
			if (acc.length > 600) return fail(new Error('Tor SOCKS: bad reply'));
			if (stage === 'greet') {
				if (acc.length < 2) return;
				if (acc[0] !== 0x05 || acc[1] !== 0x00)
					return fail(new Error('Tor SOCKS refused the greeting'));
				acc = acc.subarray(2);
				stage = 'connect';
				sock.write(socks5ConnectRequest(host, port));
			}
			if (acc.length < 5) return;
			if (acc[1] !== 0x00) {
				const r = parseSocks5ConnectReply(acc);
				return fail(new Error(`Tor could not reach the server: ${r.error ?? 'refused'}`));
			}
			const atyp = acc[3];
			const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 7 + (acc[4] ?? 0) : -1;
			if (need < 0) return fail(new Error('Tor SOCKS: bad reply'));
			if (acc.length < need) return;
			done = true;
			sock.removeAllListeners('data');
			sock.removeAllListeners('close');
			sock.removeAllListeners('error');
			sock.setTimeout(0);
			const rest = acc.subarray(need);
			if (rest.length > 0) sock.unshift(rest);
			resolve(sock);
		};
	});
}

function directConnect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const sock = net.connect({ host, port });
		const t = setTimeout(() => {
			sock.destroy();
			reject(new Error('connection timed out'));
		}, timeoutMs);
		sock.once('connect', () => {
			clearTimeout(t);
			resolve(sock);
		});
		sock.once('error', (e) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

/** A TCP connection to host:port by the route {@link routeFor} decides. */
export async function openSocket(
	host: string,
	port: number,
	policy: NetPolicy,
	opts: { viaTor?: boolean; timeoutMs?: number } = {}
): Promise<net.Socket> {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	checkTarget(host, port);
	const route = routeFor(host, policy, opts.viaTor === true);
	return route === 'tor'
		? socksConnect(policy.torSocks, host, port, timeoutMs)
		: directConnect(host, port, timeoutMs);
}

export interface TlsOptions {
	/** Verify the server's certificate (the default). Session's storage nodes
	 *  use self-signed certificates and are reached with this off, as every
	 *  Session client does; the message itself is end-to-end encrypted. */
	readonly rejectUnauthorized?: boolean;
	/** Trust exactly this certificate (pinning), instead of the system's. */
	readonly ca?: string;
}

/** Start TLS on an open socket. */
export function startTls(
	socket: net.Socket,
	servername: string,
	opts: TlsOptions = {},
	timeoutMs = 30_000
): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const s = tls.connect({
			socket,
			// An IP literal is not a valid SNI name.
			servername: net.isIP(servername) ? undefined : servername,
			rejectUnauthorized: opts.rejectUnauthorized ?? true,
			...(opts.ca !== undefined ? { ca: opts.ca } : {})
		});
		const t = setTimeout(() => {
			s.destroy();
			reject(new Error('TLS handshake timed out'));
		}, timeoutMs);
		s.once('secureConnect', () => {
			clearTimeout(t);
			resolve(s);
		});
		s.once('error', (e) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

export interface HttpResult {
	readonly status: number;
	readonly body: string;
}

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024;

/** One HTTP(S) request over a connection opened by {@link openSocket}. */
export async function httpRequest(
	url: string,
	policy: NetPolicy,
	opts: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		viaTor?: boolean;
		tls?: TlsOptions;
		timeoutMs?: number;
	} = {}
): Promise<HttpResult> {
	const u = new URL(url);
	if (u.protocol !== 'https:' && u.protocol !== 'http:')
		throw new NetRefusedError(`unsupported URL ${u.protocol}`);
	const host = u.hostname.replace(/^\[|\]$/g, '');
	const https = u.protocol === 'https:';
	const port = u.port !== '' ? Number(u.port) : https ? 443 : 80;
	const timeoutMs = opts.timeoutMs ?? 30_000;
	// Plain http only to an .onion (Tor encrypts and authenticates it) or this box.
	if (!https && !isOnionHost(host) && host !== '127.0.0.1' && host !== 'localhost') {
		throw new NetRefusedError('refusing plain http to a clearnet server');
	}
	const deadline = Date.now() + timeoutMs;
	const left = (): number => Math.max(1, deadline - Date.now());
	const raw = await openSocket(host, port, policy, { viaTor: opts.viaTor, timeoutMs });
	let sock: net.Socket;
	try {
		sock = https ? await startTls(raw, host, opts.tls, left()) : raw;
	} catch (err) {
		raw.destroy();
		throw err;
	}
	const body = opts.body !== undefined ? Buffer.from(opts.body, 'utf8') : undefined;
	return new Promise<HttpResult>((resolve, reject) => {
		let settled = false;
		const finish = (err: Error | null, r?: HttpResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(stop);
			if (err) {
				sock.destroy();
				reject(err);
			} else resolve(r!);
		};
		// One deadline for the whole answer: an idle timer alone is reset by
		// every byte, so a server sending one now and then would hold it open.
		const stop = setTimeout(() => {
			req.destroy();
			finish(new Error('request timed out'));
		}, left());
		const req = http.request(
			{
				host,
				port,
				maxHeaderSize: MAX_HEADER_BYTES,
				method: opts.method ?? 'GET',
				path: `${u.pathname}${u.search}`,
				headers: {
					Host: u.host,
					Connection: 'close',
					...(body !== undefined ? { 'Content-Length': String(body.length) } : {}),
					...(opts.headers ?? {})
				},
				createConnection: () => sock
			},
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on('data', (c: Buffer) => {
					size += c.length;
					if (size > MAX_BODY_BYTES) {
						req.destroy(new Error('response too large'));
						return;
					}
					chunks.push(c);
				});
				res.on('end', () =>
					finish(null, {
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString('utf8')
					})
				);
				res.on('error', (e) => finish(e));
			}
		);
		req.on('error', (e) => finish(e));
		if (body !== undefined) req.write(body);
		req.end();
	});
}
