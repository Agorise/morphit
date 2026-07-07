/**
 * Morphit explorer — listings histogram aggregator (Batch K).
 *
 * Pure: takes a list of orderbook items and computes side × asset
 * counts for the activity-page bar chart.
 *
 * Design choice (per user discussion): we deliberately do NOT
 * compute a depth chart (cumulative bid-ask volume) because
 * Morphit isn't a matching-engine exchange.  Each listing has its
 * own payment methods, region, and negotiation requirement.
 * Showing them aggregated as if they were fungible bids/asks
 * would be misleading.
 *
 * What we DO show: a simple breakdown of "how many active buy
 * listings vs sell listings exist per asset," which gives a
 * sense of market liquidity (lots of buyers vs lots of sellers)
 * without faking exchange semantics.
 *
 * Pure — smoke-testable.
 */

export interface ListingsCount {
	readonly asset: string;
	readonly buy_count: number;
	readonly sell_count: number;
}

/** Minimal subset of OrderRecord this helper needs.  Lets the
 *  smoke pass plain objects without dragging in the full type. */
export interface ListingHistogramItem {
	readonly side: 'buy' | 'sell';
	readonly asset: string;
}

/** Aggregate a list of live listings into per-asset buy/sell
 *  counts.  Output is sorted alphabetically by asset for
 *  deterministic display.  Items with malformed side or asset
 *  fields are silently dropped — better to drop one bad row than
 *  refuse the whole histogram. */
export function aggregateListingHistogram(items: readonly ListingHistogramItem[]): ListingsCount[] {
	const map = new Map<string, { buy: number; sell: number }>();
	for (const item of items) {
		if (typeof item.asset !== 'string' || item.asset.length === 0) continue;
		if (item.side !== 'buy' && item.side !== 'sell') continue;
		const key = item.asset;
		const cur = map.get(key) ?? { buy: 0, sell: 0 };
		if (item.side === 'buy') cur.buy++;
		else cur.sell++;
		map.set(key, cur);
	}
	const out: ListingsCount[] = [];
	for (const [asset, counts] of map.entries()) {
		out.push({ asset, buy_count: counts.buy, sell_count: counts.sell });
	}
	out.sort((a, b) => a.asset.localeCompare(b.asset));
	return out;
}

/** Convenience: total listings across all assets (sum of all
 *  buy + sell counts). */
export function totalListings(items: readonly ListingHistogramItem[]): number {
	let n = 0;
	for (const item of items) {
		if (typeof item.asset !== 'string' || item.asset.length === 0) continue;
		if (item.side !== 'buy' && item.side !== 'sell') continue;
		n++;
	}
	return n;
}
