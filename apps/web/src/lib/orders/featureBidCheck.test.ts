import { describe, expect, it } from 'vitest';

import { bidOutlook, bidVerdict, requiredToDisplace } from './featureBidCheck';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const live = { status: 'live', fee_status: 'verified', expires_at: null } as const;
const slot = (rate: number, expires: string) =>
	({
		order: {} as never,
		bid: {
			hours_requested: 24,
			blurt_paid: String(rate * 24),
			blurt_per_hour: String(rate),
			effective_at: '2026-10-02T00:00:00Z',
			expires_at: expires
		}
	}) as const;

describe('bidOutlook (check before the BLURT moves)', () => {
	it('blocks a bid on an order that is gone, ended or not fee-verified', () => {
		expect(bidOutlook(null, null, 50, NOW)).toEqual({ kind: 'blocked', reason: 'not_found' });
		expect(bidOutlook({ ...live, status: 'cancelled' }, null, 50, NOW)).toEqual({
			kind: 'blocked',
			reason: 'not_live'
		});
		expect(bidOutlook({ ...live, expires_at: '2026-10-01T00:00:00Z' }, null, 50, NOW)).toEqual({
			kind: 'blocked',
			reason: 'not_live'
		});
		expect(bidOutlook({ ...live, fee_status: 'pending_external' }, null, 50, NOW)).toEqual({
			kind: 'blocked',
			reason: 'fee_not_verified'
		});
	});
	it('a free slot shows the bid at once', () => {
		const featured = { featured: [slot(50, '2026-10-03T00:00:00Z')], max_slots: 3 };
		expect(bidOutlook(live, featured, 50, NOW)).toEqual({ kind: 'visible' });
	});
	it('full slots at the same rate: the bid waits for the earliest expiry', () => {
		const featured = {
			featured: [
				slot(50, '2026-10-04T00:00:00Z'),
				slot(60, '2026-10-02T18:00:00Z'),
				slot(50, '2026-10-03T00:00:00Z')
			],
			max_slots: 3
		};
		expect(bidOutlook(live, featured, 50, NOW)).toEqual({
			kind: 'waits',
			lowestRate: 50,
			freesAt: '2026-10-02T18:00:00Z'
		});
	});
	it('beating the lowest slot by less than max(1/h, 5 %) is not sent', () => {
		const featured = {
			featured: [slot(50, 'x'), slot(50, 'x'), slot(50, 'x')],
			max_slots: 3
		};
		expect(requiredToDisplace(50)).toBe(52.5);
		expect(bidOutlook(live, featured, 52, NOW)).toEqual({
			kind: 'too_small',
			lowestRate: 50,
			required: 52.5
		});
		expect(bidOutlook(live, featured, 52.5, NOW)).toEqual({ kind: 'visible' });
	});
});

describe('bidVerdict (wait for the indexer before saying "featured")', () => {
	const before = [{ order_permlink: 'o-1', effective_at: '2026-09-01T00:00:00Z' }];
	const old = { ...before[0]!, expires_at: '2026-09-02T00:00:00Z', is_visible: false };
	it('pending until a new bid on this order appears', () => {
		expect(bidVerdict(before, [old], 'o-1', NOW)).toEqual({ kind: 'pending' });
		expect(
			bidVerdict(
				before,
				[old, { order_permlink: 'o-2', effective_at: 'z', expires_at: 'z', is_visible: true }],
				'o-1',
				NOW
			)
		).toEqual({ kind: 'pending' });
	});
	it('visible, queued or waiting, as the indexer recorded it', () => {
		const fresh = (effective_at: string, is_visible: boolean) => ({
			order_permlink: 'o-1',
			effective_at,
			expires_at: '2026-10-05T00:00:00Z',
			is_visible
		});
		expect(bidVerdict(before, [fresh('2026-10-02T11:59:00Z', true), old], 'o-1', NOW)).toEqual({
			kind: 'visible'
		});
		expect(bidVerdict(before, [fresh('2026-10-03T00:00:00Z', false)], 'o-1', NOW)).toEqual({
			kind: 'queued',
			startsAt: '2026-10-03T00:00:00Z'
		});
		expect(bidVerdict(before, [fresh('2026-10-02T11:59:00Z', false)], 'o-1', NOW)).toEqual({
			kind: 'waiting'
		});
	});
});
