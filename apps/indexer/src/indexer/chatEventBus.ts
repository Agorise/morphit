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

/**
 * cp403 [1] — head-block fast-path event.
 *
 * Emitted by the chatHeadTailer (ADR-0048) for a chat message seen in
 * a chain HEAD block, BEFORE it is irreversible and therefore before
 * the durable poller has inserted it into `chat_messages`. Because
 * there is no DB row yet, this event carries the FULL message payload
 * (unlike the durable `ChatEvent`, which carries only a row id the SSE
 * handler re-fetches). The SSE handler pushes it straight to matching
 * subscribers as a provisional `message_appended` with `id: 0`.
 *
 * The client dedupes this provisional message against its later durable
 * twin by the on-chain `clientTag` (present in the header of every
 * Morphit-composed message), so the two never render twice.
 *
 * INVARIANT: nothing on this path touches the database. A reorg that
 * orphans a message shown via the fast path is an accepted trade-off —
 * chat is low-stakes and the message simply never reaches durable
 * history. Orders, fees, and transfers are NEVER carried on this path.
 */
export interface ChatFastEvent {
	/** LEAST(sender, recipient) — canonical pair-low. */
	readonly lo: string;
	/** GREATEST(sender, recipient) — canonical pair-high. */
	readonly hi: string;
	readonly sender: string;
	readonly recipient: string;
	/** base64 opaque ciphertext, exactly as seen on chain. */
	readonly ciphertext: string;
	/** The message header object (ephemeral_pub, nonce, client_tag),
	 *  opaque to the indexer — forwarded verbatim to the client. */
	readonly header: unknown;
	/** Block timestamp of the head block the op appeared in. */
	readonly createdAt: Date;
	/** The on-chain `client_tag` from the header, or null if absent —
	 *  the key the client uses to dedupe this provisional message
	 *  against its durable twin. Extracted once here so SSE subscribers
	 *  don't each re-parse the header. */
	readonly clientTag: string | null;
	/** cp446 — the order this message is about, or null. Threads the inbox and
	 *  scopes the transcript; see chatStream.ts. */
	readonly orderPermlink: string | null;
}

export type ChatFastListener = (ev: ChatFastEvent) => void;

class ChatEventBus {
	private readonly listeners: Set<ChatListener> = new Set();
	/** cp403 [1] — separate listener set for head-block fast-path
	 *  events. Kept distinct from the durable listeners so the two
	 *  channels can't be accidentally cross-wired. */
	private readonly fastListeners: Set<ChatFastListener> = new Set();

	/** Subscribe a listener.  Returns an unsubscribe function;
	 *  the SSE handler calls it on connection close. */
	on(listener: ChatListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** cp403 [1] — subscribe to head-block fast-path events. Returns an
	 *  unsubscribe function; the SSE handler calls it on close. */
	onFast(listener: ChatFastListener): () => void {
		this.fastListeners.add(listener);
		return () => {
			this.fastListeners.delete(listener);
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

	/** cp403 [1] — emit a head-block fast-path event. Same
	 *  fire-and-forget, error-isolating discipline as `emit`. */
	emitFast(ev: ChatFastEvent): void {
		const snapshot = Array.from(this.fastListeners);
		for (const listener of snapshot) {
			try {
				listener(ev);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`chat-event-bus: fast listener threw: ${msg}\n`);
			}
		}
	}

	/** Number of active subscribers.  Surfaced via /v1/health
	 *  verbose so operators can confirm the bus is wired and
	 *  see how many tabs are watching live chats. */
	get subscriberCount(): number {
		return this.listeners.size;
	}

	/** cp403 [1] — count of active fast-path subscribers (same as
	 *  subscriberCount; the SSE handler subscribes to both channels,
	 *  so this normally equals subscriberCount when the fast path is
	 *  enabled). Surfaced on /v1/health verbose. */
	get fastSubscriberCount(): number {
		return this.fastListeners.size;
	}
}

/** Process-wide singleton bus.  Imported by both the
 *  dispatcher (which calls emit from the chat handler) and the
 *  SSE handler (which calls on()). */
export const chatEventBus = new ChatEventBus();
