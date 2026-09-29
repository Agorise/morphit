/**
 * v1.20.0 wave 5 (D) — the relay's DEFAULT trusted-proxy set.
 *
 * Until wave 5 the code default was loopback only, and the installers pinned
 * 172.20.0.0/16 (the ansible compose subnet). morphit.io's Docker bridge is
 * 172.18.0.0/24: with no matching MORPHIT_RELAY_TRUSTED_PROXY_IPS the relay's
 * socket peer (the frontend container) is the "client" of EVERY request, so
 * the per-IP signup limits (2/day, spacing) apply to the whole site at once.
 *
 * Default now: loopback + 172.16.0.0/12 (Docker's default bridge pool), the
 * same as the indexer (MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS) and the frontend
 * nginx `geo $morphit_edge_peer`. A set env value REPLACES it (loopback stays).
 *
 * Header shapes are the ones ops/bunkerweb/frontend/nginx.conf produces:
 *   clearnet: X-Forwarded-For = BunkerWeb's X-Real-IP (one entry), X-Real-IP cleared;
 *   Tor/I2P : X-Forwarded-For = $remote_addr (bridge gateway, or 127.0.0.1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from 'hono';

import { canonicalBucketKey, clientIp, configureTrustedProxies } from '../../src/middleware/ip.ts';
import { Limiter } from '../../src/middleware/ratelimit.ts';

function ctx(peer: string, headers: { xff?: string; xri?: string }): Context {
	const h: Record<string, string | undefined> = {
		'x-forwarded-for': headers.xff,
		'x-real-ip': headers.xri
	};
	return {
		env: { incoming: { socket: { remoteAddress: peer } } },
		req: { header: (n: string) => h[n.toLowerCase()] }
	} as unknown as Context;
}

const bucket = (c: Context): string => canonicalBucketKey(clientIp(c));
const FRONTEND = '172.18.0.3'; // morphit.io's frontend container on 172.18.0.0/24
const GATEWAY = '172.18.0.1'; // its bridge gateway (Tor/I2P via the published 127.0.0.1 port)

afterEach(() => {
	configureTrustedProxies([]);
});

describe('default trusted set (no MORPHIT_RELAY_TRUSTED_PROXY_IPS)', () => {
	it('a 172.18 frontend peer with a proxy-written X-Forwarded-For yields DISTINCT buckets per visitor', () => {
		configureTrustedProxies([]);
		const a = bucket(ctx(FRONTEND, { xff: '203.0.113.7' }));
		const b = bucket(ctx(FRONTEND, { xff: '198.51.100.9' }));
		expect(a).toBe('203.0.113.0/24');
		expect(b).toBe('198.51.100.0/24');
		expect(a).not.toBe(b);
	});

	it('two real visitors behind morphit.io each get their own 2/day allowance (not one for the site)', () => {
		const daily = new Limiter(2, 24 * 3600_000);
		let allowed = 0;
		for (const v of ['203.0.113.7', '198.51.100.9']) {
			for (let i = 0; i < 3; i++) if (daily.allow(bucket(ctx(FRONTEND, { xff: v })))) allowed++;
		}
		expect(allowed).toBe(4);
	});

	it('the module default (never configured) already trusts the Docker pool', async () => {
		const { vi } = await import('vitest');
		vi.resetModules();
		const fresh = await import('../../src/middleware/ip.ts');
		expect(
			fresh.canonicalBucketKey(fresh.clientIp(ctx('172.31.255.2', { xff: '203.0.113.7' })))
		).toBe('203.0.113.0/24');
	});

	it('Tor/I2P through the frontend (XFF = gateway) share ONE bucket; a typed X-Real-IP cannot pick one', () => {
		const keys = new Set<string>();
		for (let i = 0; i < 20; i++) {
			keys.add(bucket(ctx(FRONTEND, { xff: GATEWAY, xri: `10.${i}.0.1` })));
			keys.add(bucket(ctx(FRONTEND, { xff: '127.0.0.1', xri: `10.${i}.0.1` })));
		}
		expect([...keys].sort()).toEqual(['127.0.0.1', '172.18.0.0/24']);
	});

	it('a loopback-direct visitor (bare-metal nginx, X-Real-IP $remote_addr) cannot choose a bucket', () => {
		const keys = new Set<string>();
		for (let i = 0; i < 20; i++) {
			keys.add(bucket(ctx('127.0.0.1', { xff: `10.${i}.0.1, 127.0.0.1`, xri: '127.0.0.1' })));
		}
		expect([...keys]).toEqual(['127.0.0.1']);
	});

	it('a PUBLIC peer gains nothing from forwarded headers', () => {
		expect(bucket(ctx('198.51.100.20', { xff: '10.9.9.9', xri: '10.9.9.9' }))).toBe(
			'198.51.100.0/24'
		);
	});

	it('only 172.16.0.0/12 is added — 172.32.x, 192.168.x and 10.x peers are not trusted by default', () => {
		for (const peer of ['172.32.0.5', '192.168.1.5', '10.0.0.5', '172.15.255.1']) {
			expect(clientIp(ctx(peer, { xff: '203.0.113.7' }))).toBe(peer);
		}
	});

	it('blank entries (an empty env line) mean the default, not loopback-only', () => {
		configureTrustedProxies(['', '  ']);
		expect(clientIp(ctx(FRONTEND, { xff: '203.0.113.7' }))).toBe('203.0.113.7');
	});
});

describe('MORPHIT_RELAY_TRUSTED_PROXY_IPS set: it REPLACES the default (like the indexer)', () => {
	it('a 10.x override drops 172.16/12 and keeps loopback', () => {
		configureTrustedProxies(['10.0.0.0/8']);
		expect(clientIp(ctx(FRONTEND, { xff: '203.0.113.7' }))).toBe(FRONTEND);
		expect(clientIp(ctx('10.1.2.3', { xff: '203.0.113.7' }))).toBe('203.0.113.7');
		expect(clientIp(ctx('127.0.0.1', { xri: '203.0.113.7' }))).toBe('203.0.113.7');
	});

	it('the pinned installer value 172.20.0.0/16 keeps working unchanged', () => {
		configureTrustedProxies(['172.20.0.0/16']);
		expect(clientIp(ctx('172.20.0.3', { xff: '203.0.113.7' }))).toBe('203.0.113.7');
	});
});
