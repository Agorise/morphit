/**
 * v1.20.0 fix wave 4 (verifier P1) — the per-client stream cap must never
 * become a cap on the whole site.
 *
 * morphit.io's Docker bridge is 172.18.0.0/24, not the 172.20.0.0/16 the
 * ansible role pins. With only 172.20/16 trusted, the frontend container was
 * an UNTRUSTED peer there, every visitor was keyed on its one address, and the
 * per-client cap of 24 open streams applied to everyone at once: 40 visitors,
 * 16 of them refused with 503.
 *
 * Two fixes, each guarded here:
 *   1. the default trusted set is Docker's whole default bridge pool,
 *      172.16.0.0/12 (172.16–172.31), not one pinned /16;
 *   2. FAIL SAFE — a private peer outside the trusted set that forwards a
 *      client address is a proxy nobody told us about. Its address stands for
 *      everyone behind it, so only the instance-wide cap applies to it. A
 *      PUBLIC peer gains nothing by sending the same headers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireStreamSlot, _resetStreamCapsForTest } from '../../src/api/streamCaps';
import {
	configureTrustedProxies,
	requestClient,
	_resetRateLimitForTest
} from '../../src/api/middleware/ratelimit';

/** What the indexer sees behind the BunkerWeb frontend: socket peer = the
 *  frontend container; X-Forwarded-For = the visitor; X-Real-IP cleared. */
const ctx = (peer: string, headers: Record<string, string>) =>
	({
		env: { incoming: { socket: { remoteAddress: peer } } },
		req: { header: (n: string) => headers[n.toLowerCase()] }
	}) as never;

/** 40 different visitors, one stream each, through `peer`. */
function open40(peer: string, headersFor: (v: number) => Record<string, string>) {
	let accepted = 0;
	let refused = 0;
	const release: Array<() => void> = [];
	for (let v = 1; v <= 40; v++) {
		const r = acquireStreamSlot(ctx(peer, headersFor(v)));
		if (r) {
			accepted++;
			release.push(r);
		} else refused++;
	}
	for (const r of release) r();
	return { accepted, refused };
}

const viaFrontend = (v: number) => ({ 'x-forwarded-for': `198.51.100.${v}`, 'x-real-ip': '' });

describe('per-client stream cap behind a proxy (verifier P1)', () => {
	beforeEach(() => {
		_resetStreamCapsForTest();
		_resetRateLimitForTest();
		configureTrustedProxies(undefined); // MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS unset
	});
	afterEach(() => {
		_resetStreamCapsForTest();
		configureTrustedProxies(undefined);
	});

	it("morphit.io's frontend on 172.18.0.0/24 is trusted by default: 40 visitors, 40 streams", () => {
		const r = open40('172.18.0.3', viaFrontend);
		expect(r, 'the whole site shared one per-client stream cap').toEqual({
			accepted: 40,
			refused: 0
		});
		// And each visitor is told apart (the rate limiter keys the same way).
		expect(requestClient(ctx('172.18.0.3', viaFrontend(7)))).toEqual({
			key: '198.51.100.7',
			shared: false
		});
	});

	it('a frontend that forwards only BunkerWeb’s own bridge address (its geo pinned to another subnet) shares, not caps', () => {
		// ops/bunkerweb/frontend/nginx.conf sends $remote_addr when the peer is not
		// in its pinned 172.20/16 — on a 172.18 bridge, BunkerWeb's container.
		expect(open40('172.18.0.3', () => ({ 'x-forwarded-for': '172.18.0.2' }))).toEqual({
			accepted: 40,
			refused: 0
		});
	});

	it('the pinned ansible bridge (172.20/16) and the rest of 172.16/12 still count as ours', () => {
		for (const peer of ['172.20.0.5', '172.17.0.2', '172.31.255.254']) {
			expect(open40(peer, viaFrontend), peer).toEqual({ accepted: 40, refused: 0 });
		}
	});

	it('FAIL SAFE: an untrusted PRIVATE proxy forwarding a client address gets only the instance-wide cap', () => {
		// The operator narrowed the trusted set, or runs a proxy on a range the
		// default does not cover (a 192.168 LAN reverse proxy, a 10.x Docker pool).
		configureTrustedProxies(['127.0.0.0/8']);
		for (const peer of ['172.18.0.3', '192.168.1.20', '10.8.0.4', 'fd00::5', '::ffff:10.1.2.3']) {
			expect(open40(peer, viaFrontend), peer).toEqual({ accepted: 40, refused: 0 });
			expect(requestClient(ctx(peer, viaFrontend(1))).shared, peer).toBe(true);
		}
		// X-Real-IP alone (bare-metal nginx style) is a forwarded address too.
		expect(
			open40('192.168.1.20', (v) => ({ 'x-real-ip': `198.51.100.${v}` })),
			'X-Real-IP from a private proxy'
		).toEqual({ accepted: 40, refused: 0 });
	});

	it('a private peer that forwards nothing is a client like any other: capped at 24', () => {
		configureTrustedProxies(['127.0.0.0/8']);
		expect(open40('192.168.1.20', () => ({}))).toEqual({ accepted: 24, refused: 16 });
	});

	it('a PUBLIC peer gains nothing by sending forwarding headers: still capped at 24', () => {
		expect(open40('203.0.113.9', viaFrontend)).toEqual({ accepted: 24, refused: 16 });
		expect(requestClient(ctx('203.0.113.9', viaFrontend(1)))).toEqual({
			key: '203.0.113.9',
			shared: false
		});
	});
});
