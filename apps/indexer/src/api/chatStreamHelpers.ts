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
}

/** Subscriber's filter — the canonical pair this connection is
 *  subscribed to. */
export interface ChatStreamFilter {
	readonly lo: string;
	readonly hi: string;
}

/** Convert a raw DB row to the wire shape the frontend expects. */
export function rowToWire(r: ChatStreamRow): {
	id: number;
	sender: string;
	recipient: string;
	ciphertext: string;
	header: unknown;
	created_at: string;
} {
	return {
		id: r.id,
		sender: r.sender,
		recipient: r.recipient,
		ciphertext: r.ciphertext,
		header: r.header,
		created_at: r.created_at.toISOString()
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
