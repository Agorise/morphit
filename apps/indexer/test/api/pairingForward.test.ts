/**
 * v1.20.0 — cross-instance QR sign-in through the phone's OWN instance.
 *
 * Two indexers in this process: A, where the desktop waits for its bundle, and
 * B, where the phone is signed in. The phone only ever talks to B (same
 * origin); B carries the bundle to A. A is a REAL HTTP server running A's real
 * pairing route and middleware, and B reaches it through a REAL SOCKS5 server
 * on loopback standing in for Tor — the exact code path an onion takes — or,
 * for clearnet, through the resolve-and-pin transport with DNS stubbed.
 *
 * Asserted as behaviour: what the desktop receives, which address B dialled
 * and over which transport, and what never got a connection.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import {
	installHiddenServiceDispatcher,
	type HiddenDispatcherHandle
} from '@morphit/hidden-transport/router';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';

import { loginPairingRoute, PairingRegistry } from '$api/loginPairing';
import {
	pairingForwardRoute,
	parseForwardBody,
	parsePairingTarget,
	selfPairingAddresses,
	ForwardBudget,
	dialPairingDeliver
} from '$api/pairingForward';
import { ProxyUnavailableError } from '@morphit/hidden-transport';
import { bodyCap } from '$api/middleware/bodyCap';
import { cors } from '$api/middleware/cors';
import { rateLimit, _resetRateLimitForTest } from '$api/middleware/ratelimit';
import { closePool } from '$indexer/hiddenServicePool';
import { postClearnetPinned, closePinnedClearnet } from '$indexer/pinnedClearnetPost';
import type { FastFederationDb } from '$indexer/chatFastFederation';

const A_ONION = `${'a'.repeat(56)}.onion`;
const B_ONION = `${'b'.repeat(56)}.onion`;
const A_ORIGIN = 'https://a.example';
const B_ORIGIN = 'https://b.example';
const PHONE_IP = '203.0.113.77';

const closers: (() => void | Promise<void>)[] = [];
afterAll(async () => {
	for (const c of closers.splice(0)) await c();
	await closePool();
	await closePinnedClearnet();
});

// ─── a Tor stand-in: SOCKS5 that splices every CONNECT to one local port ─────
interface FakeTor {
	readonly port: number;
	/** Every hostname a CONNECT asked for, in order. */
	readonly asked: string[];
	retarget(port: number): void;
}
async function fakeTor(targetPort: number): Promise<FakeTor> {
	const asked: string[] = [];
	let target = targetPort;
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
				asked.push(buf.subarray(5, 5 + len).toString('latin1'));
				buf = buf.subarray(5 + len + 2);
				stage = 2;
				client.removeListener('data', onData);
				const up = net.connect(target, '127.0.0.1', () => {
					client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
					if (buf.length > 0) up.write(buf);
					client.pipe(up).pipe(client);
				});
				up.on('error', () => client.destroy());
			}
		});
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	closers.push(() => new Promise<void>((r) => srv.close(() => r())));
	return {
		port: (srv.address() as net.AddressInfo).port,
		asked,
		retarget(p) {
			target = p;
		}
	};
}

