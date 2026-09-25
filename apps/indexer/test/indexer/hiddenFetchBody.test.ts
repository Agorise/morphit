/**
 * v1.18.0 review (S1) — a hidden peer's ERROR PAGE must not hang the probe.
 *
 * `fetchJsonViaHiddenService` builds its own dispatcher per call and closes it
 * in `finally`. undici's `close()` waits for every response body to be consumed,
 * and on a non-2xx status the function threw without reading or cancelling the
 * body. A body small enough to sit in the socket buffers drained anyway; one
 * larger — 128 KB was enough — never did, so `close()` never resolved and the
 * probe never settled. The federation probe awaits every peer before its next
 * scan, so ONE hidden peer returning a large 404 (a WAF error page will do)
 * stopped probing for the whole node until the process restarted.
 *
 * Driven for real: a SOCKS5 server on loopback that tunnels to a local HTTP
 * server, exactly the path an onion takes through Tor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { fetchJsonViaHiddenService } from '$indexer/hiddenServiceFetch';

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

describe('a hidden peer that answers with a large error page', () => {
	it('settles promptly instead of hanging the probe forever', async () => {
		const big = Buffer.alloc(512 * 1024, 0x61);
		const port = await httpServer((_req, res) => {
			res.writeHead(404, { 'content-type': 'text/html' });
			res.end(big);
		});
		const socks = await socksTo(port);
		// The test's own timeout is the watchdog: on the bug this never settles,
		// and a hang is exactly the failure being guarded.
		await expect(
			fetchJsonViaHiddenService(`http://${ONION}/v1/instance`, {
				torSocks: `127.0.0.1:${socks}`,
				i2pHttpProxy: ''
			}),
			'the probe must settle — an undrained error body held dispatcher.close() open'
		).rejects.toThrow(/HTTP 404/);
	}, 4_000);
});
