/**
 * A new order arriving on the LIVE orderbook slides into place (v1.23.4).
 *
 * Owner: "when a new order gets posted while i am staring at the page, i want
 * that new card to slide in to place over the course of 1 second. right now,
 * the new card that appears seems to blink/flash a couple times and it pops
 * into place which looks glitchy."
 *
 * Why it blinked: every card carries `animate-fade-up`; the new one also got an
 * `order-slide-in` class that overrode it for 0.32 s, and removing that class
 * started the fade-up over again — two entrances. And the cards below jumped
 * down at once. Here, nothing toggles a class: the cards' positions are read
 * just before the order is inserted, and after it is, one set of Web
 * Animations plays — the new card fades and slides down into its place, every
 * card it pushed glides down from where it was (FLIP). Reduced motion: none.
 * Several orders in a row: each push is added to the glide still running.
 */

/** How long the slide takes (owner: "over the course of 1 second"). */
export const NEW_ORDER_SLIDE_MS = 1000;
/** How far above its place the new card starts. */
export const NEW_ORDER_SLIDE_FROM_PX = 24;
const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

function cards(list: ParentNode): HTMLElement[] {
	return [...list.querySelectorAll<HTMLElement>('[data-order-key]')];
}

/** Where each card is now, by its order key (account/permlink). */
export function measureTops(list: ParentNode | null): Map<string, number> {
	const tops = new Map<string, number>();
	if (!list) return tops;
	for (const el of cards(list)) {
		const key = el.dataset.orderKey;
		if (key) tops.set(key, el.getBoundingClientRect().top);
	}
	return tops;
}

function reducedMotion(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * After `newKey`'s card is in the DOM: slide it in, and move every card that
 * shifted from its `before` position back there and on to its new one.
 * Returns how many cards it animated (0 with reduced motion or no list).
 */
export function playSlideIn(
	list: ParentNode | null,
	before: ReadonlyMap<string, number>,
	newKey: string
): number {
	if (!list || reducedMotion()) return 0;
	let n = 0;
	for (const el of cards(list)) {
		if (typeof el.animate !== 'function') continue;
		const key = el.dataset.orderKey;
		if (key === newKey) {
			el.animate(
				[
					{ opacity: 0, transform: `translateY(-${NEW_ORDER_SLIDE_FROM_PX}px)` },
					{ opacity: 1, transform: 'translateY(0)' }
				],
				{ duration: NEW_ORDER_SLIDE_MS, easing: EASING }
			);
			n++;
			continue;
		}
		const was = key === undefined ? undefined : before.get(key);
		if (was === undefined) continue;
		const dy = was - el.getBoundingClientRect().top;
		if (Math.abs(dy) < 1) continue;
		// Review: `add`, not the default `replace`. When an order lands while the
		// last one still slides, both rects include the running transform, so dy
		// is only the newest card's height; replacing would drop the rest of the
		// running glide in one frame (the jump again). Added on top, the glides
		// run out together and the card never jumps.
		el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
			duration: NEW_ORDER_SLIDE_MS,
			easing: EASING,
			composite: 'add'
		});
		n++;
	}
	return n;
}
