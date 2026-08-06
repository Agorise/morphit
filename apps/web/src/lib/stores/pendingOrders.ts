/**
 * pendingOrders — optimistic, DISPLAY-ONLY echo of orders the CURRENT USER just
 * posted or cancelled (v1.7.0, "fastpostorder" / "fastcancelorder", ADR-0051).
 *
 * WHY. The durable indexer applies only irreversible blocks (ADR-0008), so an
 * order you just broadcast is invisible to `/v1/orders/:account` for ~45-63s.
 * That produced a bug that is worse than slow:
 *
 *   The order detail page retried for ~24s (8 × 3s) and then said **"Order not
 *   found"** — with a comment claiming 24s was "comfortably longer than Blurt
 *   block time + indexer poll lag". It reasoned about POLL lag (~3s) and never
 *   accounted for IRREVERSIBILITY (45-63s). So a user who posted an order and
 *   clicked "View my order" was told their order didn't exist. The comment
 *   above that constant says the whole point is to stop an instant not-found
 *   reading as "my money vanished" — and then it did exactly that, 24 seconds
 *   later instead of instantly.
 *
 * Lengthening the retry to 90s would have "fixed" it by making the user stare
 * at a spinner for a minute and a half. The real answer is that the browser
 * already KNOWS the order: it just signed and broadcast it. There is nothing to
 * wait for. Show it, mark it as still confirming, and let the indexer's copy
 * take over when it lands.
 *
 * This is the same shape `pendingFeatured` (cp431) used for feature bids —
 * deliberately, since it's proven — with the mechanical rules shared via
 * `pendingEcho` so the two can't drift apart.
 *
 * SAFETY / INVARIANTS (inherited from pendingEcho; restated because this one
 * touches ORDERS and someone will be tempted):
 *   - DISPLAY ONLY. Never touches money, the DB, fees, or reputation. The
 *     durable indexer is the SOLE source of truth and SUPERSEDES anything here.
 *     Per ADR-0051's matrix an order is provisional-displayable precisely
 *     BECAUSE it's an offer, not money — the same reasoning that keeps trade
 *     counts and review scores durable-only.
 *   - ONLY THE USER'S OWN ACTIONS. Nothing here is ever staged on someone
 *     else's behalf. We stage an entry only after a broadcast this browser made
 *     SUCCEEDED, so "provisional" means "on chain, not yet irreversible" — not
 *     "we hope".
 *   - SELF-RECONCILING. An entry vanishes the moment the indexer confirms it,
 *     and ages out after PENDING_TTL_MS if it never does (a rejected op, a
 *     losing race). It cannot lie forever.
 *   - LOCAL ONLY. In-memory. A refresh falls back to the authoritative view.
 */

import { writable } from 'svelte/store';
import type { OrderRecord } from '@morphit/indexer-client';
import { PENDING_TTL_MS, liveEntries, upsertEntry, orderEchoKey } from './pendingEcho';

export { PENDING_TTL_MS, orderEchoKey as pendingOrderKey };

/**
 * WHY THERE IS NO 'cancel' KIND. `$lib/orders/recentCancels` already bridges the
 * same lag for cancels (t.txt #6/#7), and it is the RIGHT home for them rather
 * than merely the incumbent:
 *
 *   - It persists in sessionStorage, and for a cancel that matters. Falling back
 *     to the indexer after a reload would show the order as LIVE — "I cancelled
 *     it and it's still there!". For a POST the same fallback is harmless (the
 *     order simply isn't listed yet), which is why this store can be in-memory
 *     and that one can't. Same lag; opposite safe-failure directions.
 *
 * Adding a cancel path here would give the app two answers to "is this order
 * cancelled?", and they'd drift the first time one got a fix the other didn't.
 * That is precisely the pattern ADR-0051 was written about: FOUR independent
 * workarounds had already grown around this one lag (`pendingFeatured`, the
 * detail-page retry, the visibility poll, `recentCancels`). If you're about to
 * add a fifth: extend `recentCancels` instead.
 */
export interface PendingOrderEntry {
	/** Always 'post'. A named field rather than nothing, so the shape survives if
	 *  a genuinely different op kind ever needs staging. */
	readonly kind: 'post';
	readonly account: string;
	readonly permlink: string;
	/** The order to display — exactly the record we broadcast. */
	readonly order: OrderRecord;
	readonly addedAt: number;
}

