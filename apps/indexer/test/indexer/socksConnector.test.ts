/**
 * v1.18.0 review — the hand-written SOCKS5 connector, driven over real sockets.
 *
 * S8: it had no "settled" guard and its 'error' listener outlived the handshake,
 *     so an error on an idle POOLED tunnel called undici's connect callback a
 *     second time, long after undici had been handed the socket.
 * S10: a proxy that closed during the GREETING waited out the full handshake
 *     timeout and was then reported as the PEER's fault — although at that stage
 *     only our own proxy is involved (F2's class, on the one branch F2 missed).
 * And: a CONNECT reply longer than the IPv4 form (an IPv6 or domain BND.ADDR)
 *     left its tail in front of the HTTP response undici reads next.
 * M1 (v1.18.0 deep-deep): the I2P CONNECT connector had no early-close
 *     listener. A proxy that closed during the handshake (i2pd restarting)
 *     destroyed the socket, which also cleared its timer, so the connect
 *     callback was NEVER called — and the pooled route (connections: 1) queued
 *     every later push behind that connect until the process restarted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as http from 'node:http';
import { Agent } from 'undici';
import {
	makeHttpConnectConnector,
	makeSocks5Connector,
	isProxyUnavailable
} from '@morphit/hidden-transport';

const closers: (() => void)[] = [];
afterEach(() => {
	for (const c of closers.splice(0)) c();
});

async function listen(handler: (s: net.Socket) => void): Promise<number> {
	const srv = net.createServer(handler);
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	closers.push(() => srv.close());
	const a = srv.address();
	if (a === null || typeof a === 'string') throw new Error('no address');
	return a.port;
}

type Settle = { err: Error | null; socket: net.Socket | null };

function connectVia(port: number): { calls: Settle[]; first: Promise<Settle> } {
	const calls: Settle[] = [];
	let resolveFirst: (v: Settle) => void = () => undefined;
	const first = new Promise<Settle>((r) => {
		resolveFirst = r;
	});
	makeSocks5Connector('127.0.0.1', port)(
		{ hostname: `${'b'.repeat(56)}.onion`, port: 80 },
		(err, socket) => {
			calls.push({ err, socket });
			if (calls.length === 1) resolveFirst({ err, socket });
		}
	);
	return { calls, first };
}

const turns = async (n: number) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe('makeSocks5Connector', () => {
	it('calls back exactly once, even when a pooled tunnel errors later (S8)', async () => {
		let server: net.Socket | undefined;
		const port = await listen((s) => {
			server = s;
			s.on('error', () => undefined);
			s.once('data', () => {
				s.write(Buffer.from([0x05, 0x00]));
				s.once('data', () => s.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])));
			});
		});
		const { calls, first } = connectVia(port);
		const ok = await first;
		expect(ok.err).toBeNull();
		ok.socket?.on('error', () => undefined); // what undici does with the socket
		server?.resetAndDestroy(); // the tunnel dies while idle in the pool
		await turns(50);
		expect(calls.length, 'the connect callback fired again after the tunnel was handed over').toBe(
			1
		);
	});

	it('a proxy that closes during the greeting is OUR fault, and is known at once (S10)', async () => {
		const port = await listen((s) => {
			s.once('data', () => s.destroy());
		});
		const started = performance.now();
		const { first } = connectVia(port);
		const r = await first;
		expect(r.err).not.toBeNull();
		expect(
			isProxyUnavailable(r.err),
			'a failure while only our proxy was involved was blamed on the peer'
		).toBe(true);
		expect(performance.now() - started, 'it waited out the handshake timeout').toBeLessThan(2_000);
	});

	it('a CONNECT reply with a domain address leaves nothing in front of the HTTP bytes', async () => {
		const domain = Buffer.from('relay.example');
		const port = await listen((s) => {
			s.once('data', () => {
				s.write(Buffer.from([0x05, 0x00]));
				s.once('data', () => {
					const reply = Buffer.concat([
						Buffer.from([0x05, 0x00, 0x00, 0x03, domain.length]),
						domain,
						Buffer.from([0x00, 0x50])
					]);
					// Split mid-reply, and the tunnelled bytes glued to its end.
					s.write(reply.subarray(0, 8));
					setImmediate(() => s.write(Buffer.concat([reply.subarray(8), Buffer.from('HTTP/1.1')])));
				});
			});
		});
		// The listener is attached INSIDE the callback, synchronously — as undici
		// does. Bytes pushed back onto the socket are emitted on the next tick.
		const got = await new Promise<string>((resolve, reject) => {
			makeSocks5Connector('127.0.0.1', port)(
				{ hostname: `${'b'.repeat(56)}.onion`, port: 80 },
				(err, socket) => {
					if (err !== null || socket === null) return reject(err);
					socket.once('data', (d: Buffer) => {
						resolve(d.toString());
						socket.destroy();
					});
				}
			);
		});
		expect(got, 'the tail of the SOCKS reply was handed to the HTTP parser').toBe('HTTP/1.1');
	});
});

describe('makeHttpConnectConnector', () => {
	it('bytes that arrive with the CONNECT reply reach the consumer (they used to vanish)', async () => {
		const port = await listen((s) => {
			s.once('data', () => {
				s.write('HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1');
			});
		});
		const got = await new Promise<string>((resolve, reject) => {
			makeHttpConnectConnector('127.0.0.1', port)(
				{ hostname: `${'c'.repeat(52)}.b32.i2p`, port: 80 },
				(err, socket) => {
					if (err !== null || socket === null) return reject(err);
					socket.once('data', (d: Buffer) => {
						resolve(d.toString());
						socket.destroy();
					});
				}
			);
		});
		expect(got).toBe('HTTP/1.1');
	});
});

/** Wait on a condition, never on a fixed sleep. */
async function until(cond: () => boolean, maxMs: number): Promise<void> {
	const deadline = performance.now() + maxMs;
	while (!cond() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

describe('makeHttpConnectConnector — a proxy that closes mid-handshake (M1)', () => {
	it('settles at once, as OUR fault, instead of never', async () => {
		const port = await listen((s) => {
			s.once('data', () => s.end());
		});
		const calls: Settle[] = [];
		const started = performance.now();
		makeHttpConnectConnector('127.0.0.1', port)(
			{ hostname: `${'c'.repeat(52)}.b32.i2p`, port: 80 },
			(err, socket) => {
				calls.push({ err, socket });
			}
		);
		await until(() => calls.length > 0, 3_000);
		expect(calls.length, 'the connect callback was never called').toBe(1);
		expect(isProxyUnavailable(calls[0]!.err), 'blamed on the peer, not our proxy').toBe(true);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it('does not wedge the pooled I2P route once the proxy is healthy again', async () => {
		let healthy = false;
		const target = http.createServer((_q, r) => r.end('ok'));
		await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
		closers.push(() => target.close());
		const tport = (target.address() as net.AddressInfo).port;
		const pport = await listen((c) => {
			if (!healthy) {
				c.once('data', () => c.end());
				return;
			}
			c.once('data', () => {
				const up = net.connect(tport, '127.0.0.1', () => {
					c.write('HTTP/1.1 200 OK\r\n\r\n');
					c.pipe(up).pipe(c);
				});
			});
		});
		// Exactly the chat pool's shape for an I2P origin: ONE connection.
		const agent = new Agent({
			connect: makeHttpConnectConnector('127.0.0.1', pport) as never,
			connections: 1,
			keepAliveTimeout: 240_000
		});
		closers.push(() => void agent.destroy());
		const get = async (): Promise<{ status?: number; err?: unknown }> => {
			try {
				const r = await fetch(`http://${'c'.repeat(52)}.b32.i2p/v1/health`, {
					dispatcher: agent,
					signal: AbortSignal.timeout(3_000)
				} as unknown as RequestInit);
				await r.text();
				return { status: r.status };
			} catch (err) {
				return { err };
			}
		};
		const first = await get();
		healthy = true;
		const second = await get();
		expect(second.status, 'the route stayed wedged after the proxy recovered').toBe(200);
		expect(first.status).toBeUndefined();
		expect(
			isProxyUnavailable((first.err as { cause?: unknown }).cause ?? first.err),
			'the proxy closing was reported as something other than our proxy'
		).toBe(true);
	});
});
