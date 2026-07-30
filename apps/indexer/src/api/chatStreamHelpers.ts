/**
 * Morphit indexer — chat-stream pure helpers (Phase E.5).
 *
 * Filter-matching predicate, row→wire mapping, and SSE frame
 * formatter.  Extracted from chatStream.ts so the tsx smoke
 * runner can exercise them without needing Hono in its
 * module-resolution graph.
 *
 * Mirror of orderbookStreamHelpers / instancesStreamHelpers.
 */

import { isAccountName } from '$api/shared';

/** A chat message row as the wire format. Same shape as the
 *  REST /v1/chat/:a/:b items. */
export interface ChatStreamRow {
	id: number;
	sender: string;
	recipient: string;
	ciphertext: string;
	header: unknown;
	created_at: Date;
	/** Blurt transaction id of the custom_json op that anchored this
	 *  message on-chain. The immutable, signed, publicly-verifiable
	 *  proof that `sender` authored this message at `created_at` — used
	 *  by the chat PDF export as courtroom-grade evidence. */
	source_trx_id: string;
	/** cp446 — the order this message is about, or null. Threads the inbox
	 *  (one card per peer+order) and scopes the transcript, so a live message
	 *  about order A never appears in the discussion about order B. */
	order_permlink: string | null;
}

/** Subscriber's filter — the canonical pair this connection is
 *  subscribed to. */
export interface ChatStreamFilter {
	readonly lo: string;
	readonly hi: string;
}

/** Convert a raw DB row to the wire shape the frontend expects.
 *
 * cp470 — `order_permlink` MUST be included. The client threads a chat by
 * (peer, order) and drops any live message whose `order_permlink` doesn't
 * match the open thread (the cp446 order-thread filter in chatService.ts).
 * Omitting it here shipped every SSE event (snapshot, fast-path provisional,
 * and durable bus push) with an implicit `null` tag, so live messages in an
 * ORDER thread were filtered out and only surfaced ~one main-indexer lag
 * later via the REST fallback poll (which serializes the tag correctly) —
 * the ~60s "fast chat is broken" symptom. General (order-less) threads were
 * unaffected because their tag is genuinely null. Both DB queries already
 * SELECT it and `ChatStreamRow` already carries it; it just wasn't copied. */
export function rowToWire(r: ChatStreamRow): {
	id: number;
	sender: string;
	recipient: string;
	ciphertext: string;
	header: unknown;
	created_at: string;
	source_trx_id: string;
	order_permlink: string | null;
} {
	return {
		id: r.id,
		sender: r.sender,
		recipient: r.recipient,
		ciphertext: r.ciphertext,
		header: r.header,
		created_at: r.created_at.toISOString(),
		source_trx_id: r.source_trx_id,
		order_permlink: r.order_permlink
	};
}

/** Validate + canonicalize the (a, b) URL params into a filter.
 *  Returns null on invalid input so the route can 400 cleanly. */
export function parseFilter(a: string, b: string): ChatStreamFilter | { error: string } {
	if (!isAccountName(a) || !isAccountName(b)) {
		return { error: 'invalid account name(s)' };
	}
	if (a === b) {
		return { error: 'self-chat not allowed' };
	}
	return a < b ? { lo: a, hi: b } : { lo: b, hi: a };
}

/** SSE frame formatter — same shape as the orderbook + instances
 *  streams.  Each event is `event: NAME\ndata: JSON\n\n`. */
export function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Returns true iff the bus event matches this subscriber's
 *  conversation pair.  Filter and event are both canonicalized
 *  (lo<hi) so equality is a pure string comparison. */
export function eventMatchesFilter(ev: { lo: string; hi: string }, f: ChatStreamFilter): boolean {
	return ev.lo === f.lo && ev.hi === f.hi;
}
