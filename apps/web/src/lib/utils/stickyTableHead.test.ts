import { describe, expect, it } from 'vitest';

import { STICKY_FOCUS_GAP_PX, stickyTableHead } from './stickyTableHead';

describe('stickyTableHead (v1.23.2, the /witnesses heading row)', () => {
	it('sticks right under the main menu, to the fraction of a pixel (zoom, branded logos)', () => {
		expect(stickyTableHead({ menuHeight: 64.4, bannerBottom: 0, rowHeight: 44 }).top).toBe(64.4);
	});

	it('sticks under the notification banner while that is showing (it sticks below the menu)', () => {
		expect(stickyTableHead({ menuHeight: 65, bannerBottom: 64 + 96, rowHeight: 44 }).top).toBe(160);
		// A banner that ends above the menu's edge changes nothing.
		expect(stickyTableHead({ menuHeight: 65, bannerBottom: 40, rowHeight: 44 }).top).toBe(65);
	});

	it('keyboard focus scrolled into view lands below the stuck row (WCAG 2.4.11)', () => {
		const r = stickyTableHead({ menuHeight: 65, bannerBottom: 0, rowHeight: 44 });
		expect(r.scrollPaddingTop).toBe(Math.ceil(65 + 44 + STICKY_FOCUS_GAP_PX));
		expect(r.scrollPaddingTop!).toBeGreaterThan(65 + 44);
	});

	it('no table on screen (phones and small tablets show the list): the site default stays', () => {
		expect(
			stickyTableHead({ menuHeight: 65, bannerBottom: 0, rowHeight: 0 }).scrollPaddingTop
		).toBeNull();
	});
});
