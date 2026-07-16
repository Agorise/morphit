/**
 * pendingFeatured — optimistic, DISPLAY-ONLY featured slots (cp431).
 *
 * WHY. The featured section is computed by the indexer from everyone's
 * feature bids (top MAX_SLOTS win). The durable indexer applies blocks
 * only up to last-irreversible (ADR-0008), ~50-90s behind the chain
 * head, so a freshly-broadcast feature bid takes ~a minute to surface.
 * The chat fast-path (headTailer) is DELIBERATELY chat-only — a
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
import { PENDING_TTL_MS, liveEntries, upsertEntry, orderEchoKey } from './pendingEcho';

// v1.7.0 — the TTL and the expiry/dedupe rules moved to `pendingEcho`, shared
// with `pendingOrders`. They encode facts about the CHAIN (how long
// last-irreversible takes), not about featured slots, so a change to one is a
// change to both — and two hand-copies is exactly how they drift apart, one
// getting a fix the other doesn't while both still look right.
// Re-exported so this module's public API is unchanged for its callers.
export { PENDING_TTL_MS };

export interface PendingFeaturedSlot {
	readonly slot: FeaturedSlot;
	readonly addedAt: number;
}

/** Shared with every other echo store, so two of them can't disagree about what
 *  "the same order" means. */
const slotKey = orderEchoKey;

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
	store.update((list) => upsertEntry(list, { slot, addedAt: now }, (p) => slotKey(p.slot.order)));
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
	return liveEntries(pending, (p) => slotKey(p.slot.order), confirmedKeys, nowMs).map((p) => p.slot);
}

export { slotKey as pendingFeaturedKey };
