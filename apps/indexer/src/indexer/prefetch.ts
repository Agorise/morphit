/**
 * prefetch.ts (cp664) — bounded-concurrency prefetch + strictly-in-order consume.
 *
 * The indexer's catch-up backfill must reconcile two opposing pressures:
 *   - the volunteer-run RPC nodes want FEW requests, spread across nodes;
 *   - the database wants SMALL, STRICTLY-ORDERED transactions (block N before
 *     N+1, one block per tx).
 *
 * This helper is the reconciliation. It starts up to `concurrency` fetches
 * AHEAD of consumption and delivers each result to `onValue` in the EXACT order
 * the fetches were STARTED (FIFO) — never completion order. So a slow early
 * fetch still blocks its later, already-finished siblings, which is precisely
 * what lets the poller fetch blocks concurrently yet APPLY them in strict block
 * order.
 *
 * Extracted from poller.tick() so this delicate ordering guarantee can be
 * covered by a deterministic mock smoke (prefetch-in-order-smoke) without a
 * full poller/DB/RPC harness.
 */

/**
 * @param concurrency  How many fetches to keep in flight (>=1; values <1 are
 *   treated as 1). Bounded: never more than this many fetches are outstanding.
 * @param startNext  Produces the NEXT fetch (a promise) each time it is called,
 *   or returns `null` when the source is exhausted. Called eagerly to prime the
 *   pipeline and once per consumed value to refill it. Any per-window state
 *   (cursor, endpoint rotation) lives in this closure.
 * @param onValue  Awaited once per fetched value, in FIFO (start) order. Return
 *   `false` to STOP early — no further values are consumed and any still-in-
 *   flight fetches are abandoned safely (a no-op catch is attached at start, so
 *   an abandoned fetch that later rejects can never become an unhandled
 *   rejection). Returning `true`/`undefined`/`void` continues.
 *
 * A fetch REJECTION is re-thrown from this function at the point that value
 * would have been consumed (FIFO), so a caller `try/catch` around the whole
 * call observes it and decides what to do (the poller logs + backs off + retries
 * on the next tick). `onValue` throwing likewise propagates.
 */
export async function consumeInOrderWithPrefetch<T>(
	concurrency: number,
	startNext: () => Promise<T> | null,
	onValue: (value: T) => boolean | void | Promise<boolean | void>
): Promise<void> {
	const bound = Math.max(1, Math.floor(concurrency));
	const queue: Array<Promise<T>> = [];

	const enqueue = (): boolean => {
		const p = startNext();
		if (p === null) return false;
		// Abandoned-safety: if we stop early (or a later fetch rejects after we've
		// already thrown), an in-flight fetch that rejects must not surface as an
		// unhandled rejection. This extra handler does NOT consume the result — the
		// awaiter below still sees the real value/error.
		p.catch(() => {});
		queue.push(p);
		return true;
	};

	// Prime the pipeline.
	for (let i = 0; i < bound && enqueue(); i++) {
		/* fill */
	}

	// Consume oldest-first. `await` on the shifted (oldest) promise blocks until
	// THAT fetch resolves even if newer ones already have — this is the in-order
	// guarantee. Refill AFTER the await so the outstanding count is bounded by
	// `concurrency` (never concurrency+1) while onValue runs.
	while (queue.length > 0) {
		const value = await queue.shift()!;
		enqueue();
		const keepGoing = await onValue(value);
		if (keepGoing === false) break;
	}
}
