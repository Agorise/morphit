import { describe, expect, it } from 'vitest';
import { featuredFlashFor, withoutFeatured } from './featuredInList';

const F = new Set(['ann/o1']);
const base = {
	search: 'side=buy',
	listFor: 'side=buy',
	decided: null,
	featuredKnown: true,
	featuredKeys: F,
	matches: ['bob/o2', 'ann/o1']
};

describe('the featured order on the orderbook (v1.21.17)', () => {
	it('is listed once: the Featured card shows it, the list does not', () => {
		const items = [
			{ account: 'ann', permlink: 'o1' },
			{ account: 'bob', permlink: 'o2' }
		];
		expect(withoutFeatured(items, F)).toEqual([{ account: 'bob', permlink: 'o2' }]);
		expect(withoutFeatured(items, new Set())).toEqual(items);
	});

	it('flashes when a search finds it, once per search', () => {
		const first = featuredFlashFor(base);
		expect(first).toEqual({ decided: 'side=buy', flash: ['ann/o1'] });
		// The same search again (a live update, a re-render): no second flash.
		expect(featuredFlashFor({ ...base, decided: first.decided })).toEqual({
			decided: 'side=buy',
			flash: []
		});
	});

	it('does not flash when the search does not find it, or on a plain visit', () => {
		expect(featuredFlashFor({ ...base, matches: ['bob/o2'] }).flash).toEqual([]);
		expect(featuredFlashFor({ ...base, search: '', listFor: '' })).toEqual({
			decided: '',
			flash: []
		});
	});

	it('waits until the list is the answer to this search and the Featured card is known', () => {
		expect(featuredFlashFor({ ...base, listFor: 'side=sell' })).toEqual({
			decided: null,
			flash: []
		});
		expect(featuredFlashFor({ ...base, featuredKnown: false })).toEqual({
			decided: null,
			flash: []
		});
	});
});
