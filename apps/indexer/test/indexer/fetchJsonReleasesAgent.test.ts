/**
 * fetchJson releases its connection.
 *
 * Each probe builds its own IP-pinned undici Agent (the DNS-rebinding defence)
 * and never closed it, and a non-2xx answer left its body unread. Either way
 * the connection to the peer stayed open after fetchJson had returned — a small
 * socket leak per probe, per peer, on every scan of a clearnet node. Observed
 * here from the server's side: does the peer see its connection closed once
 * fetchJson is done?
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import https from 'node:https';
import type net from 'node:net';
import { fetchJson, _setDnsResolverForTesting } from '$indexer/federationProbe';

// A throwaway self-signed certificate for `peer.example`, made for this test
// only (openssl, P-256, 100 years). It protects nothing.
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg8N/ZAFPZBzCkY1Z0
NS5MGoga94Yy1DywT5A4nXjtJNyhRANCAAQDJeZuEy3rnsBmFA4CksEHJEKNjBC7
pSMAW8d5u+fFn2QrMDlMPRvWYjoUtCzf/LrqLTFVMv0TwtKa2JhvJ4ck
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBnzCCAUSgAwIBAgIUdXpEkX94fvqR8r9KtBf6k3SiKlEwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMcGVlci5leGFtcGxlMCAXDTI2MDkyNTAyMjEzNVoYDzIxMjYw
OTAxMDIyMTM1WjAXMRUwEwYDVQQDDAxwZWVyLmV4YW1wbGUwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAQDJeZuEy3rnsBmFA4CksEHJEKNjBC7pSMAW8d5u+fFn2Qr
MDlMPRvWYjoUtCzf/LrqLTFVMv0TwtKa2JhvJ4cko2wwajAdBgNVHQ4EFgQUp+qs
gCtd7+xUoU7Cb6NvnXujddcwHwYDVR0jBBgwFoAUp+qsgCtd7+xUoU7Cb6NvnXuj
ddcwDwYDVR0TAQH/BAUwAwEB/zAXBgNVHREEEDAOggxwZWVyLmV4YW1wbGUwCgYI
KoZIzj0EAwIDSQAwRgIhAOwD3hZu1z3coFNiqpvaJgJ9tU4Yba8EF3TlxkRvFdQk
AiEA9X4raDq4XKooI5xudDvR7ZseLljWfCpPfp7roCHE7Oo=
-----END CERTIFICATE-----`;

let server: https.Server;
let port = 0;
/** This server's live connections (a Set, so a previous test's late close
 *  cannot be counted against this one). */
let sockets = new Set<net.Socket>();
let respond: (
	req: import('node:http').IncomingMessage,
	res: import('node:http').ServerResponse
) => void;
const tlsWas = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

beforeEach(async () => {
	sockets = new Set();
	const mine = sockets;
	// The pinned agent verifies the peer's certificate; ours is self-signed.
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
	server = https.createServer({ key: KEY, cert: CERT }, (q, r) => respond(q, r));
	server.keepAliveTimeout = 60_000;
	server.on('secureConnection', (s: net.Socket) => {
		mine.add(s);
		s.on('close', () => mine.delete(s));
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	port = (server.address() as net.AddressInfo).port;
	_setDnsResolverForTesting(async () => ({ address: '127.0.0.1', family: 4 }));
});
afterEach(async () => {
	_setDnsResolverForTesting(null);
	if (tlsWas === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsWas;
	server.closeAllConnections();
	await new Promise<void>((r) => server.close(() => r()));
});

async function until(cond: () => boolean, maxMs: number): Promise<void> {
	const deadline = performance.now() + maxMs;
	while (!cond() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

const url = (): string => `https://peer.example:${port}/v1/instance`;

describe('L4 — fetchJson closes what it opened', () => {
	it('after a 2xx, the per-probe agent is closed (no idle keep-alive left behind)', async () => {
		respond = (_q, r) => {
			r.setHeader('content-type', 'application/json');
			r.end('{"ok":true}');
		};
		expect(await fetchJson<{ ok: boolean }>(url())).toEqual({ ok: true });
		await until(() => sockets.size === 0, 1_000);
		expect(sockets.size, 'the connection to the peer was left open').toBe(0);
	});

	it('after a non-2xx, the unread body is cancelled and the connection closed', async () => {
		respond = (_q, r) => {
			r.writeHead(503, { 'content-type': 'text/plain' });
			r.write('x'.repeat(1024)); // and never end: a body nobody will read
		};
		await expect(fetchJson(url())).rejects.toThrow(/HTTP 503/);
		await until(() => sockets.size === 0, 1_000);
		expect(sockets.size, 'the connection to the peer was left open').toBe(0);
	});
});
