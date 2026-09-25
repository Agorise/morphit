/**
 * compareOrderbooks — diff two instances' orderbooks HONESTLY.
 *
 * WHY THIS IS NOT JUST A SET DIFFERENCE
 * -------------------------------------
 * /compare exists to surface censorship: two instances reading the same chain
 * should show the same live orders, so an order missing from one of them is a
 * signal. The page used to take that literally — fetch 100 from each side, diff
 * by (account, permlink), show what only one side had.
 *
 * But `/v1/orderbook` is a PAGE, not a set. It returns at most 100 rows ordered
 * by `updated_at DESC`, plus a `next_cursor` when more exist. So on any instance
 * with more than 100 live orders the page was diffing two different WINDOWS of
 * the same orderbook and reporting the difference as if it were evidence.
 *
 * Worse, the two windows do not even end at the same moment. Each side's window
 * reaches back only as far as its own hundredth-most-recent order, so the busier
 * instance's window is SHORTER in time. Every order in the gap between the two
 * cut-offs shows up as "only on that instance" — orders both instances are
 * serving perfectly well.
 *
 * That is exactly the report from the timeapp admin: an order "old, some days
 * ago" appearing as a difference, and the conclusion that "the two instances are
 * not on the same page". The orderbooks agreed. The comparison did not.
 *
 * THE FIX: COMPARE ONLY WHERE BOTH SIDES ARE COMPLETE
 * ---------------------------------------------------
 * If a side was truncated, everything it returned is complete only back to the
 * row its page was cut on. The window in which BOTH sides are known-complete
 * therefore runs down to whichever truncated side stopped SOONER. Inside it, a
 * missing order is real. Outside it, nothing can be concluded — and this module
 * says so rather than guessing.
 *
 * If neither side was truncated, both returned everything and the whole diff is
 * trustworthy.
 *
 * THE BOUNDARY IS A TUPLE, NOT A TIMESTAMP
 * ----------------------------------------
 * The page is not cut on `updated_at` alone. `/v1/orderbook` orders by
 * `(updated_at DESC, account ASC, permlink ASC)` and its cursor carries all
 * three fields for exactly that reason: two orders can share a timestamp and
 * the cut can fall between them. So the window boundary has to be compared the
 * same way.
 *
 * An earlier version of this module excluded everything at the boundary
 * TIMESTAMP to avoid accusing a tie-broken row. That over-corrected badly,
 * because on this chain `updated_at` is the BLOCK timestamp: every order
 * touched in the same block shares it to the second. So "one timestamp's worth"
 * is a whole block's worth, the honest side's own hundredth row always sits
 * inside the discarded band, and a genuinely censored order landing there was
 * reported as agreement. An operator who controls the `updated_at` it serves
 * could aim its own cut-off at a chosen victim's timestamp to hide that order.
 *
 * Comparing the full tuple removes the ambiguity that motivated the exclusion,
 * so nothing has to be discarded: a page is the TOP N in the API's ordering, so
 * a truncated side has reported everything sorting at or before its own last
 * row, that row INCLUDED. Both sides are complete through whichever stopped
 * sooner, and the window is inclusive of it.
 */

import type { OrderRecord } from '@morphit/indexer-client';

/** One side's fetched page, as returned by `/v1/orderbook`. */
export interface OrderbookSide {
	readonly items: readonly OrderRecord[];
	/** Non-null when the instance has more orders than it returned. */
	readonly next_cursor: string | null;
	readonly indexed_block: number;
}

export type CompareVerdict =
	/** Both sides complete over the compared window, and they agree. */
	| 'agree'
	/** Both sides complete over the compared window, and they differ. */
	| 'differ'
	/** No window exists in which both sides are known-complete. */
	| 'inconclusive';

