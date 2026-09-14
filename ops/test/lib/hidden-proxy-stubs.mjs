/**
 * ops/test/lib/hidden-proxy-stubs.mjs
 *
 * Faithful stand-ins for the two proxies a hidden-only Morphit node depends on:
 *
 *   .b32.i2p  →  i2pd's HTTP proxy      (undici `new ProxyAgent('http://h:p')`)
 *   .onion    →  Tor's SOCKS5 port      (a hand-rolled SOCKS5 connector)
 *
 * They are DIFFERENT code paths in hiddenServiceDispatcher.ts, so a test that
 * only exercises I2P proves nothing about Tor. Both are stubbed here.
 *
 * An earlier attempt used a plain echo server as the "proxy". undici's
 * ProxyAgent speaks real proxy protocol to it, got no valid reply, and HUNG
 * until the harness timed out — a test that hangs is worse than no test. Hence
 * the real thing: absolute-URI forwarding, CONNECT tunnelling, and a genuine
 * SOCKS5 handshake.
 *
 * Every proxied connection is recorded so a test can assert not merely that the
 * request succeeded, but that it genuinely travelled through the proxy — which
 * is the property that actually matters. Talking to the target directly must
 * NOT satisfy the assertion.
 *
 * Usage:
 *   node hidden-proxy-stubs.mjs <originPort> <httpProxyPort> <socksPort> <logFile>
 * The origin server answers any request with the JSON on stdin-configured env
 * MORPHIT_STUB_BODY (defaults to '{}').
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const [, , originPortRaw, httpProxyPortRaw, socksPortRaw, logFile] = process.argv;
const ORIGIN_PORT = Number(originPortRaw);
const HTTP_PROXY_PORT = Number(httpProxyPortRaw);
const SOCKS_PORT = Number(socksPortRaw);
const BODY = process.env.MORPHIT_STUB_BODY ?? '{}';

const note = (line) => {
	try {
		appendFileSync(logFile, `${line}\n`);
	} catch {
		/* logging is best-effort */
	}
};

// ── The "hidden service" itself ──────────────────────────────────────
// Answers every request identically. In a real deployment this is the remote
// blurtd behind the .onion / .b32.i2p address.
// A GET is a content fetch (an IPFS gateway path); a POST is a chain RPC call.
// Serving both lets one stub stand in for a peer that is BOTH an RPC endpoint
// and a snapshot mirror — which is exactly what a federation peer is.
const SERVE_FILE = process.env.MORPHIT_STUB_FILE ?? '';
createHttpServer((req, res) => {
	if (req.method === 'GET' || req.method === 'HEAD') {
		note(`origin GET ${req.url}`);
		if (SERVE_FILE === '' || !existsSync(SERVE_FILE)) {
			res.writeHead(404).end();
			return;
		}
		const buf = readFileSync(SERVE_FILE);
		res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
		res.end(req.method === 'HEAD' ? undefined : buf);
		return;
	}
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		let id = 1;
		try {
			id = JSON.parse(body).id ?? 1;
		} catch {
			/* a non-JSON probe still gets a well-formed reply */
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ jsonrpc: '2.0', id, result: JSON.parse(BODY) }));
	});
}).listen(ORIGIN_PORT, '127.0.0.1');

// ── i2pd's HTTP proxy ────────────────────────────────────────────────
// Handles BOTH shapes a client may use:
//   absolute-URI  →  "POST http://host/ HTTP/1.1" forwarded on our behalf
//   CONNECT       →  a raw tunnel we splice to the origin
const proxy = createHttpServer((req, res) => {
	note(`i2p-proxy absolute-uri ${req.method} ${req.url}`);
	const upstream = httpRequest(
		{ host: '127.0.0.1', port: ORIGIN_PORT, method: req.method, path: '/', headers: req.headers },
		(up) => {
			res.writeHead(up.statusCode ?? 502, up.headers);
			up.pipe(res);
		}
	);
	upstream.on('error', () => {
		res.writeHead(502).end();
	});
	req.pipe(upstream);
});
proxy.on('connect', (req, clientSocket, head) => {
	note(`i2p-proxy CONNECT ${req.url}`);
	const target = netConnect(ORIGIN_PORT, '127.0.0.1', () => {
		clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		if (head?.length) target.write(head);
		target.pipe(clientSocket);
		clientSocket.pipe(target);
	});
	target.on('error', () => clientSocket.destroy());
	clientSocket.on('error', () => target.destroy());
});
proxy.listen(HTTP_PROXY_PORT, '127.0.0.1');

// ── Tor's SOCKS5 port ────────────────────────────────────────────────
// Minimal but real RFC 1928: greeting → no-auth → CONNECT → splice.
createNetServer((sock) => {
	let stage = 'greeting';
	sock.on('error', () => sock.destroy());
	sock.on('data', (chunk) => {
		if (stage === 'greeting') {
			// [ver, nmethods, methods...] → reply "no authentication required"
			if (chunk[0] !== 0x05) {
				sock.destroy();
				return;
			}
			sock.write(Buffer.from([0x05, 0x00]));
			stage = 'request';
			return;
		}
		if (stage === 'request') {
			// [ver, cmd, rsv, atyp, addr..., port]
			if (chunk[0] !== 0x05 || chunk[1] !== 0x01) {
				sock.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
				sock.destroy();
				return;
			}
			let host = '(unknown)';
			const atyp = chunk[3];
			if (atyp === 0x03) {
				const len = chunk[4];
				host = chunk.subarray(5, 5 + len).toString('ascii');
			} else if (atyp === 0x01) {
				host = Array.from(chunk.subarray(4, 8)).join('.');
			}
			note(`tor-socks CONNECT ${host}`);
			const target = netConnect(ORIGIN_PORT, '127.0.0.1', () => {
				// success + bound addr 0.0.0.0:0
				sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
				stage = 'tunnel';
				target.pipe(sock);
				sock.pipe(target);
			});
			target.on('error', () => {
				sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
				sock.destroy();
			});
		}
	});
}).listen(SOCKS_PORT, '127.0.0.1');

process.stdout.write('stubs-ready\n');
