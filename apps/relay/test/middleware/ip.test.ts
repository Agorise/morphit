/**
 * C1 regression suite — clientIp extraction.
 *
 * `apps/relay/src/middleware/ip.ts` decides what address each request
 * is bucket-keyed under for rate limiting. A bug here silently
 * breaks every per-IP defense (signup-burst limiter, daily limiter,
 * spacing, ALTCHA-trigger counter). This suite locks the security-
 * critical branches in place.
 */

import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';

import { clientIp, canonicalBucketKey } from '../../src/middleware/ip.ts';

/** Build a minimal Hono Context stand-in that exposes the fields
 *  clientIp() reads.  Real Hono adds many more fields; we only mock
 *  what's used. */
function ctx(opts: { peer?: string | null; xff?: string; xri?: string }): Context {
	const headers: Record<string, string> = {};
	if (opts.xff) headers['x-forwarded-for'] = opts.xff;
	if (opts.xri) headers['x-real-ip'] = opts.xri;
	return {
		env: opts.peer === null ? undefined : { incoming: { socket: { remoteAddress: opts.peer } } },
		req: {
			header: (name: string) => headers[name.toLowerCase()]
		}
	} as unknown as Context;
}

describe('clientIp — IP extraction trust boundary', () => {
	describe('direct connection from non-loopback', () => {
		it('returns the socket peer, ignoring forged forwarded headers', () => {
			const c = ctx({
				peer: '203.0.113.7',
				xff: '1.2.3.4', // forged
				xri: '5.6.7.8' // forged
			});
			expect(clientIp(c)).toBe('203.0.113.7');
		});

		it('returns peer even when only X-Real-IP is present', () => {
			const c = ctx({ peer: '203.0.113.7', xri: '1.1.1.1' });
			expect(clientIp(c)).toBe('203.0.113.7');
		});
	});

	describe('connection from loopback (trusted proxy)', () => {
		it('honors X-Forwarded-For from 127.0.0.1', () => {
			const c = ctx({ peer: '127.0.0.1', xff: '198.51.100.42' });
			expect(clientIp(c)).toBe('198.51.100.42');
		});

		it('honors X-Forwarded-For from ::1', () => {
			const c = ctx({ peer: '::1', xff: '198.51.100.42' });
			expect(clientIp(c)).toBe('198.51.100.42');
		});

		it('honors X-Forwarded-For from ::ffff:127.0.0.1 (IPv4-mapped IPv6)', () => {
			const c = ctx({ peer: '::ffff:127.0.0.1', xff: '198.51.100.42' });
			expect(clientIp(c)).toBe('198.51.100.42');
		});

		it('takes only the leftmost entry from a multi-hop XFF', () => {
			// nginx → another proxy → us; leftmost is the original
			// client.
			const c = ctx({
				peer: '127.0.0.1',
				xff: '198.51.100.42, 10.0.0.5, 10.0.0.6'
			});
			expect(clientIp(c)).toBe('198.51.100.42');
		});

		it('falls back to X-Real-IP when XFF is absent', () => {
			const c = ctx({ peer: '127.0.0.1', xri: '198.51.100.99' });
			expect(clientIp(c)).toBe('198.51.100.99');
		});

		it('falls back to peer when both forwarded headers are absent', () => {
			const c = ctx({ peer: '127.0.0.1' });
			expect(clientIp(c)).toBe('127.0.0.1');
		});
	});

	describe('hostile / malformed input', () => {
		it('rejects 65+ char forged XFF (length cap defense)', () => {
			// An attacker on loopback (e.g. unauthenticated dev machine
			// or compromised co-located service) could try to bloat the
			// rate-limiter bucket map by sending huge XFF values. The
			// length cap rejects them, and we fall back to the peer
			// (which IS loopback in this scenario).
			const huge = 'a'.repeat(65);
			const c = ctx({ peer: '127.0.0.1', xff: huge });
			expect(clientIp(c)).toBe('127.0.0.1');
		});

		it('rejects 65+ char X-Real-IP', () => {
			const huge = 'a'.repeat(65);
			const c = ctx({ peer: '127.0.0.1', xri: huge });
			expect(clientIp(c)).toBe('127.0.0.1');
		});

		it('handles XFF with a leading comma (empty leftmost entry)', () => {
			const c = ctx({
				peer: '127.0.0.1',
				xff: ', 198.51.100.42'
			});
			// Empty leftmost — null parse — falls through to X-Real-IP
			// (absent here) → falls back to peer.
			expect(clientIp(c)).toBe('127.0.0.1');
		});

		it('strips IPv6 brackets from peer addr', () => {
			// Some adapters report ::1 as [::1] — strip brackets so the
			// loopback-set membership check works.
			const c = ctx({ peer: '[::1]', xff: '198.51.100.42' });
			expect(clientIp(c)).toBe('198.51.100.42');
		});
	});

	describe('missing context', () => {
		it("returns 'unknown' when no socket info is present", () => {
			// Test harness or non-Node adapter — degrade to a single
			// shared bucket rather than fabricating a fake IP.
			const c = ctx({ peer: null });
			expect(clientIp(c)).toBe('unknown');
		});
	});
});

