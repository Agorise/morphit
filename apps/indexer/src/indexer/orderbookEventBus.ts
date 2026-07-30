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

/**
 * v1.7.0 (ADR-0051) — a head-block op that changes an EXISTING order's status,
 * seen ~45-63s before the durable poller will apply it.
 *
 * WHY THIS IS A SEPARATE CHANNEL FROM `emit`. The durable contract is "here's an
 * order id, go re-query the table" — which works precisely because the row is
 * already committed when it fires. A provisional event is the opposite: the row
 * still holds the OLD status, so a re-query would return the pre-change state
 * and the subscriber would emit `order_upserted` with stale data. Reusing the
 * same channel would mean every listener had to know which kind it was looking
 * at, which is how a listener eventually gets it wrong.
 *
 * WHY IT CAN ONLY EVER REMOVE. Provisional order events carry a status
 * TRANSITION on an order that already exists durably — never a new order. That
 * is a hard safety boundary, not a scope decision:
 *
 *   - The public orderbook gates on `fee_status IN ('verified',
 *     'verified_by_attestation')`. A head-block `morphit_order_v1` has NOT had
 *     its fee verified — verification is money, which ADR-0051 keeps durable-only
 *     — so publishing one provisionally would let anyone put unpaid orders in
 *     front of every user for ~60s at a time. A fee bypass with extra steps.
 *   - `morphit_order_replace_v1` carries the order's free text, so a rejected
 *     edit could flash arbitrary content into every open orderbook.
 *
 * `morphit_order_cancel_v1` and `morphit_order_complete_v1` carry no free text
 * at all (a permlink, and for complete a counterparty name), act on an order
 * that is already fee-verified and public, and are signed by the owner. The
 * worst a bogus one can do is make an order briefly vanish from live views and
 * reappear on the next durable pass — bounded, self-correcting, and impossible
 * to spam WITH.
 */
export interface ProvisionalOrderEvent {
	/** `account/permlink` — the same order id shape the durable channel uses. */
	readonly orderId: string;
	/** The transition seen at head. Both remove the order from live views. */
	readonly kind: 'cancelled' | 'completed';
}

export type ProvisionalOrderListener = (event: ProvisionalOrderEvent) => void;

/**
 * cp508 (tt.txt #1/#2) — a short-lived memory of orders the fast path has
 * provisionally REMOVED (a cancel/complete seen at head), so a freshly-opened
 * orderbook stream doesn't re-show them.
 *
 * THE GAP THIS CLOSES. `emitProvisional` is fire-and-forget with no memory: an
 * already-open orderbook stream gets the removal in ~2s, but a stream that
 * connects AFTER the event fired takes its snapshot from the durable table —
 * where the poller is still ~45-63s behind and the row still says 'live' — so
 * the cancelled order reappears for up to a minute (the "took almost a minute
 * to disappear" report). Recording the id here and having the snapshot +
 * fallback queries skip it makes removal ~2s for fresh views too.
 *
 * TTL = 90s: comfortably longer than the durable poller's catch-up window, so
 * by the time an entry is pruned the poller has swept the row to
 * cancelled/completed and it fails the visibility query on its own —
 * self-healing. If the head op is orphaned by a reorg the order simply
 * reappears after the TTL, the same bounded, self-correcting trade-off the
 * fast path already makes (ADR-0051 invariant #3).
 */
const RECENTLY_REMOVED_TTL_MS = 90_000;

class OrderbookEventBus {
	private readonly listeners: Set<OrderbookListener> = new Set();
	private readonly provisionalListeners: Set<ProvisionalOrderListener> = new Set();
	/** orderId → epoch-ms expiry. Populated by emitProvisional; read by
	 *  isRecentlyRemoved. See RECENTLY_REMOVED_TTL_MS. */
	private readonly recentlyRemoved: Map<string, number> = new Map();

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

	/** Subscribe to head-block (provisional) order status changes.  Returns an
	 *  unsubscribe function; the SSE handler calls it on connection close. */
	onProvisional(listener: ProvisionalOrderListener): () => void {
		this.provisionalListeners.add(listener);
		return () => {
			this.provisionalListeners.delete(listener);
		};
	}

	/** Emit a provisional order status change.  Same fire-and-forget contract as
	 *  `emit`: synchronous, listeners' throws are contained.
	 *
	 *  MUST NOT be called from anywhere that writes the database. The head tailer
	 *  is the only caller by design — see ADR-0051 invariant #1. */
	emitProvisional(event: ProvisionalOrderEvent): void {
		// Remember it so a fresh snapshot skips this order until the durable
		// poller catches up (see RECENTLY_REMOVED_TTL_MS).
		this.recentlyRemoved.set(event.orderId, Date.now() + RECENTLY_REMOVED_TTL_MS);
		const snapshot = Array.from(this.provisionalListeners);
		for (const listener of snapshot) {
			try {
				listener(event);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`orderbook-event-bus: provisional listener threw: ${msg}\n`);
			}
		}
	}

	/** True if `orderId` was provisionally removed within the last
	 *  RECENTLY_REMOVED_TTL_MS. Prunes expired entries on every call, which
	 *  also bounds the map (each entry lives at most the TTL). The orderbook
	 *  snapshot + fallback queries call this to skip a just-cancelled/completed
	 *  order the durable table hasn't caught up on yet. */
	isRecentlyRemoved(orderId: string): boolean {
		const now = Date.now();
		for (const [id, expiry] of this.recentlyRemoved) {
			if (expiry <= now) this.recentlyRemoved.delete(id);
		}
		const expiry = this.recentlyRemoved.get(orderId);
		return expiry !== undefined && expiry > now;
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
