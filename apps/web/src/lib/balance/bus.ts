/**
 * Balance refresh bus — tiny pub-sub for nudging MyBalanceCard
 * to refetch immediately rather than waiting for its next poll
 * tick.
 *
 * Why a bus rather than a Svelte store:
 *   - The trigger is event-shaped (a momentary "go now"), not
 *     state-shaped (a value to track over time).  A store would
 *     require subscribers to carry their own seen-vs-unseen
 *     bookkeeping and ignore back-to-back identical values.
 *     A simple subscribe-and-fire bus is the right primitive.
 *
 *   - MyBalanceCard is the only consumer today; this module is
 *     deliberately small and not over-built.  If more components
 *     ever need balance-refresh signals (e.g. a wallet badge in
 *     the header), they subscribe to the same bus.  Multiple
 *     subscribers are supported but expected to be rare.
 *
 * Usage from a producer (e.g. fee broadcast success, mark-as-
 * sent confirmation, address-share ack received):
 *
 *     import { triggerBalanceRefresh } from '$lib/balance/bus';
 *     triggerBalanceRefresh();
 *
 * Usage from a consumer (e.g. MyBalanceCard mount):
 *
 *     import { subscribeBalanceRefresh } from '$lib/balance/bus';
 *     const unsubscribe = subscribeBalanceRefresh(() => {
 *         void refresh();
 *     });
 *     onDestroy(unsubscribe);
 *
 * The bus does NOT debounce, snapshot, or queue.  Subscribers are
 * called synchronously on every trigger.  If a subscriber kicks
 * off an async refresh, that's the subscriber's concern.  In
 * practice MyBalanceCard's refresh is idempotent — overlapping
 * refreshes just produce two RPC calls; the second wins.
 *
 * Memory model: subscribers form a Set.  No reference cycles
 * because callers always unsubscribe in onDestroy.  In SSR the
 * module loads but is never triggered (no producer fires server-
 * side); the Set stays empty.
 */

export type BalanceRefreshHandler = () => void;

const subscribers = new Set<BalanceRefreshHandler>();

/** Notify all subscribers that someone should refetch their
 *  balance NOW.  Idempotent: calling multiple times in quick
 *  succession just fires the handlers multiple times.  Do not
 *  call from a hot loop. */
export function triggerBalanceRefresh(): void {
	for (const fn of subscribers) {
		try {
			fn();
		} catch {
			// A faulty subscriber must not break the bus for the
			// others.  Swallow per-handler errors silently; the
			// pattern is best-effort UI nudging, not a correctness
			// channel.
		}
	}
}

/** Register a handler to be called when balance-refresh is
 *  triggered.  Returns an unsubscribe function.  Always call the
 *  unsubscribe in onDestroy to avoid handler leaks across page
 *  navigations. */
export function subscribeBalanceRefresh(fn: BalanceRefreshHandler): () => void {
	subscribers.add(fn);
	return () => {
		subscribers.delete(fn);
	};
}

/** Test-only — drains the subscriber set so isolated test cases
 *  don't see leaks from earlier setup. */
export function _resetBalanceRefreshBus(): void {
	subscribers.clear();
}
