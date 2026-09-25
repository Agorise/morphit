/**
 * v1.18.0 review — the WARM-UP, driven over real sockets.
 *
 * S4: a warm-up reads a peer's health body only so the connection returns to the
 *     pool clean — and it read ALL of it, forty peers at a time, every three
 *     minutes, bounded only by a sixty-second timeout. A hostile peer could
 *     stream as much memory into this process as it liked.
 * S2: a warm-up's local fault carried no confidence, so the breaker fell back to
 *     what the NETWORK implies — and I2P is otherwise conclusive, so one peer
 *     whose tunnel the proxy REFUSED took I2P away from every other peer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { warmHiddenOrigin, closePool } from '$indexer/hiddenServicePool';

const ONION = `${'a'.repeat(56)}.onion`;
const closers: (() => void)[] = [];
afterEach(() => {
	for (const c of closers.splice(0)) c();
});

/** A minimal SOCKS5 server: no auth, CONNECT, then splice to `targetPort`. */
async function socksTo(targetPort: number): Promise<number> {
	const srv = net.createServer((client) => {
		let stage = 0;
		let buf = Buffer.alloc(0);
		client.on('error', () => undefined);
		client.on('data', function onData(chunk) {
			buf = Buffer.concat([buf, chunk]);
			if (stage === 0 && buf.length >= 3) {
				buf = buf.subarray(3);
				client.write(Buffer.from([0x05, 0x00]));
				stage = 1;
			}
			if (stage === 1 && buf.length >= 5) {
				const len = buf[4] ?? 0;
				if (buf.length < 5 + len + 2) return;
				buf = buf.subarray(5 + len + 2);
				stage = 2;
				client.removeListener('data', onData);
				const up = net.connect(targetPort, '127.0.0.1', () => {
					client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
					if (buf.length > 0) up.write(buf);
					client.pipe(up).pipe(client);
				});
				up.on('error', () => client.destroy());
			}
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	closers.push(() => srv.close());
	const a = srv.address();
	if (a === null || typeof a === 'string') throw new Error('no address');
	return a.port;
}

async function httpServer(handler: http.RequestListener): Promise<number> {
	const srv = http.createServer(handler);
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	closers.push(() => {
		srv.closeAllConnections?.();
		srv.close();
	});
	const a = srv.address();
	if (a === null || typeof a === 'string') throw new Error('no address');
	return a.port;
}

afterEach(async () => {
	await closePool(500);
});

describe('warmHiddenOrigin', () => {
	it('does not read an endless body into memory', async () => {
		let written = 0;
		const port = await httpServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			const chunk = Buffer.alloc(64 * 1024, 0x20);
			const pump = (): void => {
				if (res.destroyed) return;
				written += chunk.length;
				if (res.write(chunk)) setImmediate(pump);
				else res.once('drain', pump);
			};
			pump();
		});
		const socks = await socksTo(port);
		const r = await warmHiddenOrigin(
			`http://${ONION}`,
			{ torSocks: `127.0.0.1:${socks}`, i2pHttpProxy: '' },
			60_000
		);
		expect(r.ok).toBe(true);
		// The server writes ahead into socket buffers, so "written" overshoots
		// what was READ — but a warm-up that drains everything never returns at
		// all against this server, and one that stops at the cap returns at once.
		expect(written, 'the warm-up kept reading a body with no end').toBeLessThan(64 * 1024 * 1024);
	}, 4_000);

	it('a proxy that refuses the tunnel is an AMBIGUOUS local fault, not a conclusive one', async () => {
		const proxy = http.createServer((_req, res) => res.writeHead(400).end());
		proxy.on('connect', (_req, socket: net.Socket) => {
			socket.write('HTTP/1.1 403 Refused\r\ncontent-length: 0\r\n\r\n');
			socket.end();
		});
		await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
		closers.push(() => proxy.close());
		const a = proxy.address();
		if (a === null || typeof a === 'string') throw new Error('no address');
		const r = await warmHiddenOrigin(
			`http://${'e'.repeat(52)}.b32.i2p`,
			{ torSocks: '', i2pHttpProxy: `127.0.0.1:${a.port}` },
			4_000
		);
		expect(r.ok).toBe(false);
		expect(r.localFault).toBe(true);
		expect(
			r.confidence,
			'without it the breaker assumes conclusive, and one refused peer convicts I2P for all'
		).toBe('ambiguous');
	});
});
