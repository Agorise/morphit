/**
 * Morphit indexer — chat message event bus (Phase E.5).
 *
 * In-process pub/sub for new chat messages.  The chat handler
 * emits after a successful INSERT; SSE conversation-stream
 * connections subscribe.  Singleton because the bus has zero
 * state besides listener lists (mirror of orderbookEventBus).
 *
 * Event payload carries the canonical conversation pair (lo,
 * hi) plus the message id.  Subscribers filter by pair without
 * needing a DB lookup just to check membership; only the
 * matching subscribers spend a single-row fetch to obtain the
 * full message body.
 *
 * Why not just messageId: at 100 subscribers × 10 messages per
 * block, "fetch every message to check pair membership" is 1000
 * point queries per block.  Carrying the pair on the event
 * means only matching subscribers (typically 0-2) issue a
 * fetch.
 *
 * Why include messageId rather than the full row: the on-chain
 * INSERT happens inside the handler savepoint; reading the row
 * back from the same transaction would be possible but would
 * couple emission timing to row-shape.  Keeping the bus's
 * payload minimal (3 strings + a number) and re-fetching the
 * row from the SSE handler matches the orderbook bus pattern
 * exactly.
 *
 * No backpressure.  A handler that emits to a stalled
 * subscriber doesn't block — the SSE handler's ReadableStream
 * stalls and the browser eventually disconnects.
 *
 * Why not node:events: its `error` event throws if unhandled,
 * which would let a dropped subscription crash the indexer.
 * Same reasoning as orderbookEventBus.
 */

export interface ChatEvent {
	/** LEAST(sender, recipient) — canonical pair-low. */
	readonly lo: string;
	/** GREATEST(sender, recipient) — canonical pair-high. */
	readonly hi: string;
	/** chat_messages.id of the newly-inserted row. */
	readonly messageId: number;
}

export type ChatListener = (ev: ChatEvent) => void;

class ChatEventBus {
	private readonly listeners: Set<ChatListener> = new Set();

	/** Subscribe a listener.  Returns an unsubscribe function;
	 *  the SSE handler calls it on connection close. */
	on(listener: ChatListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Emit an event.  Synchronous fire-and-forget — listeners
	 *  catch their own errors so one bad subscriber doesn't
	 *  poison the rest. */
	emit(ev: ChatEvent): void {
		// Snapshot the listener set before iteration so a listener
		// unsubscribing during dispatch doesn't skip its peers.
		const snapshot = Array.from(this.listeners);
		for (const listener of snapshot) {
			try {
				listener(ev);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`chat-event-bus: listener threw: ${msg}\n`);
			}
		}
	}

	/** Number of active subscribers.  Surfaced via /v1/health
	 *  verbose so operators can confirm the bus is wired and
	 *  see how many tabs are watching live chats. */
	get subscriberCount(): number {
		return this.listeners.size;
	}
}

/** Process-wide singleton bus.  Imported by both the
 *  dispatcher (which calls emit from the chat handler) and the
 *  SSE handler (which calls on()). */
export const chatEventBus = new ChatEventBus();
