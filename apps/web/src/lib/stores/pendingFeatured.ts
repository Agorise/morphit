/**
 * pendingFeatured — optimistic, DISPLAY-ONLY featured slots (cp431).
 *
 * WHY. The featured section is computed by the indexer from everyone's
 * feature bids (top MAX_SLOTS win). The durable indexer applies blocks
 * only up to last-irreversible (ADR-0008), ~50-90s behind the chain
 * head, so a freshly-broadcast feature bid takes ~a minute to surface.
 * The chat fast-path (chatHeadTailer) is DELIBERATELY chat-only — a
 * head-block op isn't irreversible and must never drive money/state, so
 * paid feature bids are (correctly) excluded from it.
 *
 * But the person who just paid to feature their OWN order already knows
 * what they featured — their browser doesn't need the indexer to show
 * it. This store lets the `my/orders` "Pay and feature" flow drop the
 * order in here on a successful broadcast and immediately send the user
 * to the orderbook, where FeaturedOrders shows it within the 6s window.
 *
 * SAFETY / INVARIANTS.
 *   - DISPLAY ONLY. Never touches money, the DB, fee verification, or
 *     the real slot allocation. The durable indexer stays the SOLE
 *     source of truth and SUPERSEDES anything here.
 *   - SELF-RECONCILING. FeaturedOrders drops a pending entry the instant
 *     the indexer's confirmed list contains it (the real slot takes
 *     over), and hides any entry older than PENDING_TTL_MS — so if the
 *     bid didn't win a slot (all MAX_SLOTS taken by higher bids), the
 *     optimistic card simply fades out on its own rather than lying
 *     forever. Same provisional-then-durable model as fast chat.
 *   - LOCAL ONLY. In-memory module store; nothing persists across a
 *     reload. A refresh falls back to the (authoritative) indexer view.
 */

import { writable } from 'svelte/store';
import type { FeaturedSlot, OrderRecord } from '@morphit/indexer-client';

/** ~2.5 min: Blurt's last-irreversible lag (~60s) plus generous margin
 *  so a slow indexer catch-up doesn't drop the card before it confirms,
 *  while a losing bid still clears in bounded time. */
export const PENDING_TTL_MS = 150_000;

export interface PendingFeaturedSlot {
	readonly slot: FeaturedSlot;
	readonly addedAt: number;
}

const slotKey = (o: { account: string; permlink: string }): string => `${o.account}/${o.permlink}`;

const store = writable<readonly PendingFeaturedSlot[]>([]);

/** Read-only subscription for components (`$pendingFeatured`). */
export const pendingFeatured = { subscribe: store.subscribe };

/**
 * Optimistically show an order the CURRENT USER just paid to feature.
 * `blurtPaid` is only used to populate a placeholder bid (the featured
 * card renders from `slot.order`, never `slot.bid`, so the bid values
 * are cosmetic and never shown).
 */
export function addPendingFeatured(order: OrderRecord, blurtPaid: number): void {
	const now = Date.now();
	const slot: FeaturedSlot = {
		order,
		bid: {
			hours_requested: 6,
			blurt_paid: String(blurtPaid),
			blurt_per_hour: '0',
			effective_at: new Date(now).toISOString(),
			expires_at: new Date(now + 6 * 3_600_000).toISOString()
		}
	};
	store.update((list) => [
		...list.filter((p) => slotKey(p.slot.order) !== slotKey(order) && now - p.addedAt < PENDING_TTL_MS),
		{ slot, addedAt: now }
	]);
}

/**
 * The optimistic slots to merge into the featured display: those NOT
 * already confirmed by the indexer and NOT expired. Pass the reactive
 * store value (`$pendingFeatured`) and the component's `nowMs` tick so
 * it re-evaluates as entries age out. Pure — never mutates the store.
 */
export function mergeablePending(
	pending: readonly PendingFeaturedSlot[],
	confirmedKeys: ReadonlySet<string>,
	nowMs: number
): readonly FeaturedSlot[] {
	return pending
		.filter((p) => !confirmedKeys.has(slotKey(p.slot.order)) && nowMs - p.addedAt < PENDING_TTL_MS)
		.map((p) => p.slot);
}

export { slotKey as pendingFeaturedKey };