const store = writable<readonly PendingOrderEntry[]>([]);

/** Read-only subscription for components (`$pendingOrders`). */
export const pendingOrders = { subscribe: store.subscribe };

const entryKey = (e: { account: string; permlink: string }): string => orderEchoKey(e);

/**
 * Stage an order the user just successfully broadcast.
 *
 * Call ONLY after the broadcast resolves ok — staging on submit would show an
 * order that may never exist, which is the one thing this store must never do.
 */
export function addPendingOrder(order: OrderRecord, nowMs: number = Date.now()): void {
	store.update((list) =>
		upsertEntry(
			list,
			{
				kind: 'post',
				account: order.account,
				permlink: order.permlink,
				order,
				addedAt: nowMs
			},
			entryKey
		)
	);
}

/** Drop everything. Called on sign-out — another account's session must never
 *  inherit this one's staged orders. */
export function clearPendingOrders(): void {
	store.set([]);
}

/** The still-relevant entries: unconfirmed by the indexer, unexpired. PURE —
 *  pass `$pendingOrders` plus a `nowMs` tick so it re-evaluates as entries age.
 *
 *  NOTE `confirmedKeys` means "the indexer has caught up with this op", not
 *  merely "the indexer knows this order". For a CANCEL that distinction matters:
 *  the order is in the confirmed list the whole time, still reading `live`. See
 *  `mergePendingOrders`. */
export function livePendingOrders(
	pending: readonly PendingOrderEntry[],
	confirmedKeys: ReadonlySet<string>,
	nowMs: number
): readonly PendingOrderEntry[] {
	return liveEntries(pending, entryKey, confirmedKeys, nowMs);
}

/** Which orders in the merged view are still provisional, so the UI can badge
 *  them "confirming". PURE. */
export function pendingOrderKeys(
	pending: readonly PendingOrderEntry[],
	confirmedKeys: ReadonlySet<string>,
	nowMs: number
): ReadonlySet<string> {
	return new Set(livePendingOrders(pending, confirmedKeys, nowMs).map(entryKey));
}

/**
 * Merge the indexer's authoritative orders with the user's own staged posts.
 *
 * Rules:
 *   1. A staged post the indexer hasn't got yet is prepended — newest first,
 *      which is where a just-posted order belongs.
 *   2. A staged post the indexer HAS is dropped. The real row wins: it carries
 *      the derived fields (fee status, trade count, reputation) the staged copy
 *      deliberately never had. This is what stops the user seeing it twice.
 *
 * Cancels are NOT handled here — see the note on PendingOrderEntry. Callers
 * needing cancel-awareness run `applyRecentCancels` over the result.
 *
 * PURE. Never mutates its inputs.
 */
export function mergePendingOrders(
	confirmed: readonly OrderRecord[],
	pending: readonly PendingOrderEntry[],
	nowMs: number
): readonly OrderRecord[] {
	const confirmedKeys = new Set(confirmed.map(entryKey));
	const newPosts = liveEntries(pending, entryKey, confirmedKeys, nowMs).map((e) => e.order);
	return [...newPosts, ...confirmed];
}

/**
 * Find a single order among the indexer's rows plus this browser's staged posts.
 *
 * This is what stops "Order not found" on a freshly-posted order: the confirmed
 * list won't have it for ~45-63s, and this browser has had it since the moment
 * it broadcast.
 *
 * DELIBERATELY CANCEL-BLIND. A caller that also needs cancel-awareness must run
 * `applyRecentCancels` over `mergePendingOrders(...)` itself — see the order
 * detail page. Reaching into `recentCancels` from here would drag sessionStorage
 * into these otherwise-pure functions and give the app a lookup that silently
 * disagreed with `mergePendingOrders`, which is the drift this store's whole
 * design note is about.
 */
export function findOrderWithPending(
	confirmed: readonly OrderRecord[],
	pending: readonly PendingOrderEntry[],
	account: string,
	permlink: string,
	nowMs: number
): OrderRecord | null {
	return (
		mergePendingOrders(confirmed, pending, nowMs).find(
			(o) => o.account === account && o.permlink === permlink
		) ?? null
	);
}