export interface CompareResult {
	readonly verdict: CompareVerdict;
	/** Orders present here but not there, WITHIN the compared window. */
	readonly onlyHere: readonly OrderRecord[];
	/** Orders present on both, WITHIN the compared window. */
	readonly inBoth: readonly OrderRecord[];
	/** Orders present there but not here, WITHIN the compared window. */
	readonly onlyThere: readonly OrderRecord[];
	/** ISO timestamp the comparison starts at, or null when it covers
	 *  everything both sides returned (neither side was truncated). */
	readonly windowStart: string | null;
	/** True when either side had more orders than it returned. */
	readonly truncated: boolean;
	/** Orders dropped from the comparison because they fall outside the
	 *  window where both sides are known-complete. These are NOT evidence
	 *  of anything and must never be presented as differences. */
	readonly excludedHere: number;
	readonly excludedThere: number;
	/** DISTINCT orders excluded across both sides. `excludedHere +
	 *  excludedThere` double-counts every order both sides returned, so this is
	 *  the only one of the three that can be shown to a person as a count of
	 *  orders. */
	readonly excludedDistinct: number;
	/** |indexed_block here − indexed_block there|. A large gap explains
	 *  genuine differences among the most recent orders. */
	readonly blockGap: number;
}

const keyOf = (o: OrderRecord): string => `${o.account}/${o.permlink}`;

/** The API's sort key for one row: `updated_at DESC, account ASC, permlink ASC`
 *  (apps/indexer/src/api/orderbook.ts). */
interface SortKey {
	readonly updatedAt: string;
	readonly account: string;
	readonly permlink: string;
}

const sortKeyOf = (o: OrderRecord): SortKey => ({
	updatedAt: o.updated_at,
	account: o.account,
	permlink: o.permlink
});

/**
 * Order two rows the way the API does. Negative when `a` comes FIRST (is newer
 * / sorts earlier in the page), positive when it comes later.
 *
 * `updated_at` is always a fixed-width UTC ISO string from the indexer
 * (`Date.toISOString()` over a TIMESTAMPTZ), so lexicographic order equals
 * chronological order; account and permlink are compared as the SQL `ASC` does.
 */
function comparePageOrder(a: SortKey, b: SortKey): number {
	if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
	if (a.account !== b.account) return a.account < b.account ? -1 : 1;
	if (a.permlink !== b.permlink) return a.permlink < b.permlink ? -1 : 1;
	return 0;
}

/** The LAST row of a page in the API's ordering — the row the cut fell on.
 *  Computed by scanning rather than taking `items[items.length - 1]`, because a
 *  remote instance is untrusted and may not return its page in order. */
function boundaryRow(items: readonly OrderRecord[]): SortKey | null {
	let last: SortKey | null = null;
	for (const o of items) {
		const k = sortKeyOf(o);
		if (last === null || comparePageOrder(k, last) > 0) last = k;
	}
	return last;
}

