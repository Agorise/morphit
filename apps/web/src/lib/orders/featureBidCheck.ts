/**
 * What a feature bid will do, checked before it is signed, and what the
 * indexer made of it afterwards.
 *
 * The bid's BLURT moves on chain with the op whatever the indexer decides, and
 * a refused bid's BLURT is not returned (apps/indexer/src/indexer/handlers/
 * featureBid.ts). So the form checks first what it can see — the order is
 * live and its listing fee verified; how the bid ranks against the visible
 * slots — and after broadcasting it waits for the indexer's record of the bid
 * before saying "featured".
 */

import type {
	FeaturedBidHistoryEntry,
	FeaturedOrderbookResponse,
	OrderRecord
} from '@morphit/indexer-client';

/** The indexer's minimum step to take a visible slot from its holder:
 *  max(1 BLURT/hour, 5 %) over the lowest visible bid. */
export function requiredToDisplace(lowestVisibleRate: number): number {
	return Math.max(lowestVisibleRate + 1, lowestVisibleRate * 1.05);
}

export type BidOutlook =
	/** The order can't be featured: a bid now would pay for nothing. */
	| { readonly kind: 'blocked'; readonly reason: 'not_found' | 'not_live' | 'fee_not_verified' }
	/** A free slot, or the bid outranks the lowest visible one by the step. */
	| { readonly kind: 'visible' }
	/** Every slot is held by a bid at least as high: the bid is recorded and
	 *  shows when a slot frees (`freesAt`: the earliest visible expiry). */
	| { readonly kind: 'waits'; readonly lowestRate: number; readonly freesAt: string | null }
	/** Higher than the lowest visible bid but by less than the step: the
	 *  indexer refuses it (or, once its stricter rules are active, queues it),
	 *  so the form does not send it. */
	| { readonly kind: 'too_small'; readonly lowestRate: number; readonly required: number };

/** The outlook of a bid paying `ratePerHour` on `order`, against the slots
 *  /v1/orderbook/featured shows now. `featured` null (the read failed) is
 *  treated as free slots: the order checks still apply. */
export function bidOutlook(
	order: Pick<OrderRecord, 'status' | 'fee_status' | 'expires_at'> | null,
	featured: Pick<FeaturedOrderbookResponse, 'featured' | 'max_slots'> | null,
	ratePerHour: number,
	nowMs: number
): BidOutlook {
	if (order === null) return { kind: 'blocked', reason: 'not_found' };
	const expired =
		order.expires_at !== null &&
		order.expires_at !== undefined &&
		Number.isFinite(Date.parse(order.expires_at)) &&
		Date.parse(order.expires_at) <= nowMs;
	if (order.status !== 'live' || expired) return { kind: 'blocked', reason: 'not_live' };
	if (order.fee_status !== 'verified' && order.fee_status !== 'verified_by_attestation') {
		return { kind: 'blocked', reason: 'fee_not_verified' };
	}
	if (featured === null || featured.featured.length < featured.max_slots)
		return { kind: 'visible' };

	const rates = featured.featured
		.map((s) => Number(s.bid.blurt_per_hour))
		.filter((r) => Number.isFinite(r));
	if (rates.length === 0) return { kind: 'visible' };
	const lowestRate = Math.min(...rates);
	if (ratePerHour <= lowestRate) {
		const expiries = featured.featured
			.map((s) => s.bid.expires_at)
			.filter((e) => Number.isFinite(Date.parse(e)))
			.sort();
		return { kind: 'waits', lowestRate, freesAt: expiries[0] ?? null };
	}
	const required = requiredToDisplace(lowestRate);
	if (ratePerHour < required) return { kind: 'too_small', lowestRate, required };
	return { kind: 'visible' };
}

export type BidVerdict =
	/** The indexer has not recorded the bid (yet). */
	| { readonly kind: 'pending' }
	/** Recorded and showing in a featured slot. */
	| { readonly kind: 'visible' }
	/** Recorded; it starts later (queued behind the slot it waits for). */
	| { readonly kind: 'queued'; readonly startsAt: string }
	/** Recorded and running, but outranked: it shows when a slot frees. */
	| { readonly kind: 'waiting' };

/** The indexer's record of a bid just broadcast for `permlink`: a bid on that
 *  order that was not in the history read before signing. */
export function bidVerdict(
	before: readonly Pick<FeaturedBidHistoryEntry, 'order_permlink' | 'effective_at'>[],
	after: readonly Pick<
		FeaturedBidHistoryEntry,
		'order_permlink' | 'effective_at' | 'expires_at' | 'is_visible'
	>[],
	permlink: string,
	nowMs: number
): BidVerdict {
	const seen = new Set(
		before.filter((b) => b.order_permlink === permlink).map((b) => b.effective_at)
	);
	const fresh = after.find((b) => b.order_permlink === permlink && !seen.has(b.effective_at));
	if (fresh === undefined) return { kind: 'pending' };
	if (fresh.is_visible) return { kind: 'visible' };
	const starts = Date.parse(fresh.effective_at);
	if (Number.isFinite(starts) && starts > nowMs)
		return { kind: 'queued', startsAt: fresh.effective_at };
	return { kind: 'waiting' };
}
