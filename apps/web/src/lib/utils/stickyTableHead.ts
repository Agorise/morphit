/**
 * Where the /witnesses table's heading row sticks, and how far down keyboard
 * focus must land so the row never hides it (v1.23.1). PURE: the page measures,
 * this decides.
 *
 *   - The row sticks just under the site's sticky main menu, measured to the
 *     fraction of a pixel (a rounded height left a sub-pixel seam at some zoom
 *     levels), or under the notification banner while that shows (the banner
 *     sticks below the menu; stores/stickyBanner.ts).
 *   - The site's `scroll-padding-top` (5rem, app.css) is what the browser keeps
 *     clear when it scrolls a focused control into view. With the row stuck,
 *     5rem ends inside the row, so a control reached with Shift+Tab sat under
 *     it (WCAG 2.4.11, focus not obscured). While the table shows, the padding
 *     covers the menu, the row and a small gap; without the table (phones and
 *     small tablets show the list instead), the site default stays.
 */

/** Room between the stuck row and a control scrolled into view under it. */
export const STICKY_FOCUS_GAP_PX = 8;

export function stickyTableHead(m: {
	readonly menuHeight: number;
	/** The banner's bottom edge while it sticks, 0 when there is none. */
	readonly bannerBottom: number;
	/** The heading row's height, 0 when the table is not shown. */
	readonly rowHeight: number;
}): { readonly top: number; readonly scrollPaddingTop: number | null } {
	const top = Math.max(m.menuHeight, m.bannerBottom);
	return {
		top,
		scrollPaddingTop: m.rowHeight > 0 ? Math.ceil(top + m.rowHeight + STICKY_FOCUS_GAP_PX) : null
	};
}
