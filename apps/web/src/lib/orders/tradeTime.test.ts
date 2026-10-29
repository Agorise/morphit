import { describe, expect, it } from 'vitest';

import { byTradeTimeDesc, tradeTimeOf } from './tradeTime';

describe('the time of a trade', () => {
	it('is the completion, not the last change', () => {
		expect(
			tradeTimeOf({
				completed_at: '2026-10-10T00:00:00.000Z',
				updated_at: '2026-10-27T11:00:00.000Z'
			})
		).toBe('2026-10-10T00:00:00.000Z');
	});
	it('falls back to the last change when an older indexer sends no completion time', () => {
		expect(tradeTimeOf({ updated_at: '2026-10-27T11:00:00.000Z' })).toBe(
			'2026-10-27T11:00:00.000Z'
		);
	});
	it('orders trades newest completion first, whatever changed them later', () => {
		const early = {
			completed_at: '2026-10-10T00:00:00.000Z',
			updated_at: '2026-10-27T11:00:00.000Z'
		};
		const late = {
			completed_at: '2026-10-15T00:00:00.000Z',
			updated_at: '2026-10-15T00:00:00.000Z'
		};
		expect([early, late].sort(byTradeTimeDesc)).toEqual([late, early]);
	});
});