async function httpServer(
	handler: http.RequestListener
): Promise<{ port: number; hits: () => number }> {
	let hits = 0;
	const srv = http.createServer((req, res) => {
		hits++;
		handler(req, res);
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	closers.push(() => {
		srv.closeAllConnections?.();
		return new Promise<void>((r) => srv.close(() => r()));
	});
	return { port: (srv.address() as net.AddressInfo).port, hits: () => hits };
}

/** A plain TCP listener that only counts connections (the "must never be
 *  reached" detector). */
async function tcpCounter(): Promise<{ port: number; count: () => number }> {
	let n = 0;
	const srv = net.createServer((s) => {
		n++;
		s.destroy();
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	closers.push(() => new Promise<void>((r) => srv.close(() => r())));
	return { port: (srv.address() as net.AddressInfo).port, count: () => n };
}

// ─── instance A: the real pairing route behind the real middleware ───────────
interface Seen {
	headers: Record<string, string>;
	body: string;
	path: string;
}
function indexerApp(registry: PairingRegistry, seen?: Seen[]): Hono {
	const app = new Hono();
	if (seen !== undefined) {
		// Record what arrives. Hono caches the body text, so the route
		// reads the same bytes afterwards.
		app.use('*', async (c, next) => {
			if (c.req.method === 'POST') {
				seen.push({ headers: c.req.header(), body: await c.req.text(), path: c.req.path });
			}
			await next();
		});
	}
	app.use('*', cors());
	app.use('*', bodyCap(4096, 131072, 262144));
	const pairing = new Hono();
	pairing.use('/:pid/deliver', rateLimit('resource', 600));
	pairing.route('/', loginPairingRoute(registry));
	app.route('/v1/login-pairing', pairing);
	return app;
}

async function startA(): Promise<{ port: number; registry: PairingRegistry; seen: Seen[] }> {
	const registry = new PairingRegistry();
	closers.push(() => registry.close());
	const seen: Seen[] = [];
	const listener = getRequestListener(indexerApp(registry, seen).fetch);
	const { port } = await httpServer((req, res) => void listener(req, res));
	return { port, registry, seen };
}

/** The desktop: subscribe to A's SSE wait and resolve with the first event.
 *  Returns once A has REGISTERED the wait (the response headers of an idle SSE
 *  stream are not flushed until its first byte, so that is what is polled). */
async function desktopWaits(
	a: { port: number; registry: PairingRegistry },
	pid: string
): Promise<{ readonly events: Promise<{ event: string; data: string }> }> {
	const before = a.registry.size();
	const events = (async () => {
		const res = await fetch(`http://127.0.0.1:${a.port}/v1/login-pairing/${pid}/wait`);
		const reader = res.body!.getReader();
		let text = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += Buffer.from(value).toString('utf8');
			const m = /event: (\w+)\ndata: ([^\n]*)\n\n/.exec(text);
			if (m) {
				await reader.cancel();
				return { event: m[1]!, data: m[2]! };
			}
		}
		throw new Error(`stream ended without an event: ${text}`);
	})();
	for (let i = 0; i < 200 && a.registry.size() === before; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
	if (a.registry.size() === before) throw new Error('desktop wait never registered');
	// Wrapped: an async function returning a bare promise would adopt it, and
	// the caller would wait for the EVENT instead of the registration.
	return { events };
}

// ─── the directory B reads ───────────────────────────────────────────────────
interface Row {
	origin: string;
	reg_alt_networks: Record<string, string | null> | null;
	last_probe_status: string | null;
	last_probed_at: null;
	registered_at_time: Date;
	last_probe_error: null;
}
function row(origin: string, alt: Record<string, string> | null = null, status = 'good'): Row {
	return {
		origin,
		reg_alt_networks: alt,
		last_probe_status: status,
		last_probed_at: null,
		registered_at_time: new Date('2026-01-01T00:00:00Z'),
		last_probe_error: null
	};
}
/** Every row but the `mismatch` ones — deliberately NOT the SQL's coarse host
 *  filter, so the exact match under test is the route's own TypeScript and a
 *  loosened comparison there cannot hide behind the query. The SQL itself runs
 *  against real Postgres in test/integration/pairing-forward-directory.test.ts. */
function directory(rows: Row[]): FastFederationDb {
	return {
		async query() {
			return { rows: rows.filter((r) => r.last_probe_status !== 'mismatch') } as never;
		}
	};
}

// ─── the phone's delivery payload (opaque ciphertext, real shape) ────────────
function delivery(pid: string, ciphertextBytes = 700) {
	return {
		v: 1,
		pid,
		ephemeral_pub: randomBytes(32).toString('base64'),
		nonce: randomBytes(12).toString('base64'),
		ciphertext: randomBytes(ciphertextBytes).toString('base64')
	};
}
const newPid = (): string => randomBytes(32).toString('hex');

// ─── instance B ──────────────────────────────────────────────────────────────
interface Spies {
	clearnet: string[];
}
function startB(opts: {
	rows: Row[];
	proxies: HiddenServiceProxyConfig;
	postClearnet?: (
		url: string,
		body: unknown,
		t: number
	) => Promise<{ status: number; body: string }>;
	budget?: ForwardBudget;
	hiddenTimeoutMs?: number;
}): { app: Hono; registry: PairingRegistry; spies: Spies } {
	const registry = new PairingRegistry();
	closers.push(() => registry.close());
	const spies: Spies = { clearnet: [] };
	const app = indexerApp(registry);
	const pairingApp = new Hono();
	pairingApp.use('*', rateLimit('list', 120));
	pairingApp.route(
		'/',
		pairingForwardRoute({
			db: directory(opts.rows),
			self: selfPairingAddresses([B_ORIGIN, B_ONION]),
			proxies: opts.proxies,
			deliverLocal: (pid, json, now) => registry.deliver(pid, json, now),
			postClearnet: async (url, body, t) => {
				spies.clearnet.push(url);
				if (opts.postClearnet === undefined) throw new Error('no clearnet in this test');
				return opts.postClearnet(url, body, t);
			},
			budget: opts.budget,
			hiddenTimeoutMs: opts.hiddenTimeoutMs
		})
	);
	app.route('/v1/pairing', pairingApp);
	return { app, registry, spies };
}

/** The phone: POST to its OWN instance, as the browser does (same origin). */
async function phoneForward(
	b: Hono,
	body: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	const res = await b.request('/v1/pairing/forward', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'content-length': String(Buffer.byteLength(text)),
			'x-forwarded-for': PHONE_IP
		},
		body: text
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(() => _resetRateLimitForTest());
afterEach(() => _resetRateLimitForTest());

// ─────────────────────────────────────────────────────────────────────────────
describe('cross-instance QR sign-in, end to end', () => {
	it('phone on B, desktop on A: the bundle reaches A’s desktop over A’s onion', async () => {
		const a = await startA();
		const tor = await fakeTor(a.port);
		const b = startB({
			rows: [row(A_ORIGIN, { tor: A_ONION })],
			proxies: { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' }
		});
		const pid = newPid();
		const got = (await desktopWaits(a, pid)).events;
		const d = delivery(pid);
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: d });
		expect(r.status, JSON.stringify(r.json)).toBe(200);
		expect(r.json.ok).toBe(true);
		const ev = await got;
		expect(ev.event).toBe('bundle');
		expect(JSON.parse(ev.data)).toEqual(d);
		// Over the HIDDEN address, not the clearnet one sitting in the same row.
		expect(tor.asked).toEqual([A_ONION]);
		expect(b.spies.clearnet).toEqual([]);
		// The ONE path, and nothing of the phone's reaches A.
		expect(a.seen.map((s) => s.path)).toEqual([`/v1/login-pairing/${pid}/deliver`]);
		expect(JSON.stringify(a.seen)).not.toContain(PHONE_IP);
		expect(a.seen[0]!.headers['user-agent']).toBe('morphit-indexer/pairing-forward');
		expect(JSON.parse(a.seen[0]!.body)).toEqual(d);
	});

	it('a desktop on A’s .onion page (QR names the onion) is matched via the published alt', async () => {
		const a = await startA();
		const tor = await fakeTor(a.port);
		const b = startB({
			rows: [row(A_ORIGIN, { tor: A_ONION })],
			proxies: { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' }
		});
		const pid = newPid();
		const got = (await desktopWaits(a, pid)).events;
		const r = await phoneForward(b.app, {
			target: `http://${A_ONION}`,
			pid,
			delivery: delivery(pid)
		});
		expect(r.status).toBe(200);
		expect((await got).event).toBe('bundle');
		expect(tor.asked).toEqual([A_ONION]);
	});

	it('a clearnet-only A is reached through the resolve-and-pin path', async () => {
		const a = await startA();
		const b = startB({
			rows: [row(A_ORIGIN)],
			proxies: { torSocks: '', i2pHttpProxy: '' },
			// The pinned transport needs real TLS; the route's contract with it
			// (URL, body, timeout) is what is exercised, against A's real server.
			postClearnet: async (url, body) => {
				const u = new URL(url);
				expect(u.origin).toBe(A_ORIGIN);
				const res = await fetch(`http://127.0.0.1:${a.port}${u.pathname}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				});
				return { status: res.status, body: await res.text() };
			}
		});
		const pid = newPid();
		const got = (await desktopWaits(a, pid)).events;
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r.status).toBe(200);
		expect((await got).event).toBe('bundle');
		expect(b.spies.clearnet).toEqual([`${A_ORIGIN}/v1/login-pairing/${pid}/deliver`]);
	});

	it('B’s own Tor is down: falls over to A’s clearnet origin (the chat fan-out’s rule)', async () => {
		const a = await startA();
		const dead = await tcpCounter();
		const b = startB({
			rows: [row(A_ORIGIN, { tor: A_ONION })],
			// Our proxy refuses the SOCKS greeting → a LOCAL fault.
			proxies: { torSocks: `127.0.0.1:${dead.port}`, i2pHttpProxy: '' },
			postClearnet: async (url, body) => {
				const res = await fetch(`http://127.0.0.1:${a.port}${new URL(url).pathname}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				});
				return { status: res.status, body: await res.text() };
			}
		});
		const pid = newPid();
		const got = (await desktopWaits(a, pid)).events;
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r.status, JSON.stringify(r.json)).toBe(200);
		expect((await got).event).toBe('bundle');
		expect(b.spies.clearnet).toHaveLength(1);
	});

	it('same instance, different address (phone on B clearnet, desktop on B onion): delivered locally, nothing dialled', async () => {
		const tor = await fakeTor(1);
		const b = startB({
			rows: [row(B_ORIGIN, { tor: B_ONION })],
			proxies: { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' }
		});
		const pid = newPid();
		const d = delivery(pid);
		// The desktop is waiting on B (a delivery to a code nobody waits on is refused).
		expect(b.registry.register(pid, Date.now())).toEqual({ kind: 'waiting' });
		const r = await phoneForward(b.app, { target: `http://${B_ONION}`, pid, delivery: d });
		expect(r.status).toBe(200);
		let got = '';
		expect(b.registry.setWaiter(pid, (json) => (got = json))).toBe('fired_immediately');
		expect(got).toBe(JSON.stringify(d));
		expect(tor.asked).toEqual([]);
		expect(b.spies.clearnet).toEqual([]);
	});

	it('same origin is untouched: the phone’s direct deliver still reaches the desktop', async () => {
		const b = startB({ rows: [], proxies: { torSocks: '', i2pHttpProxy: '' } });
		const pid = newPid();
		const d = JSON.stringify(delivery(pid));
		const wait = await b.app.request(`/v1/login-pairing/${pid}/wait`);
		const res = await b.app.request(`/v1/login-pairing/${pid}/deliver`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': String(d.length) },
			body: d
		});
		expect(res.status).toBe(200);
		const text = await wait.text();
		expect(text).toContain('event: bundle');
		expect(text).toContain(d);
		expect(b.spies.clearnet).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what the forward refuses', () => {
	it('an origin that is not in the directory: 404 unknown_instance, nothing dialled', async () => {
		const tor = await fakeTor(1);
		const b = startB({
			rows: [row(A_ORIGIN, { tor: A_ONION })],
			proxies: { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' }
		});
		const pid = newPid();
		for (const target of [
			'https://evil.example',
			// A name that merely CONTAINS a registered one.
			'https://a.example.evil.example',
			`http://${'c'.repeat(56)}.onion`
		]) {
			const r = await phoneForward(b.app, { target, pid, delivery: delivery(pid) });
			expect(r.status, target).toBe(404);
			expect(r.json.reason).toBe('unknown_instance');
		}
		const pre = await b.app.request(
			`/v1/pairing/target?origin=${encodeURIComponent('https://evil.example')}`
		);
		expect(await pre.json()).toEqual({ status: 'ok', known: false });
		const ok = await b.app.request(`/v1/pairing/target?origin=${encodeURIComponent(A_ORIGIN)}`);
		expect(await ok.json()).toEqual({ status: 'ok', known: true });
		expect(tor.asked).toEqual([]);
		expect(b.spies.clearnet).toEqual([]);
	});

	it('a registration the probe caught serving someone else’s site (mismatch) is not a target', async () => {
		const b = startB({
			rows: [row(A_ORIGIN, null, 'mismatch')],
			proxies: { torSocks: '', i2pHttpProxy: '' }
		});
		const pid = newPid();
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r.status).toBe(404);
		expect(b.spies.clearnet).toEqual([]);
	});

	it('arbitrary paths, queries, credentials, schemes and pids are refused before any lookup', async () => {
		const b = startB({ rows: [row(A_ORIGIN)], proxies: { torSocks: '', i2pHttpProxy: '' } });
		const pid = newPid();
		for (const target of [
			`${A_ORIGIN}/v1/broadcast`,
			`${A_ORIGIN}/v1/login-pairing/${pid}/deliver`,
			`${A_ORIGIN}?x=1`,
			`${A_ORIGIN}#frag`,
			`https://user@a.example`,
			'http://a.example', // clearnet over plain http
			'https://a.example\\@evil.example',
			'javascript:alert(1)',
			''
		]) {
			const r = await phoneForward(b.app, { target, pid, delivery: delivery(pid) });
			expect(r.status, target).toBe(400);
			expect(r.json.reason, target).toBe('bad_target');
		}
		for (const bad of ['../../v1/broadcast', pid.toUpperCase(), pid.slice(1), '']) {
			const r = await phoneForward(b.app, { target: A_ORIGIN, pid: bad, delivery: delivery(pid) });
			expect(r.status, bad).toBe(400);
		}
		// Extra keys, a different pid inside, or a payload that is not a v1
		// delivery: the forward is not a general-purpose pipe.
		const d = delivery(pid);
		for (const body of [
			{ target: A_ORIGIN, pid, delivery: d, path: '/v1/broadcast' },
			{ target: A_ORIGIN, pid, delivery: { ...d, extra: 'x' } },
			{ target: A_ORIGIN, pid, delivery: { ...d, pid: newPid() } },
			{ target: A_ORIGIN, pid, delivery: { ...d, v: 2 } },
			{ target: A_ORIGIN, pid, delivery: { ...d, ephemeral_pub: 'x' } },
			{ target: A_ORIGIN, pid, delivery: 'not an object' }
		]) {
			const r = await phoneForward(b.app, body);
			expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
		}
		expect(b.spies.clearnet).toEqual([]);
	});

	it('oversized bodies: 413 at the cap, and an over-long ciphertext is not forwarded', async () => {
		const b = startB({ rows: [row(A_ORIGIN)], proxies: { torSocks: '', i2pHttpProxy: '' } });
		const pid = newPid();
		const big = JSON.stringify({ target: A_ORIGIN, pid, delivery: delivery(pid, 3500) });
		expect(Buffer.byteLength(big)).toBeGreaterThan(4096);
		const r = await phoneForward(b.app, big);
		expect(r.status).toBe(413);
		// Under the byte cap but longer than a v1 delivery can be.
		const r2 = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid, 2400) });
		expect(r2.status).toBe(400);
		// And the route's own reader, for a request that arrives without a
		// Content-Length the middleware could check.
		expect(parseForwardBody(big)).toEqual({ ok: false, reason: 'body_too_large' });
		expect(b.spies.clearnet).toEqual([]);
	});

	it('a redirect from the target is not followed', async () => {
		const elsewhere = await httpServer((_q, s) => s.end('ok'));
		const redirector = await httpServer((_q, s) => {
			s.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/v1/broadcast` });
			s.end();
		});
		const tor = await fakeTor(redirector.port);
		const b = startB({
			rows: [row(A_ORIGIN, { tor: A_ONION })],
			proxies: { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' }
		});
		const pid = newPid();
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r.status).toBe(502);
		expect(r.json.reason).toBe('target_redirect_refused');
		expect(redirector.hits()).toBe(1);
		expect(elsewhere.hits(), 'the redirect was followed').toBe(0);
		expect(b.spies.clearnet).toEqual([]);
	});

	it('a registered name that resolves to a private address is never connected to', async () => {
		const local = await tcpCounter();
		const b = startB({
			rows: [row(`https://rebind.example:${local.port}`)],
			proxies: { torSocks: '', i2pHttpProxy: '' },
			// The REAL pinned transport; only DNS is stubbed.
			postClearnet: (url, body, t) =>
				postClearnetPinned(url, body, t, {
					lookup: async () => [{ address: '127.0.0.1', family: 4 }]
				})
		});
		const pid = newPid();
		const r = await phoneForward(b.app, {
			target: `https://rebind.example:${local.port}`,
			pid,
			delivery: delivery(pid)
		});
		expect(r.status).toBe(502);
		expect(r.json.reason).toBe('target_unreachable');
		expect(local.count(), 'a connection reached an internal address').toBe(0);
	});

	it('a target that never answers times out; a huge answer is read bounded', async () => {
		const silent = await httpServer(() => undefined);
		const tor = await fakeTor(silent.port);
		const b = startB({
			rows: [row(A_ORIGIN, { tor: A_ONION })],
			proxies: { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' },
			hiddenTimeoutMs: 500
		});
		const pid = newPid();
		const t0 = Date.now();
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r.status).toBe(502);
		expect(Date.now() - t0).toBeLessThan(5000);

		const flood = await httpServer((_q, s) => {
			s.writeHead(200, { 'content-type': 'application/json' });
			const chunk = Buffer.alloc(64 * 1024, 0x61);
			let sent = 0;
			const pump = (): void => {
				while (sent < 400 && s.write(chunk)) sent++;
				if (sent < 400) s.once('drain', pump);
				else s.end();
			};
			pump();
		});
		tor.retarget(flood.port);
		const t1 = Date.now();
		const r2 = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r2.status).toBe(200);
		expect(JSON.stringify(r2.json)).toBe('{"ok":true}');
		expect(Date.now() - t1).toBeLessThan(5000);
	});

	it('per-target budget: the third forward to one instance in a minute is refused without a dial', async () => {
		const a = await startA();
		const tor = await fakeTor(a.port);
		const b = startB({
			rows: [row(A_ORIGIN, { tor: A_ONION })],
			proxies: { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' },
			budget: new ForwardBudget({ perTargetPerMin: 2 })
		});
		for (let i = 0; i < 2; i++) {
			const pid = newPid();
			// A desktop on A waits on each code, as in real use.
			await desktopWaits(a, pid);
			expect(
				(await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) })).status
			).toBe(200);
		}
		const pid = newPid();
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r.status).toBe(429);
		// Two deliveries reached A (over one kept-alive circuit); the third never left B.
		expect(a.seen).toHaveLength(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a hidden-only B never dials clearnet', () => {
	let handle: HiddenDispatcherHandle | null = null;
	afterEach(async () => {
		await handle?.uninstall();
		handle = null;
	});

	it('clearnet-only A: refused, no clearnet call, no connection anywhere', async () => {
		const tor = await fakeTor(1);
		const proxies = { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' };
		handle = installHiddenServiceDispatcher(proxies, 'refuse');
		const b = startB({
			rows: [row(A_ORIGIN)],
			proxies,
			postClearnet: async () => ({ status: 200, body: '' })
		});
		const pid = newPid();
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r.status).toBe(502);
		expect(b.spies.clearnet).toEqual([]);
		expect(tor.asked).toEqual([]);
	});

	it('A with an onion whose circuit our Tor cannot build: no fallback to A’s clearnet', async () => {
		const dead = await tcpCounter();
		const proxies = { torSocks: `127.0.0.1:${dead.port}`, i2pHttpProxy: '' };
		handle = installHiddenServiceDispatcher(proxies, 'refuse');
		const b = startB({
			rows: [row(A_ORIGIN, { tor: A_ONION })],
			proxies,
			postClearnet: async () => ({ status: 200, body: '' })
		});
		const pid = newPid();
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r.status).toBe(502);
		expect(dead.count()).toBeGreaterThan(0);
		expect(b.spies.clearnet, 'a hidden-only node dialled clearnet').toEqual([]);
	});

	it('the dialler itself skips a clearnet address on a hidden-only node (not only the directory)', async () => {
		handle = installHiddenServiceDispatcher(
			{ torSocks: '127.0.0.1:1', i2pHttpProxy: '' },
			'refuse'
		);
		const dialled: string[] = [];
		const pid = newPid();
		const out = await dialPairingDeliver(
			[{ origin: A_ORIGIN, hidden: false }],
			pid,
			JSON.stringify(delivery(pid)),
			{
				proxies: { torSocks: '127.0.0.1:1', i2pHttpProxy: '' },
				hiddenTimeoutMs: 1_000,
				clearnetTimeoutMs: 1_000,
				now: () => Date.now(),
				postHidden: async (url) => {
					dialled.push(url);
					return { status: 200, body: '' };
				},
				postClearnet: async (url) => {
					dialled.push(url);
					return { status: 200, body: '' };
				}
			}
		);
		expect(dialled, 'a hidden-only node dialled clearnet').toEqual([]);
		expect(out).toEqual({ kind: 'unreachable' });
	});

	it('control: the same A over a working onion is delivered', async () => {
		const a = await startA();
		const tor = await fakeTor(a.port);
		const proxies = { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' };
		handle = installHiddenServiceDispatcher(proxies, 'refuse');
		const b = startB({ rows: [row(A_ORIGIN, { tor: A_ONION })], proxies });
		const pid = newPid();
		const got = (await desktopWaits(a, pid)).events;
		const r = await phoneForward(b.app, { target: A_ORIGIN, pid, delivery: delivery(pid) });
		expect(r.status).toBe(200);
		expect((await got).event).toBe('bundle');
		expect(b.spies.clearnet).toEqual([]);
	});
});

describe('the overall deadline', () => {
	it('each attempt is cut to what is left, and none starts after 60 s', async () => {
		let clock = 1_000_000;
		const budgets: number[] = [];
		const pid = newPid();
		const out = await dialPairingDeliver(
			[
				{ origin: `http://${A_ONION}`, hidden: true },
				{ origin: 'http://peer.b32.i2p', hidden: true },
				{ origin: A_ORIGIN, hidden: false }
			],
			pid,
			JSON.stringify(delivery(pid)),
			{
				proxies: { torSocks: '127.0.0.1:1', i2pHttpProxy: '127.0.0.1:1' },
				hiddenTimeoutMs: 45_000,
				clearnetTimeoutMs: 10_000,
				now: () => clock,
				postHidden: async (_u, _b, _p, t) => {
					budgets.push(t);
					clock += 40_000; // a slow local failure
					throw new ProxyUnavailableError('our proxy is down');
				},
				postClearnet: async (_u, _b, t) => {
					budgets.push(t);
					return { status: 200, body: '' };
				}
			}
		);
		// Onion: full 45 s. I2P: only 20 s were left. Clearnet: never started.
		expect(budgets).toEqual([45_000, 20_000]);
		expect(out).toEqual({ kind: 'unreachable' });
	});
});

describe('parsePairingTarget', () => {
	it('accepts bare origins only', () => {
		expect(parsePairingTarget('https://A.Example/')).toEqual({
			origin: 'https://a.example',
			host: 'a.example',
			hidden: false
		});
		expect(parsePairingTarget(`http://${A_ONION}`)?.hidden).toBe(true);
		expect(parsePairingTarget('http://peer.b32.i2p')?.hidden).toBe(true);
		expect(parsePairingTarget('http://a.example')).toBeNull();
		expect(parsePairingTarget('https://a.example/x')).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Wave 2 (verifier V4): silent targets must not starve healthy ones. A forward
// to a registered instance that never answers holds its slot for the whole
// attempt; eight of them used to hold every in-flight slot, so every other
// user's cross-instance sign-in got 429 for a minute at a time — sustainable
// at ~10 requests/min, under every per-client and per-target limit, and over
// Tor every visitor shares one client key.
describe('one slow target cannot starve the healthy ones', () => {
	const GOOD = `${'q'.repeat(56)}.onion`;
	const silent: Array<() => void> = [];
	afterEach(() => {
		for (const r of silent.splice(0)) r();
	});

	/** B with a directory where every queried host exists, its probe status
	 *  chosen by `statusOf`, and a hidden transport that never answers for
	 *  hosts `stalls` names. Records each attempt's timeout budget. */
	function bWith(statusOf: (host: string) => string, stalls: (host: string) => boolean) {
		const budgets: Array<{ host: string; t: number }> = [];
		const app = pairingForwardRoute({
			db: {
				async query(_sql: string, params?: readonly unknown[]) {
					const host = String(params?.[0]);
					return { rows: [row(`http://${host}`, null, statusOf(host))] } as never;
				}
			},
			self: selfPairingAddresses([B_ORIGIN]),
			proxies: { torSocks: '127.0.0.1:9', i2pHttpProxy: '' },
			deliverLocal: () => 'ok',
			postHidden: (url, _b, _p, t) => {
				const host = new URL(url).hostname;
				budgets.push({ host, t });
				if (!stalls(host)) return Promise.resolve({ status: 200, body: '{}' });
				return new Promise((res) => silent.push(() => res({ status: 504, body: '' })));
			},
			postClearnet: async () => {
				throw new Error('no clearnet here');
			}
		});
		return { app, budgets };
	}
	const post = (app: Hono, host: string) => {
		const pid = newPid();
		const text = JSON.stringify({ target: `http://${host}`, pid, delivery: delivery(pid) });
		return app.request('/forward', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: text
		});
	};
	// Let the fire-and-forget forwards reach their (stubbed, never-answering)
	// dials. Event-loop turns, not wall-clock time — no real-time waits in tests.
	const settle = async () => {
		for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
	};
	const onion = (c: string) => `${c.repeat(56)}.onion`;

	it('V4: eight forwards to a silent UNREACHABLE instance, then a healthy one succeeds', async () => {
		const DEAD = onion('d');
		const b = bWith(
			(h) => (h === DEAD ? 'unreachable' : 'good'),
			(h) => h === DEAD
		);
		for (let i = 0; i < 8; i++) void post(b.app, DEAD);
		await settle();
		const r = await post(b.app, GOOD);
		expect(r.status, await r.clone().text()).toBe(200);
	});

	it('eight forwards to a silent instance the probe calls GOOD, then a healthy one succeeds', async () => {
		const SLOW = onion('s');
		const b = bWith(
			() => 'good',
			(h) => h === SLOW
		);
		const extra: Response[] = [];
		const held = Array.from({ length: 8 }, () => post(b.app, SLOW));
		await settle();
		const r = await post(b.app, GOOD);
		expect(r.status, await r.clone().text()).toBe(200);
		// The slow instance holds at most its own two slots; the rest are refused
		// at once, not queued.
		expect(b.budgets.filter((x) => x.host === SLOW)).toHaveLength(2);
		for (const s of silent.splice(0)) s();
		for (const h of held) extra.push(await h);
		expect(extra.filter((x) => x.status === 429)).toHaveLength(6);
	});

	it('forty forwards spread over twenty silent unverified instances cannot starve a healthy one', async () => {
		const dead = Array.from({ length: 20 }, (_, i) =>
			`${String(i).padStart(2, '0')}${'x'.repeat(54)}.onion`.replace(
				/[0-9]/g,
				(d) => 'abcdefghij'[Number(d)]!
			)
		);
		const b = bWith(
			(h) => (dead.includes(h) ? 'never' : 'good'),
			(h) => dead.includes(h)
		);
		for (let i = 0; i < 40; i++) void post(b.app, dead[i % dead.length]!);
		await settle();
		const r = await post(b.app, GOOD);
		expect(r.status, await r.clone().text()).toBe(200);
	});

	it('an instance the probe could not reach gets a short budget, not the full hidden one', async () => {
		const DEAD = onion('d');
		const b = bWith(
			(h) => (h === DEAD ? 'stale' : 'good'),
			() => false
		);
		expect((await post(b.app, DEAD)).status).toBe(200);
		expect((await post(b.app, GOOD)).status).toBe(200);
		const t = Object.fromEntries(b.budgets.map((x) => [x.host, x.t]));
		expect(t[DEAD]).toBeLessThanOrEqual(15_000);
		expect(t[GOOD]).toBe(45_000);
	});
});
