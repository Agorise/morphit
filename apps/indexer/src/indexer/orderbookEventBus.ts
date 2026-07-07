/**
 * Morphit indexer — orderbook mutation event bus (Phase E).
 *
 * In-process pub/sub for orderbook state changes.  Order
 * handlers emit; SSE connections subscribe.  Singleton
 * because the bus has zero state besides listener lists, so
 * no need for the explicit dependency-injection plumbing a
 * factory would require.
 *
 * Event payload is just the order_id.  Subscribers re-query
 * the orders table to get the current row state.  This keeps
 * the bus's in-memory contract minimal (one string per event)
 * and ensures subscribers see the post-handler-commit view of
 * the row, including any side effects (fee_status changes
 * triggered by the same op, materialized derivations, etc.)
 *
 * No backpressure.  A handler that emits to a stalled
 * subscriber (slow connection, browser tab in background)
 * doesn't block — the SSE handler's ReadableStream will stall
 * and the browser will eventually disconnect.  The bus has no
 * memory of what's been emitted.
 *
 * Why not node:events: its `error` event throws if unhandled,
 * which would let a dropped subscription crash the indexer.
 * A purpose-built emitter avoids that footgun.
 */

export type OrderbookListener = (orderId: string) => void;

class OrderbookEventBus {
	private readonly listeners: Set<OrderbookListener> = new Set();

	/** Subscribe a listener.  Returns an unsubscribe function;
	 *  the SSE handler calls it on connection close. */
	on(listener: OrderbookListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Emit an event.  Synchronous fire-and-forget — listeners
	 *  catch their own errors so one bad subscriber doesn't
	 *  poison the rest. */
	emit(orderId: string): void {
		// Snapshot the listener set before iteration so a listener
		// unsubscribing during dispatch doesn't skip its peers.
		const snapshot = Array.from(this.listeners);
		for (const listener of snapshot) {
			try {
				listener(orderId);
			} catch (err) {
				// Listener threw; log and continue.  Errors should
				// already be caught inside SSE handlers (which wrap
				// their work), so reaching here is a programmer bug
				// worth surfacing in journal.
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`orderbook-event-bus: listener threw: ${msg}\n`);
			}
		}
	}

	/** Number of active subscribers.  Used by the diagnostics
	 *  block in /v1/health when verbose mode is on. */
	get subscriberCount(): number {
		return this.listeners.size;
	}
}

/** Process-wide singleton bus.  Imported by both the
 *  dispatcher (which calls emit from order handlers) and the
 *  SSE handler (which calls on()). */
export const orderbookEventBus = new OrderbookEventBus();
