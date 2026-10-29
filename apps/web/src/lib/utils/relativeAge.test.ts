import { describe, expect, it } from 'vitest';
import { relativeAge } from './relativeAge';

const NOW = Date.parse('2026-10-26T16:29:00Z');
const ago = (ms: number) => relativeAge(NOW - ms, NOW);
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

describe('relativeAge (v1.21.17)', () => {
	it('the order that read "Posted 2mo ago" on its expiry day reads 3 months', () => {
		// Posted 28 July 2026 18:47 UTC, seen 26 October 2026 16:29 UTC: 89.9 days.
		expect(relativeAge(Date.parse('2026-07-28T18:47:30Z'), NOW)).toEqual({ unit: 'months', n: 3 });
	});
	it('counts whole minutes, hours and days', () => {
		expect(ago(59 * S)).toEqual({ unit: 'lt1m', n: 0 });
		expect(ago(60 * S)).toEqual({ unit: 'minutes', n: 1 });
		expect(ago(59 * MIN + 59 * S)).toEqual({ unit: 'minutes', n: 59 });
		expect(ago(H)).toEqual({ unit: 'hours', n: 1 });
		expect(ago(23 * H + 59 * MIN)).toEqual({ unit: 'hours', n: 23 });
		expect(ago(D)).toEqual({ unit: 'days', n: 1 });
		expect(ago(29 * D + 23 * H)).toEqual({ unit: 'days', n: 29 });
	});
	it('rounds months to the nearest one, 1 to 11', () => {
		expect(ago(30 * D)).toEqual({ unit: 'months', n: 1 });
		expect(ago(45 * D)).toEqual({ unit: 'months', n: 1 });
		expect(ago(46 * D)).toEqual({ unit: 'months', n: 2 });
		expect(ago(60 * D)).toEqual({ unit: 'months', n: 2 });
		expect(ago(90 * D)).toEqual({ unit: 'months', n: 3 });
		expect(ago(364 * D)).toEqual({ unit: 'months', n: 11 });
	});
	it('rounds years to the nearest one, at least 1', () => {
		expect(ago(365 * D)).toEqual({ unit: 'years', n: 1 });
		expect(ago(547 * D)).toEqual({ unit: 'years', n: 1 });
		expect(ago(549 * D)).toEqual({ unit: 'years', n: 2 });
	});
	it('a time in the future counts as now', () => {
		expect(relativeAge(NOW + 5 * MIN, NOW)).toEqual({ unit: 'lt1m', n: 0 });
	});
});
