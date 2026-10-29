import type { OrderRecord } from '@morphit/indexer-client';

/** When a completed order's trade was completed: its completed_at (the
 *  completion op's block time). An older indexer sends none; then its last
 *  change, the best time there is. Never updated_at when completed_at is
 *  there — a fee re-check, an attestation or the partner named later moves
 *  updated_at, and the trade would read as newer than it is. */
export function tradeTimeOf(o: Pick<OrderRecord, 'completed_at' | 'updated_at'>): string {
	return o.completed_at ?? o.updated_at;
}

/** Newest trade first. */
export function byTradeTimeDesc(
	a: Pick<OrderRecord, 'completed_at' | 'updated_at'>,
	b: Pick<OrderRecord, 'completed_at' | 'updated_at'>
): number {
	return Date.parse(tradeTimeOf(b)) - Date.parse(tradeTimeOf(a));
}
