import { describe, expect, it, vi, afterEach } from 'vitest';

import { InviteTokenService } from '../src/policy/inviteToken.ts';
import { ManualClock } from '../src/policy/clock.ts';

describe('InviteTokenService', () => {
	const services: InviteTokenService[] = [];
	afterEach(() => {
		for (const s of services) s.close();
		services.length = 0;
		vi.useRealTimers();
	});

	function make(opts?: ConstructorParameters<typeof InviteTokenService>[0]) {
		const s = new InviteTokenService(opts);
		services.push(s);
		return s;
	}

	it('issue + verify round-trips for same IP', () => {
		const s = make();
		const { token } = s.issue('1.2.3.4');
		const result = s.verify(token, '1.2.3.4');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.payload.nonce).toMatch(/^[0-9a-f]{32}$/);
			expect(result.payload.ip_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(result.payload.exp).toBeGreaterThan(result.payload.iat);
		}
	});

	it('rejects tokens with tampered signature', () => {
		const s = make();
		const { token } = s.issue('1.2.3.4');
		// Flip a character in the signature (after the '.')
		const [payload, sig] = token.split('.');
		const tampered = `${payload}.${sig!.slice(0, -1)}${sig!.at(-1) === 'A' ? 'B' : 'A'}`;
		const result = s.verify(tampered, '1.2.3.4');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('invite_bad_signature');
	});

	it('rejects tokens with tampered payload', () => {
		const s = make();
		const { token } = s.issue('1.2.3.4');
		// Replace payload segment with a different but valid-looking
		// base64url string. The signature won't match.
		const [, sig] = token.split('.');
		const other = s.issue('9.9.9.9').token.split('.')[0];
		const frankenstein = `${other}.${sig}`;
		const result = s.verify(frankenstein, '1.2.3.4');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('invite_bad_signature');
	});

	it('rejects expired tokens', () => {
		// Item 6 / Audit Part 27: ManualClock is cleaner than
		// vi.useFakeTimers + vi.setSystemTime.  Only the
		// service's view of time is faked; the global system
		// clock stays real, so anything else in the test (Date
		// constructor for assertions, etc.) is unaffected.
		const clock = new ManualClock('2026-04-24T12:00:00Z');
		const s = make({ ttlMs: 60_000, clock });
		const { token } = s.issue('1.2.3.4');

		// Just under expiry — still valid.
		clock.advance(59_000);
		expect(s.verify(token, '1.2.3.4').ok).toBe(true);

		// Push past expiry — should reject.  A new service is
		// needed because verify() above marked the nonce
		// consumed.
		clock.advance(60_000); // now t=119s, but token expires at t=60s anyway
		const clock2 = new ManualClock('2026-04-24T12:02:00Z');
		const s2 = make({ ttlMs: 60_000, clock: clock2 });
		const { token: t2 } = s2.issue('1.2.3.4');
		clock2.advance(61_000);
		const result = s2.verify(t2, '1.2.3.4');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('invite_expired');
	});

	it('rejects tokens verified with a different IP (ip_mismatch)', () => {
		const s = make();
		const { token } = s.issue('1.2.3.4');
		const result = s.verify(token, '5.6.7.8');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('invite_ip_mismatch');
	});

	it('single-use: verify then consume, second verify fails with invite_already_used', () => {
		const s = make();
		const { token } = s.issue('1.2.3.4');

		const first = s.verify(token, '1.2.3.4');
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		s.consume(first.payload);

		const second = s.verify(token, '1.2.3.4');
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.code).toBe('invite_already_used');
	});

	it('malformed tokens (no dot, wrong base64) are rejected cleanly', () => {
		const s = make();
		for (const bad of ['', 'nodotseparator', 'a.b.c.d', '!@#.$%^']) {
			const r = s.verify(bad, '1.2.3.4');
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(['invite_malformed', 'invite_bad_signature']).toContain(r.code);
			}
		}
	});

	it('does not leak verifiable info across different service instances', () => {
		// Each service starts with a fresh random secret (since
		// we don't pass one). A token from s1 should fail
		// signature verification on s2.
		const s1 = make();
		const s2 = make();
		const { token } = s1.issue('1.2.3.4');
		const result = s2.verify(token, '1.2.3.4');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('invite_bad_signature');
	});

	it('with a fixed persistent secret: tokens survive a new instance', () => {
		const secret = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
		const s1 = make({ secret });
		const { token } = s1.issue('1.2.3.4');

		// A fresh service with the SAME secret must accept tokens
		// minted by the first — this is why persistent secrets
		// matter across relay restarts.
		const s2 = make({ secret });
		const result = s2.verify(token, '1.2.3.4');
		expect(result.ok).toBe(true);
	});
});
