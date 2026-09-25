/**
 * (v1.18.0 deep-deep, H1) The relay must find the REAL client in the headers
 * our own proxies actually produce — not whatever the client typed.
 *
 * nginx's `$proxy_add_x_forwarded_for` is "the client's own X-Forwarded-For,
 * then $remote_addr". The relay used to take the leftmost entry, so a client
 * that rotated `X-Forwarded-For: 10.N.0.1` got a fresh rate-limit bucket on
 * every request and walked through the per-IP signup limits. These cases feed
 * the header shapes each shipped topology produces through the real clientIp,
 * canonicalBucketKey and Limiter.
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

const REAL = '203.0.113.7';

/** 20 requests from ONE real client, each with a different forged value,
 *  against a 2-per-day limit. Returns how many got through. */
function allowedOf20(build: (i: number) => Context): number {
	const daily = new Limiter(2, 24 * 3600_000);
	let allowed = 0;
	for (let i = 0; i < 20; i++) if (daily.allow(canonicalBucketKey(clientIp(build(i))))) allowed++;
	return allowed;
}

afterEach(() => {
	configureTrustedProxies([]);
});

describe('bare-metal nginx on this host (peer is loopback)', () => {
	it('a forged X-Forwarded-For under $proxy_add_x_forwarded_for does not buy a new bucket', () => {
		// Old web.conf /relay/: X-Real-IP $remote_addr; X-Forwarded-For $proxy_add_x_forwarded_for
		const n = allowedOf20((i) => ctx('127.0.0.1', { xff: `10.${i}.0.1, ${REAL}`, xri: REAL }));
		expect(n).toBe(2);
	});

	it('the same holds with only the appended X-Forwarded-For (no X-Real-IP)', () => {
		const n = allowedOf20((i) => ctx('127.0.0.1', { xff: `10.${i}.0.1, ${REAL}` }));
		expect(n).toBe(2);
	});

	it('a forged X-Forwarded-For with no XFF handling in nginx at all (relay.conf) is ignored', () => {
		// relay.conf sets only X-Real-IP; the client's XFF passes through as typed.
		const n = allowedOf20((i) => ctx('127.0.0.1', { xff: `10.${i}.0.1`, xri: REAL }));
		expect(n).toBe(2);
	});

	it('Tor/I2P visitors (nginx sees 127.0.0.1) share one bucket and cannot forge their way out', () => {
		const keys = new Set<string>();
		for (let i = 0; i < 20; i++) {
			keys.add(
				canonicalBucketKey(
					clientIp(ctx('127.0.0.1', { xff: `10.${i}.0.1, 127.0.0.1`, xri: '127.0.0.1' }))
				)
			);
		}
		expect([...keys]).toEqual(['127.0.0.1']);
	});
});

describe('BunkerWeb → frontend container → relay (peer is the Docker bridge)', () => {
	it('client-supplied entries left of the real client are ignored', () => {
		configureTrustedProxies(['172.20.0.0/16']);
		// BunkerWeb appends the real client; the frontend appends BunkerWeb's IP.
		const n = allowedOf20((i) =>
			ctx('172.20.0.3', { xff: `10.${i}.0.1, ${REAL}, 172.20.0.2`, xri: `10.${i}.9.9` })
		);
		expect(n).toBe(2);
	});

	it('a forged entry inside the trusted range does not help either', () => {
		configureTrustedProxies(['172.20.0.0/16']);
		expect(clientIp(ctx('172.20.0.3', { xff: `172.20.9.9, ${REAL}, 172.20.0.2` }))).toBe(REAL);
	});

	it('Tor/I2P via the frontend (XFF overwritten with the bridge gateway) is one shared bucket', () => {
		configureTrustedProxies(['172.20.0.0/16']);
		const keys = new Set<string>();
		for (let i = 0; i < 5; i++)
			keys.add(
				canonicalBucketKey(clientIp(ctx('172.20.0.3', { xff: '172.20.0.1', xri: `10.${i}.0.1` })))
			);
		expect(keys.size).toBe(1);
	});

	it('garbage the client wrote on the left is skipped, the proxy-written client is kept', () => {
		configureTrustedProxies(['172.20.0.0/16']);
		expect(clientIp(ctx('172.20.0.3', { xff: `not-an-ip, ${REAL}, 172.20.0.2` }))).toBe(REAL);
	});
});
