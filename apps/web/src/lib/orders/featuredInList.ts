/**
 * Morphit — the featured order on the orderbook (v1.21.17).
 *
 * The orderbook showed a featured order twice: in the "🎉 Featured" card and
 * again in the list right under it. It is now shown once, in the Featured
 * card, which stays whatever the filters are. When the person filters and a
 * featured order is among the matches, its card flashes its border twice to
 * draw the eye, the same pulse the footer "Contact" link uses on the
 * instances page. It does not flash on a plain visit, on live updates, or
 * when it does not match: that would only be noise.
 *
 * "Found" means among the orders the search loaded (the first page, 50, or
 * the live snapshot): a featured order that matches only further down, past
 * "Load more", is not flashed — it is still shown, in the Featured card.
 */

export const orderKey = (o: { readonly account: string; readonly permlink: string }): string =>
	`${o.account}/${o.permlink}`;

/** The list without the orders the Featured card already shows. */
export function withoutFeatured<T extends { readonly account: string; readonly permlink: string }>(
	items: readonly T[],
	featuredKeys: ReadonlySet<string>
): T[] {
	return featuredKeys.size === 0 ? [...items] : items.filter((o) => !featuredKeys.has(orderKey(o)));
}

/** How long the "Order details" words must rest before they count as a
 *  search (typing "orange" is one search, not six). */
export const SEARCH_SETTLE_MS = 600;

/** Two pulses of the 2 s border keyframes, cleared a beat after the last. */
export const FEATURED_FLASH_MS = 2 * 2_000 + 200;

/**
 * Which featured orders to flash for this search, once per search.
 *
 * `search` names the filters in force, `''` when none (a plain visit never
 * flashes). It is decided only once the list on screen is the answer to that
 * search (`listFor === search`, the orderbook has loaded it) and the
 * Featured card has reported what it shows; until then nothing is decided
 * and `decided` stays as it was. `matches` are the keys of the orders the
 * search found, featured ones included.
 */
export function featuredFlashFor(input: {
	readonly search: string;
	readonly listFor: string | null;
	readonly decided: string | null;
	readonly featuredKnown: boolean;
	readonly featuredKeys: ReadonlySet<string>;
	readonly matches: readonly string[];
}): { readonly decided: string | null; readonly flash: readonly string[] } {
	if (input.search === '') return { decided: '', flash: [] };
	if (input.search === input.decided) return { decided: input.decided, flash: [] };
	if (input.listFor !== input.search || !input.featuredKnown) {
		return { decided: input.decided, flash: [] };
	}
	const flash = input.matches.filter((k) => input.featuredKeys.has(k));
	return { decided: input.search, flash };
}
