/**
 * recentOutboundChat — who, on THIS instance, has just messaged whom.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The fast path only notifies a recipient when it can see that the conversation
 * is wanted: either the sender is answering the recipient's own live order, or
 * the recipient has written to that sender before. Both are read from
 * `chat_messages`, the durable table — and the durable table is 45 to 63 seconds
 * behind, because the poller only applies irreversible blocks.
 *
 * So the ordinary marketplace exchange broke in the reply direction, which is
 * the half the person is actually waiting on:
 *
 *   1. A buyer messages a seller about the seller's order. The seller's instance
 *      sees a message answering the recipient's own live order, notifies, and
 *      the seller has it in seconds. This half always worked.
 *
 *   2. The seller replies. On the BUYER's instance the order belongs to the
 *      seller, not to the recipient, so that bypass does not apply — and
 *      "has the buyer written to this seller?" is answered from a durable table
 *      that has not caught up with the buyer's own opening message yet. Both
 *      tests fail, so no notification. The buyer, who started the conversation
 *      thirty seconds ago, hears nothing until the chain catches up.
 *
 * Measured before the fix: `fastNotifyAllowed` returned false for exactly that
 * exchange.
 *
 * WHAT THIS ADDS, AND WHY IT IS NOT A SPAM DOOR
 *
 * The missing fact was never really missing — the buyer's instance RELAYED the
 * buyer's message itself, through its own `/v1/broadcast`. It has first-hand
 * knowledge that this account just wrote to that one, minutes before the durable
 * table will admit it. This module is that knowledge, kept briefly.
 *
 * It cannot be used to talk your way in:
 *
 *   - An entry is written only for a message THIS INSTANCE relayed, and only
 *     AFTER the Blurt node accepted it. The node validates the signature and
 *     posting authority, so an entry means the named sender really did send it.
 *     Posting a forged transaction here writes nothing, because the node refuses
 *     it and the recording never runs.
 *
 *   - Nothing a peer says can create an entry. Federated pushes do not touch
 *     this; only our own users' outbound sends do.
 *
 *   - It only ever says YES to a pair where the recipient demonstrably wrote to
 *     the sender first. That is the same thing `recipientHasReplied` means — the
 *     recipient started it — established from a better source, sooner.
 *
 * So this widens nothing. It closes a window in which a fact that is already
 * true is not yet visible.
 *
 * Deliberately in memory and deliberately short-lived. It needs to outlast the
 * durable lag and nothing more; after that `chat_messages` answers the question
 * properly. Losing it on restart costs a few notifications during the lag
 * window, never correctness — the durable path delivers regardless.
 */

/** Long enough to cover the durable lag (45-63s) several times over, with room
 *  for a slow poller or a chain hiccup. Short enough that this stays a cache of
 *  the very recent past rather than a second, worse copy of `chat_messages`. */
export const TTL_MS = 15 * 60 * 1000;

/** Bounded. This is fed by a public endpoint, so it must not be a way to make an
 *  instance allocate without limit. At roughly 80 bytes an entry this is a few
 *  megabytes at worst, and eviction is oldest-first. */
const MAX_ENTRIES = 20_000;

const outbound = new Map<string, number>();

const keyOf = (from: string, to: string): string =>
	`${from.toLowerCase()}\u0000${to.toLowerCase()}`;

function prune(now: number): void {
	// Insertion order is chronological, so the expired entries are at the front
	// and the scan stops at the first live one.
	for (const [k, t] of outbound) {
		if (now - t > TTL_MS) outbound.delete(k);
		else break;
	}
}

/**
 * Record that `from` sent a chat message to `to` through this instance.
 *
 * Call this only once the chain has ACCEPTED the transaction — the node's
 * acceptance is what makes the sender's identity real rather than claimed.
 *
 * `now` is injectable so that EXPIRY can be tested. Without it the only way to
 * exercise the TTL is to wait fifteen real minutes — so nothing did, and this
 * entry is what decides whether a stranger's reply may notify somebody. An
 * expiry that silently stopped working would leave that permission standing for
 * the life of the process. Production never passes it.
 */
export function noteOutboundChat(from: string, to: string, now: number = Date.now()): void {
	if (from.length === 0 || to.length === 0 || from === to) return;
	prune(now);
	const key = keyOf(from, to);
	// Re-inserting moves the key to the end, keeping the map ordered by recency
	// so `prune` can keep stopping early.
	outbound.delete(key);
	outbound.set(key, now);
	while (outbound.size > MAX_ENTRIES) {
		const oldest = outbound.keys().next().value;
		if (oldest === undefined) break;
		outbound.delete(oldest);
	}
}

/** True when `from` sent a chat message to `to` through this instance recently
 *  enough that the durable table may not show it yet. */
export function hasRecentOutboundChat(
	from: string,
	to: string,
	now: number = Date.now()
): boolean {
	const t = outbound.get(keyOf(from, to));
	if (t === undefined) return false;
	if (now - t > TTL_MS) return false;
	return true;
}

/** Test seam. */
export function _resetOutboundChatForTest(): void {
	outbound.clear();
}

/** Entry count — for /v1/health and for tests asserting the bound holds. */
export function recentOutboundChatSize(): number {
	return outbound.size;
}
