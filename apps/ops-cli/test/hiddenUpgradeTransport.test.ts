/**
 * v1.18.0 review — the hidden-upgrade tarball fetch must stay bounded and
 * cancellable for the WHOLE download, not just until the headers arrive.
 *
 * The timeout and the caller's abort were both cleared the moment the response
 * headers came back. The body — tens of megabytes over Tor or I2P, nearly all of
 * the transfer — was then read with no timeout and deaf to the caller: a peer
 * that sent headers and stalled held a hidden-only node's upgrade forever, and a
 * peer that lost the race went on downloading in the background. And an error
 * page larger than the socket buffers hung `dispatcher.close()` (S1).
 *
 * Driven through a real SOCKS5 server on loopback, the path an onion takes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { makeHiddenTarballFetcher } from '../src/init/hiddenUpgradeTransport.ts';

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

describe('the hidden-upgrade tarball fetch', () => {
	it('a peer that stalls mid-body is abandoned when the caller aborts', async () => {
		const port = await httpServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(1 << 20) });
			res.write(Buffer.alloc(1024, 0x1f)); // then nothing, ever
		});
		const socks = await socksTo(port);
		const fetchTarball = makeHiddenTarballFetcher({
			proxy: { torSocks: `127.0.0.1:${socks}`, i2pHttpProxy: '' }
		});
		const ac = new AbortController();
		const pending = fetchTarball(`http://${ONION}/release.tar.gz`, ac.signal);
		// Let the headers and the first chunk arrive, then lose the race.
		for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));
		ac.abort(new Error('lost the race'));
		await expect(
			pending,
			'the body read ignored the abort — a stalled peer holds the upgrade forever'
		).rejects.toThrow();
	}, 4_000);

	it('a large error page does not hang the fetch', async () => {
		const big = Buffer.alloc(512 * 1024, 0x61);
		const port = await httpServer((_req, res) => {
			res.writeHead(404, { 'content-type': 'text/html' });
			res.end(big);
		});
		const socks = await socksTo(port);
		const fetchTarball = makeHiddenTarballFetcher({
			proxy: { torSocks: `127.0.0.1:${socks}`, i2pHttpProxy: '' }
		});
		await expect(
			fetchTarball(`http://${ONION}/release.tar.gz`, new AbortController().signal)
		).rejects.toThrow(/HTTP 404/);
	}, 4_000);
});
