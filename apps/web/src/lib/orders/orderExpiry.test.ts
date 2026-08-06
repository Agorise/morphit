import { describe, it, expect } from 'vitest';
import { isOrderExpired, isOrderLive, type OrderExpiryFields } from './orderExpiry';

// Fixed "now" so the tests are deterministic regardless of wall clock or
// the machine's local timezone.  2026-07-06T12:00:00Z.
const NOW = Date.parse('2026-07-06T12:00:00.000Z');

function order(overrides: Partial<OrderExpiryFields> = {}): OrderExpiryFields {
	return { status: 'live', expires_at: '2026-08-01T00:00:00.000Z', ...overrides };
}

describe('isOrderExpired / isOrderLive', () => {
	it('a stored-live order with a future expires_at is live, not expired', () => {
		const o = order({ status: 'live', expires_at: '2026-07-06T18:00:00.000Z' });
		expect(isOrderExpired(o, NOW)).toBe(false);
		expect(isOrderLive(o, NOW)).toBe(true);
	});

	it('THE BUG: a stored-live order past its expires_at is EXPIRED (not live)', () => {
		// kentest3's first order: indexer still says status='live' because no
		// sweep ran, but expires_at (a few hours ago) has passed. The public
		// orderbook already dropped it, so /my/orders must too.
		const o = order({ status: 'live', expires_at: '2026-07-06T09:00:00.000Z' });
		expect(isOrderExpired(o, NOW)).toBe(true);
		expect(isOrderLive(o, NOW)).toBe(false);
	});

	it('a stored-expired order is expired regardless of expires_at', () => {
		const o = order({ status: 'expired', expires_at: '2027-01-01T00:00:00.000Z' });
		expect(isOrderExpired(o, NOW)).toBe(true);
		expect(isOrderLive(o, NOW)).toBe(false);
	});

	it('a cancelled order is neither live nor (effectively) expired', () => {
		const o = order({ status: 'cancelled', expires_at: '2026-07-06T09:00:00.000Z' });
		expect(isOrderExpired(o, NOW)).toBe(false);
		expect(isOrderLive(o, NOW)).toBe(false);
	});

	it('a live order with null expires_at never auto-expires', () => {
		const o = order({ status: 'live', expires_at: null });
		expect(isOrderExpired(o, NOW)).toBe(false);
		expect(isOrderLive(o, NOW)).toBe(true);
	});

	it('expires_at exactly at now counts as expired (boundary, <=)', () => {
		const o = order({ status: 'live', expires_at: '2026-07-06T12:00:00.000Z' });
		expect(isOrderExpired(o, NOW)).toBe(true);
		expect(isOrderLive(o, NOW)).toBe(false);
	});

	it('one millisecond before now is still live; one after is expired', () => {
		expect(isOrderLive(order({ expires_at: '2026-07-06T12:00:00.001Z' }), NOW)).toBe(true);
		expect(isOrderExpired(order({ expires_at: '2026-07-06T11:59:59.999Z' }), NOW)).toBe(true);
	});

	it('is timezone-correct: the Z suffix is read as UTC, not local time', () => {
		// If a client mis-parsed this as local time, a machine at UTC+14 would
		// see it as ~10:00Z (still future → wrongly live) and a machine at
		// UTC-12 as ~14:00Z (past → wrongly expired). Because the string is
		// Z-suffixed and Date.parse honours it, the verdict is the same
		// everywhere: 22:00Z on 2026-07-06 is future relative to 12:00Z → live.
		const o = order({ status: 'live', expires_at: '2026-07-06T22:00:00.000Z' });
		expect(isOrderLive(o, NOW)).toBe(true);
	});

	it('a malformed expires_at fails SAFE (stays live, never silently vanishes)', () => {
		const o = order({ status: 'live', expires_at: 'not-a-date' });
		// Date.parse → NaN; NaN <= NOW is false, so not expired.
		expect(isOrderExpired(o, NOW)).toBe(false);
		expect(isOrderLive(o, NOW)).toBe(true);
	});

	it('undefined status (older record) with a future date is not expired', () => {
		const o: OrderExpiryFields = { expires_at: '2026-08-01T00:00:00.000Z' };
		expect(isOrderExpired(o, NOW)).toBe(false);
		// isOrderLive requires status==='live', so an undefined status is not "live"
		expect(isOrderLive(o, NOW)).toBe(false);
	});
});
