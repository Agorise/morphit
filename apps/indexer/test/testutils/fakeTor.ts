/**
 * A stand-in for Tor's SOCKS port, for tests that must see what the indexer
 * really sends to an onion service.
 *
 * - Speaks SOCKS5 with "no authentication" and with username/password
 *   (RFC 1929), the way Tor's SocksPort does; every stream's credentials are
 *   recorded, so a test can tell isolated streams (fresh credentials each) from
 *   pooled ones.
 * - CONNECT by name only. A name in `routes` is served by the matching local
 *   HTTP handler; any other name — every clearnet name included — is answered
 *   "host unreachable" and recorded, so a test can assert none was asked for.
 * - Nothing here resolves a name: the test sees the name exactly as the
 *   indexer handed it to the proxy.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

export type FakeOnionHandler = (
	req: http.IncomingMessage,
	res: http.ServerResponse,
	body: string
) => void | Promise<void>;

export interface FakeTorStream {
	/** Username offered (null = no-auth stream). */
	readonly user: string | null;
	readonly host: string;
	readonly port: number;
	/** True when the name was routed to a handler. */
	readonly routed: boolean;
}

export interface FakeTor {
	/** `127.0.0.1:<port>` — the value for MORPHIT_INDEXER_TOR_SOCKS. */
	readonly socks: string;
	readonly streams: FakeTorStream[];
	/** Replace (or add) the handler for one onion host. */
	route(host: string, handler: FakeOnionHandler): void;
	/** Drop every handler (the host then answers "unreachable"). */
	unroute(host: string): void;
	close(): Promise<void>;
}

export async function startFakeTor(
	routes: Record<string, FakeOnionHandler> = {}
): Promise<FakeTor> {
	const table = new Map<string, FakeOnionHandler>(Object.entries(routes));
	const streams: FakeTorStream[] = [];
	const web = http.createServer((req, res) => {
		let body = '';
		req.setEncoding('utf8');
		req.on('data', (d: string) => (body += d));
		req.on('end', () => {
			const host = String(req.headers.host ?? '')
				.replace(/:\d+$/, '')
				.toLowerCase();
			const h = table.get(host);
			if (h === undefined) {
				res.writeHead(502).end();
				return;
			}
			Promise.resolve(h(req, res, body)).catch(() => {
				if (!res.headersSent) res.writeHead(500);
				res.end();
			});
		});
	});
	await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
	const webPort = (web.address() as AddressInfo).port;

	const sockets = new Set<net.Socket>();
	const socks = net.createServer((c) => {
		sockets.add(c);
		c.on('close', () => sockets.delete(c));
		let buf = Buffer.alloc(0);
		let stage: 'greet' | 'auth' | 'connect' | 'done' = 'greet';
		let user: string | null = null;
		c.on('error', () => undefined);
		c.on('data', (d: Buffer) => {
			buf = Buffer.concat([buf, d]);
			if (stage === 'greet') {
				if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
				const methods = [...buf.subarray(2, 2 + buf[1]!)];
				buf = buf.subarray(2 + buf[1]!);
				if (methods.includes(0x02)) {
					c.write(Buffer.from([0x05, 0x02]));
					stage = 'auth';
				} else if (methods.includes(0x00)) {
					c.write(Buffer.from([0x05, 0x00]));
					stage = 'connect';
				} else {
					c.end(Buffer.from([0x05, 0xff]));
					stage = 'done';
					return;
				}
			}
			if (stage === 'auth') {
				if (buf.length < 2) return;
				const ulen = buf[1]!;
				if (buf.length < 3 + ulen) return;
				const plen = buf[2 + ulen]!;
				if (buf.length < 3 + ulen + plen) return;
				user = buf.subarray(2, 2 + ulen).toString();
				buf = buf.subarray(3 + ulen + plen);
				c.write(Buffer.from([0x01, 0x00]));
				stage = 'connect';
			}
			if (stage === 'connect') {
				if (buf.length < 5) return;
				if (buf[3] !== 0x03) {
					// Only names: an address here would mean the client resolved it.
					streams.push({ user, host: `atyp:${buf[3]}`, port: 0, routed: false });
					c.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					stage = 'done';
					return;
				}
				const hlen = buf[4]!;
				if (buf.length < 7 + hlen) return;
				const host = buf
					.subarray(5, 5 + hlen)
					.toString()
					.toLowerCase();
				const port = buf.readUInt16BE(5 + hlen);
				const rest = buf.subarray(7 + hlen);
				stage = 'done';
				c.removeAllListeners('data');
				const routed = table.has(host);
				streams.push({ user, host, port, routed });
				if (!routed) {
					c.end(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					return;
				}
				const up = net.connect(webPort, '127.0.0.1', () => {
					c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
					if (rest.length > 0) up.write(rest);
					c.pipe(up).pipe(c);
				});
				up.on('error', () => c.destroy());
				c.on('close', () => up.destroy());
			}
		});
	});
	await new Promise<void>((r) => socks.listen(0, '127.0.0.1', r));
	const socksPort = (socks.address() as AddressInfo).port;

	return {
		socks: `127.0.0.1:${socksPort}`,
		streams,
		route(host, handler) {
			table.set(host.toLowerCase(), handler);
		},
		unroute(host) {
			table.delete(host.toLowerCase());
		},
		async close() {
			for (const s of sockets) s.destroy();
			web.closeAllConnections?.();
			await new Promise<void>((r) => socks.close(() => r()));
			await new Promise<void>((r) => web.close(() => r()));
		}
	};
}

/** JSON answer helper. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

/**
 * Records every DNS question this process asks while installed: `dns.lookup`
 * (what `net.connect` uses for a name) and the resolver calls. Each question
 * is ANSWERED WITH AN ERROR, so a test can never reach the network by accident.
 */
export async function trapDns(): Promise<{ names: string[]; restore(): void }> {
	const dns = (await import('node:dns')).default;
	const names: string[] = [];
	const saved = {
		lookup: dns.lookup,
		resolve: dns.resolve,
		resolve4: dns.resolve4,
		resolve6: dns.resolve6,
		pLookup: dns.promises.lookup
	};
	const refuse = (name: unknown): Error => {
		names.push(String(name));
		const e = new Error(`DNS trapped in test: ${String(name)}`) as NodeJS.ErrnoException;
		e.code = 'ENOTFOUND';
		return e;
	};
	const cbStyle = (name: unknown, ...rest: unknown[]): void => {
		const cb = rest[rest.length - 1];
		const err = refuse(name);
		if (typeof cb === 'function') process.nextTick(() => (cb as (e: Error) => void)(err));
	};
	(dns as unknown as Record<string, unknown>).lookup = cbStyle;
	(dns as unknown as Record<string, unknown>).resolve = cbStyle;
	(dns as unknown as Record<string, unknown>).resolve4 = cbStyle;
	(dns as unknown as Record<string, unknown>).resolve6 = cbStyle;
	(dns.promises as unknown as Record<string, unknown>).lookup = async (name: unknown) => {
		throw refuse(name);
	};
	return {
		names,
		restore() {
			(dns as unknown as Record<string, unknown>).lookup = saved.lookup;
			(dns as unknown as Record<string, unknown>).resolve = saved.resolve;
			(dns as unknown as Record<string, unknown>).resolve4 = saved.resolve4;
			(dns as unknown as Record<string, unknown>).resolve6 = saved.resolve6;
			(dns.promises as unknown as Record<string, unknown>).lookup = saved.pLookup;
		}
	};
}
