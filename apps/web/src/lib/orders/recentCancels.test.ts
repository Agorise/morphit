import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for safeSession so the tests don't depend on a real
// sessionStorage implementation.
const store = new Map<string, string>();
vi.mock('$lib/utils/safeStorage', () => ({
	safeSession: {
		get: (k: string) => store.get(k) ?? null,
		set: (k: string, v: string) => {
			store.set(k, v);
		},
		remove: (k: string) => {
			store.delete(k);
		}
	},
	safeLocal: { get: () => null, set: () => {}, remove: () => {} }
}));

import { recordCancel, recentlyCancelledPermlinks, applyRecentCancels } from './recentCancels';

describe('recentCancels', () => {
	beforeEach(() => {
		store.clear();
		vi.useRealTimers();
	});

	it('records a cancel and reports it as recently cancelled', () => {
		recordCancel('order-abc');
		expect(recentlyCancelledPermlinks().has('order-abc')).toBe(true);
	});

	it('applyRecentCancels flips only the recorded order to cancelled', () => {
		recordCancel('order-abc');
		const orders = [
			{ permlink: 'order-abc', status: 'live' },
			{ permlink: 'order-xyz', status: 'live' }
		];
		const out = applyRecentCancels(orders);
		expect(out.find((o) => o.permlink === 'order-abc')?.status).toBe('cancelled');
		expect(out.find((o) => o.permlink === 'order-xyz')?.status).toBe('live');
	});

	it('returns the same array reference when nothing was cancelled (no needless churn)', () => {
		const orders = [{ permlink: 'order-abc', status: 'live' }];
		expect(applyRecentCancels(orders)).toBe(orders);
	});

	it('does not duplicate a permlink recorded twice', () => {
		recordCancel('order-abc');
		recordCancel('order-abc');
		expect([...recentlyCancelledPermlinks()]).toEqual(['order-abc']);
	});

	it('expires an entry after the 3-minute TTL', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-12T00:00:00Z'));
		recordCancel('order-abc');
		expect(recentlyCancelledPermlinks().has('order-abc')).toBe(true);
		// +4 minutes — past the 3-minute window.
		vi.setSystemTime(new Date('2026-07-12T00:04:00Z'));
		expect(recentlyCancelledPermlinks().has('order-abc')).toBe(false);
		vi.useRealTimers();
	});

	it('tolerates a corrupt sessionStorage payload', () => {
		store.set('morphit.recent_cancels_v1', 'not json{{');
		expect(recentlyCancelledPermlinks().size).toBe(0);
	});

	it('leaves an already-cancelled order untouched (no new object)', () => {
		recordCancel('order-abc');
		const orders = [{ permlink: 'order-abc', status: 'cancelled' }];
		const out = applyRecentCancels(orders);
		expect(out[0]).toBe(orders[0]);
	});
});