describe('canonicalBucketKey — prefix bucketing for rate limits', () => {
	describe('IPv4 → /24 bucketing', () => {
		it('collapses different addresses in the same /24 to one key', () => {
			expect(canonicalBucketKey('192.0.2.55')).toBe('192.0.2.0/24');
			expect(canonicalBucketKey('192.0.2.200')).toBe('192.0.2.0/24');
		});

		it('keeps different /24s in separate buckets', () => {
			const a = canonicalBucketKey('192.0.2.55');
			const b = canonicalBucketKey('192.0.3.55');
			expect(a).not.toBe(b);
			expect(a).toBe('192.0.2.0/24');
			expect(b).toBe('192.0.3.0/24');
		});

		it('handles edge values (0.0.0.0, 255.255.255.255)', () => {
			expect(canonicalBucketKey('0.0.0.0')).toBe('0.0.0.0/24');
			expect(canonicalBucketKey('255.255.255.255')).toBe('255.255.255.0/24');
		});

		it('rejects out-of-range octets, returning verbatim', () => {
			// 999.0.0.0 isn't valid IPv4 — fall through (don't fabricate
			// a bucket from invalid input).
			expect(canonicalBucketKey('999.0.0.0')).toBe('999.0.0.0');
		});
	});

	describe('IPv4-mapped IPv6 (::ffff:1.2.3.4) → /24 bucketing', () => {
		it('extracts the IPv4 portion and buckets to /24', () => {
			expect(canonicalBucketKey('::ffff:192.0.2.55')).toBe('192.0.2.0/24');
			expect(canonicalBucketKey('::ffff:192.0.2.200')).toBe('192.0.2.0/24');
		});
	});

	describe('IPv6 → /64 bucketing', () => {
		it('collapses different addresses in the same /64 to one key', () => {
			const a = canonicalBucketKey('2001:db8:1:2::1');
			const b = canonicalBucketKey('2001:db8:1:2:a:b:c:d');
			expect(a).toBe(b);
			expect(a).toBe('2001:db8:1:2::/64');
		});

		it('keeps different /64s in separate buckets', () => {
			const a = canonicalBucketKey('2001:db8:1:2::1');
			const b = canonicalBucketKey('2001:db8:1:3::1');
			expect(a).not.toBe(b);
		});

		it('normalizes hex casing and leading zeros', () => {
			// Same /64, different string forms.
			const a = canonicalBucketKey('2001:DB8:0001:0002::1');
			const b = canonicalBucketKey('2001:db8:1:2::ffff');
			expect(a).toBe(b);
			expect(a).toBe('2001:db8:1:2::/64');
		});

		it('handles "::" expansion correctly', () => {
			// Trailing "::" — the /64 prefix is the leading hextets.
			expect(canonicalBucketKey('2001:db8::')).toBe('2001:db8:0:0::/64');
			// Leading "::" — prefix is mostly zeros.
			expect(canonicalBucketKey('::1')).toBe('::1'); // loopback preserved verbatim
		});

		it('rejects malformed IPv6, returning verbatim', () => {
			// Two "::" sequences is invalid IPv6.
			expect(canonicalBucketKey('2001::db8::1')).toBe('2001::db8::1');
		});
	});

	describe('special values preserved', () => {
		it('preserves loopback addresses unchanged so trusted-peer logic still works', () => {
			expect(canonicalBucketKey('127.0.0.1')).toBe('127.0.0.1');
			expect(canonicalBucketKey('::1')).toBe('::1');
			expect(canonicalBucketKey('::ffff:127.0.0.1')).toBe('::ffff:127.0.0.1');
		});

		it("preserves 'unknown' (test/non-Node-adapter sentinel)", () => {
			expect(canonicalBucketKey('unknown')).toBe('unknown');
		});

		it('preserves empty string verbatim', () => {
			expect(canonicalBucketKey('')).toBe('');
		});
	});
});
