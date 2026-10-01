/**
 * v1.20.2 — /compare's peer orderbook, fetched by the visitor's OWN instance
 * (api/compareOrderbook.ts). The browser could not fetch it: every instance's
 * CSP `connect-src` allows only 'self' and the RPC nodes ("Failed to fetch",
 * morphit.io → timeapp, 2026-10-01).
 *
 * Unit tests inject the fetcher; the hidden path is also run for REAL: a peer
 * HTTP server reached through a SOCKS5 stand-in for Tor, through the real
 * fetchJsonViaHiddenService, with a page larger than its default 256 KB cap.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { Hono } from 'hono';
import { ProxyUnavailableError, type HiddenServiceProxyConfig } from '@morphit/hidden-transport';

import {
	CACHE_MS,
	PEER_PAGE_LIMIT,
	compareOrderbookRoute,
	validatePeerOrderbook,
	type GetJson
} from '$api/compareOrderbook';
import { ForwardBudget, selfPairingAddresses } from '$api/pairingForward';
import { rateLimit, _resetRateLimitForTest } from '$api/middleware/ratelimit';
import { closePool } from '$indexer/hiddenServicePool';
import type { FastFederationDb } from '$indexer/chatFastFederation';
import type { OrderbookResponse, OrderRecord } from '@morphit/indexer-client';

const A_ORIGIN = 'https://a.example';
const A_ONION = `${'a'.repeat(56)}.onion`;
const B_ORIGIN = 'https://b.example';
const NO_PROXIES: HiddenServiceProxyConfig = { torSocks: '', i2pHttpProxy: '' };

const closers: (() => void | Promise<void>)[] = [];
afterAll(async () => {
	for (const c of closers.splice(0)) await c();
	await closePool();
});
beforeAll(() => _resetRateLimitForTest());
afterEach(() => _resetRateLimitForTest());

interface Row {
	origin: string;
	reg_alt_networks: Record<string, string | null> | null;
	last_probe_status: string | null;
	last_probed_at: null;
	registered_at_time: Date;
	last_probe_error: null;
}
const row = (origin: string, alt: Record<string, string> | null = null, status = 'good'): Row => ({
	origin,
	reg_alt_networks: alt,
	last_probe_status: status,
	last_probed_at: null,
	registered_at_time: new Date('2026-01-01T00:00:00Z'),
	last_probe_error: null
});
const directory = (rows: Row[]): FastFederationDb => ({
	async query() {
		return { rows: rows.filter((r) => r.last_probe_status !== 'mismatch') } as never;
	}
});

const order = (i: number) => ({
	account: `user${i}`,
	permlink: `order-${i}`,
	status: 'live',
	side: 'sell',
	asset: 'BLURT',
	fiat_currency: 'EUR',
	updated_at: '2026-10-01T06:11:05.968Z'
});
// Typed with the SHARED wire type, so a wrong field name fails typecheck
// (v1.20.2: the first draft read `orders`; the API sends `items`).
const page = (n: number, extra: Record<string, unknown> = {}) => {
	const p: OrderbookResponse = {
		items: Array.from({ length: n }, (_, i) => order(i)) as unknown as OrderRecord[],
		indexed_block: 64120689,
		next_cursor: null
	};
	return { ...p, ...extra };
};

function startB(opts: {
	rows: Row[];
	getJson?: GetJson;
	proxies?: HiddenServiceProxyConfig;
	now?: () => number;
	budget?: ForwardBudget;
	onJoin?: () => void;
}) {
	const calls: { url: string; hidden: boolean; timeoutMs: number }[] = [];
	const app = new Hono();
	const compare = new Hono();
	compare.use('*', rateLimit('list', 600));
	compare.route(
		'/',
		compareOrderbookRoute({
			db: directory(opts.rows),
			self: selfPairingAddresses([B_ORIGIN]),
			proxies: opts.proxies ?? NO_PROXIES,
			...(opts.getJson
				? {
						getJson: async (url, hidden, p, t) => {
							calls.push({ url, hidden, timeoutMs: t });
							return opts.getJson!(url, hidden, p, t);
						}
					}
				: {}),
			...(opts.now ? { now: opts.now } : {}),
			...(opts.budget ? { budget: opts.budget } : {}),
			...(opts.onJoin ? { onJoin: opts.onJoin } : {})
		})
	);
	app.route('/v1/compare', compare);
	const ask = async (origin: string) => {
		const res = await app.request(`/v1/compare/orderbook?origin=${encodeURIComponent(origin)}`);
		return { status: res.status, json: (await res.json()) as Record<string, unknown> };
	};
	return { ask, calls };
}

describe('validatePeerOrderbook — only what the compare page needs is passed on', () => {
	it('keeps orders with a string account + permlink, drops the rest and every other key', () => {
		const v = validatePeerOrderbook({
			items: [order(1), { account: 'x' }, 'junk', null, order(2)],
			indexed_block: 5,
			next_cursor: 'c1',
			injected: '<script>'
		});
		expect(v).toEqual({ items: [order(1), order(2)], indexed_block: 5, next_cursor: 'c1' });
	});
	it('at most one page of orders; nonsense block/cursor become null; not an orderbook → null', () => {
		const v = validatePeerOrderbook(page(150, { indexed_block: -1, next_cursor: 7 }));
		expect(v?.items).toHaveLength(PEER_PAGE_LIMIT);
		expect(v?.indexed_block).toBeNull();
		expect(v?.next_cursor).toBeNull();
		expect(validatePeerOrderbook('<html>')).toBeNull();
		expect(validatePeerOrderbook({ items: 'x' })).toBeNull();
		// the field the first draft wrongly read is not an orderbook
		expect(validatePeerOrderbook({ orders: [order(1)] })).toBeNull();
	});
});

describe('GET /v1/compare/orderbook', () => {
	it('a registered peer: fetched by THIS instance over its registered origin, one path', async () => {
		const b = startB({ rows: [row(A_ORIGIN)], getJson: async () => page(3, { evil: 1 }) });
		const r = await b.ask('https://a.example/');
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ status: 'ok', origin: A_ORIGIN, ...page(3) });
		expect(b.calls).toEqual([
			{ url: 'https://a.example/v1/orderbook?limit=100', hidden: false, timeoutMs: 12_000 }
		]);
	});
	it('an origin that is not a registered instance is refused before any network activity', async () => {
		const b = startB({ rows: [row(A_ORIGIN)], getJson: async () => page(1) });
		const r = await b.ask('https://evil.example');
		expect(r.status).toBe(404);
		expect(r.json.reason).toBe('unknown_instance');
		expect(b.calls).toHaveLength(0);
	});
	it('a probe-`mismatch` registration (someone else’s site) counts as unknown', async () => {
		const b = startB({ rows: [row(A_ORIGIN, null, 'mismatch')], getJson: async () => page(1) });
		expect((await b.ask(A_ORIGIN)).json.reason).toBe('unknown_instance');
		expect(b.calls).toHaveLength(0);
	});
	it('this instance itself, a path, a query or credentials: refused', async () => {
		const b = startB({ rows: [row(A_ORIGIN), row(B_ORIGIN)], getJson: async () => page(1) });
		expect((await b.ask(B_ORIGIN)).json.reason).toBe('same_instance');
		for (const bad of [
			'https://a.example/v1/orderbook',
			'https://a.example/?x=1',
			'https://u:p@a.example',
			'http://a.example',
			'javascript:alert(1)'
		]) {
			const r = await b.ask(bad);
			expect(r.status, bad).toBe(400);
			expect(r.json.reason, bad).toBe('bad_target');
		}
		expect(b.calls).toHaveLength(0);
	});
	it('an unreachable peer and a non-orderbook answer say so', async () => {
		const down = startB({
			rows: [row(A_ORIGIN)],
			getJson: async () => {
				throw new Error('connect ETIMEDOUT');
			}
		});
		expect(await down.ask(A_ORIGIN)).toMatchObject({
			status: 502,
			json: { reason: 'target_unreachable' }
		});
		const weird = startB({ rows: [row(A_ORIGIN)], getJson: async () => ({ hello: 'world' }) });
		expect(await weird.ask(A_ORIGIN)).toMatchObject({
			status: 502,
			json: { reason: 'target_bad_answer' }
		});
	});
	it('a crowd costs the peer one request per 30 s: cached, and concurrent asks share one fetch', async () => {
		let t = 1_000_000;
		// The peer answers only once BOTH followers have joined the first
		// fetch — deterministic, no clock: a route that did not share the fetch
		// would never release it (and the test would time out).
		let joins = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const b = startB({
			rows: [row(A_ORIGIN)],
			now: () => t,
			onJoin: () => {
				if (++joins === 2) release();
			},
			getJson: async () => {
				await gate;
				return page(2);
			}
		});
		const together = Promise.all([b.ask(A_ORIGIN), b.ask(A_ORIGIN), b.ask(A_ORIGIN)]);
		const rs = await together;
		expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
		expect(b.calls).toHaveLength(1);
		expect(joins).toBe(2);
		t += CACHE_MS - 1;
		expect((await b.ask(A_ORIGIN)).status).toBe(200);
		expect(b.calls).toHaveLength(1);
		t += 2;
		expect((await b.ask(A_ORIGIN)).status).toBe(200);
		expect(b.calls).toHaveLength(2);
	});
	it('per-target budget: refused with 429 once spent', async () => {
		let t = 0;
		const b = startB({
			rows: [row(A_ORIGIN)],
			now: () => t,
			budget: new ForwardBudget({ perTargetPerMin: 1, perTargetInFlightMax: 1 }),
			getJson: async () => page(1)
		});
		expect((await b.ask(A_ORIGIN)).status).toBe(200);
		t += CACHE_MS + 1;
		const r = await b.ask(A_ORIGIN);
		expect(r.status).toBe(429);
		expect(r.json.reason).toBe('compare_rate_limited');
	});
	it('Tor configured but its daemon down: the onion is skipped and the clearnet origin is used', async () => {
		const b = startB({
			rows: [row(A_ORIGIN, { tor: A_ONION })],
			proxies: { torSocks: '127.0.0.1:9050', i2pHttpProxy: '' },
			getJson: async (url, hidden) => {
				if (hidden) throw new ProxyUnavailableError('Tor SOCKS proxy not configured');
				return page(1);
			}
		});
		const r = await b.ask(A_ORIGIN);
		expect(r.status).toBe(200);
		expect(b.calls.map((c) => c.hidden)).toEqual([true, false]);
		expect(b.calls[0]!.url).toBe(`http://${A_ONION}/v1/orderbook?limit=100`);
	});
});

// ─── the real hidden path ────────────────────────────────────────────────────
async function fakeTor(targetPort: number): Promise<{ port: number; asked: string[] }> {
	const asked: string[] = [];
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
	closers.push(() => new Promise<void>((r) => srv.close(() => r())));
	return { port: (srv.address() as net.AddressInfo).port, asked };
}

describe('the real hidden transport', () => {
	it('a hidden-only peer’s full page (bigger than the probe’s 256 KB cap) arrives over its onion', async () => {
		const paths: string[] = [];
		// ~4 KB an order: 100 of them ≈ 400 KB
		const big = {
			items: Array.from({ length: 100 }, (_, i) => ({ ...order(i), terms: 'x'.repeat(4000) })),
			indexed_block: 64120689,
			next_cursor: 'next'
		};
		const body = JSON.stringify(big);
		expect(body.length).toBeGreaterThan(256 * 1024);
		const srv = http.createServer((req, res) => {
			paths.push(req.url ?? '');
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(body);
		});
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		closers.push(() => {
			srv.closeAllConnections?.();
			return new Promise<void>((r) => srv.close(() => r()));
		});
		const tor = await fakeTor((srv.address() as net.AddressInfo).port);
		const onionOnly = `http://${A_ONION}`;
		const b = startB({
			rows: [row(onionOnly)],
			proxies: { torSocks: `127.0.0.1:${tor.port}`, i2pHttpProxy: '' }
		});
		const r = await b.ask(onionOnly);
		expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
		expect((r.json.items as unknown[]).length).toBe(100);
		expect(r.json.next_cursor).toBe('next');
		expect(tor.asked).toEqual([A_ONION]);
		expect(paths).toEqual(['/v1/orderbook?limit=100']);
	}, 30_000);
});