export function compareOrderbooks(here: OrderbookSide, there: OrderbookSide): CompareResult {
	const truncated = here.next_cursor !== null || there.next_cursor !== null;

	// A truncated side is complete only back to the row its page was cut on.
	// Both sides are complete only from the LATER of those cut rows onward. An
	// untruncated side contributes no cut-off at all, because it withheld
	// nothing. The cut row is a (updated_at, account, permlink) tuple, not just
	// a timestamp — see the note at the top of this file.
	const cutoffs: SortKey[] = [];
	if (here.next_cursor !== null) {
		const k = boundaryRow(here.items);
		if (k !== null) cutoffs.push(k);
	}
	if (there.next_cursor !== null) {
		const k = boundaryRow(there.items);
		if (k !== null) cutoffs.push(k);
	}
	// The binding cut-off is whichever side stopped SOONER, i.e. whose last row
	// sorts earliest in the page ordering.
	const boundary = cutoffs.length
		? cutoffs.reduce((a, b) => (comparePageOrder(a, b) < 0 ? a : b))
		: null;

	// Inside the window = sorts at or before the boundary row.
	//
	// INCLUSIVE, and that is the whole point. A page is the TOP N in the API's
	// ordering, so a truncated side has told us about everything that sorts at
	// or before its own last row — including that row. Both sides are therefore
	// complete through whichever of them stopped sooner, that row included.
	//
	// Excluding it, as an earlier version did, left a hole exactly where a
	// censor would aim: when this side is the truncated one the boundary is its
	// own hundredth row, which is entirely predictable. With the full tuple
	// there is no ambiguity left to defend against — the tie that motivated the
	// exclusion is resolved by account and permlink, exactly as the API resolves
	// it — so nothing needs to be discarded at all.
	const inWindow = (o: OrderRecord): boolean =>
		boundary === null ? true : comparePageOrder(sortKeyOf(o), boundary) <= 0;

	const hereIn = here.items.filter(inWindow);
	const thereIn = there.items.filter(inWindow);

	// Reported for display only; the comparison itself uses the tuple above.
	const windowStart = boundary === null ? null : boundary.updatedAt;

	const hereMap = new Map(hereIn.map((o) => [keyOf(o), o]));
	const thereMap = new Map(thereIn.map((o) => [keyOf(o), o]));

	const onlyHere: OrderRecord[] = [];
	const inBoth: OrderRecord[] = [];
	const onlyThere: OrderRecord[] = [];

	for (const [k, o] of hereMap) {
		if (thereMap.has(k)) inBoth.push(o);
		else onlyHere.push(o);
	}
	for (const [k, o] of thereMap) {
		if (!hereMap.has(k)) onlyThere.push(o);
	}

	// A side that reports more rows exist but returns none of them has told us
	// nothing about any row, so there is no range in which both sides are known
	// complete. Reporting the other side's entire orderbook as "only there"
	// would be an accusation resting on no evidence at all.
	const blindSide =
		(here.next_cursor !== null && here.items.length === 0) ||
		(there.next_cursor !== null && there.items.length === 0);

	// When NEITHER side was truncated, both returned their complete orderbooks
	// and the diff is authoritative — including when both are empty, which is a
	// genuine "these two agree", not an absence of evidence. Only a TRUNCATED
	// comparison that leaves nothing comparable is inconclusive: there, "they
	// agree" would be a lie of omission and "they differ" would be the original
	// bug.
	const comparable = !blindSide && (!truncated || hereIn.length > 0 || thereIn.length > 0);
	const verdict: CompareVerdict = !comparable
		? 'inconclusive'
		: onlyHere.length === 0 && onlyThere.length === 0
			? 'agree'
			: 'differ';

	// An inconclusive comparison must not hand the UI a list of "findings" to
	// render. Nothing was established, so there is nothing to show — and a
	// blind side would otherwise emit the whole of the other instance's
	// orderbook as differences.
	if (verdict === 'inconclusive') {
		onlyHere.length = 0;
		onlyThere.length = 0;
		inBoth.length = 0;
	}

	// DISTINCT orders excluded. The two per-side counts overlap — an order both
	// sides returned but that falls outside the window is counted once on each —
	// so adding them and calling the total "orders" overstates it by however
	// many rows sit at the boundary, which on this chain is a whole block's
	// worth. The UI shows one number, so compute the honest one here rather
	// than leaving the caller to add two that cannot be added.
	const excludedKeys = new Set<string>();
	for (const o of here.items) if (!inWindow(o)) excludedKeys.add(keyOf(o));
	for (const o of there.items) if (!inWindow(o)) excludedKeys.add(keyOf(o));

	return {
		verdict,
		onlyHere,
		inBoth,
		onlyThere,
		windowStart,
		truncated,
		excludedHere: here.items.length - hereIn.length,
		excludedThere: there.items.length - thereIn.length,
		excludedDistinct: excludedKeys.size,
		blockGap: Math.abs(here.indexed_block - there.indexed_block)
	};
}
