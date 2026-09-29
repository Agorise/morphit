/**
 * v1.20.0 fix wave, E2 — the indexer's per-IP limiter behind the shipped
 * BunkerWeb frontend.
 *
 * The frontend container (172.20.0.x on bunkerweb_net) is the socket peer of
 * EVERY request on a BunkerWeb box — clearnet, Tor and I2P alike. The limiter
 * honoured forwarded-address headers only from a LOOPBACK peer, so there it
 * keyed every visitor on the container's address: one bucket for the whole
 * instance, 120 list requests a minute shared by everyone, and ten requests a
 * second from anyone 429'd every write. Proven on the real middleware.
 *
 * The contract (agreed with the proxy side, scratchpad requests E-from-C):
 *   - the frontend sends ONE `X-Forwarded-For` entry and no X-Real-IP;
 *   - bare-metal nginx (loopback peer) sends `X-Real-IP $remote_addr`;
 *   - forwarded headers are believed only from a trusted peer (loopback +
 *     172.16.0.0/12 by default — Docker's default bridge pool, v1.20.0 wave 4 —
 *     or MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS);
 *   - X-Forwarded-For is read from the RIGHT, skipping trusted hops;
 *   - all-trusted (Tor/I2P via the bridge gateway) shares one bucket.
 *
 * Drives the real middleware through Hono with the socket peer the Node
 * adapter would report.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
	rateLimit,
	configureTrustedProxies,
	_resetRateLimitForTest
} from '../../src/api/middleware/ratelimit';

const LIMIT = 120;
function app(): Hono {
	const a = new Hono();
	a.get('/x', rateLimit('list', LIMIT), (c) => c.json({ ok: true }));
	return a;
}
async function statuses(
	peer: string,
	headersFor: (i: number) => Record<string, string>,
	n = LIMIT + 10
): Promise<{ ok: number; limited: number }> {
	const a = app();
	let ok = 0;
	let limited = 0;
	for (let i = 0; i < n; i++) {
		const res = await a.request(
			'/x',
			{ headers: headersFor(i) },
			{
				incoming: { socket: { remoteAddress: peer } }
			}
		);
		if (res.status === 429) limited++;
		else ok++;
	}
	return { ok, limited };
}
const visitor = (i: number): string => `203.0.113.${(i % 250) + 1}`;

describe('indexer rate limit behind a trusted reverse proxy (E2)', () => {
	beforeEach(() => {
		_resetRateLimitForTest();
		configureTrustedProxies(undefined);
	});

	it('BunkerWeb frontend peer: one bucket PER VISITOR, not one for the whole instance', async () => {
		const r = await statuses('172.20.0.5', (i) => ({ 'x-forwarded-for': visitor(i) }));
		expect(r.limited, 'distinct visitors behind the frontend shared one bucket').toBe(0);
	});

	it('…and one visitor is still limited', async () => {
		const r = await statuses('172.20.0.5', () => ({ 'x-forwarded-for': '198.51.100.7' }));
		expect(r.limited).toBe(10);
	});

	it('a visitor cannot type their way to a fresh bucket: the RIGHTMOST untrusted entry counts', async () => {
		const r = await statuses('172.20.0.5', (i) => ({
			'x-forwarded-for': `${visitor(i)}, 198.51.100.8, 172.20.0.3`
		}));
		expect(r.limited).toBe(10);
	});

	it('X-Real-IP from a non-loopback proxy is ignored (the frontend never sets it)', async () => {
		const r = await statuses('172.20.0.5', (i) => ({
			'x-real-ip': visitor(i),
			'x-forwarded-for': '198.51.100.9'
		}));
		expect(r.limited).toBe(10);
	});

	it('Tor/I2P through the bridge gateway (every hop trusted) share one bucket, as documented', async () => {
		const r = await statuses('172.20.0.5', () => ({ 'x-forwarded-for': '172.20.0.1' }));
		expect(r.limited).toBe(10);
	});

	it('bare-metal nginx (loopback): X-Real-IP is the client — unchanged', async () => {
		const r = await statuses('127.0.0.1', (i) => ({
			'x-real-ip': visitor(i),
			'x-forwarded-for': `6.6.6.6, ${visitor(i)}`
		}));
		expect(r.limited).toBe(0);
	});

	it('an UNTRUSTED peer’s headers are ignored (Finding B)', async () => {
		const r = await statuses('198.51.100.200', (i) => ({
			'x-forwarded-for': visitor(i),
			'x-real-ip': visitor(i)
		}));
		expect(r.limited).toBe(10);
	});

	it('the operator can narrow the trusted set: without 172.16/12 the frontend is untrusted again', async () => {
		configureTrustedProxies(['127.0.0.0/8', '::1/128']);
		const r = await statuses('172.20.0.5', (i) => ({ 'x-forwarded-for': visitor(i) }));
		expect(r.limited).toBe(10);
	});
});
