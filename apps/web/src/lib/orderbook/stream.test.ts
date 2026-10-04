// @vitest-environment jsdom
/**
 * The live orderbook stream asks for the same page the REST read showed:
 * its snapshot replaces the REST rows, so a stream without the page's sort
 * and language filter swapped in a different set of orders.
 */
import { describe, expect, it } from 'vitest';

import { buildStreamUrl } from './stream';

describe('buildStreamUrl', () => {
	it('carries the sort and the language filter', () => {
		const u = new URL(buildStreamUrl({ side: 'buy', sort: 'rating', langs: 'ru,pl' }));
		expect(u.pathname).toBe('/v1/orderbook/stream');
		expect(u.searchParams.get('side')).toBe('buy');
		expect(u.searchParams.get('sort')).toBe('rating');
		expect(u.searchParams.get('langs')).toBe('ru,pl');
	});
	it('leaves the default sort out, as the REST read does', () => {
		const u = new URL(buildStreamUrl({ sort: 'recent' }));
		expect(u.searchParams.has('sort')).toBe(false);
	});
});
