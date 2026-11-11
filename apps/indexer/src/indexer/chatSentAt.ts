/**
 * Morphit indexer — the sender's signed time of a chat message.
 *
 * Moved out of chatFastFederation.ts in v1.24.1 so the durable chat handler
 * can stamp `chat_messages.sent_at` by the very rule the fast path dates its
 * copy with, without importing the federation module.
 */

/**
 * The interval the Morphit client puts between the chain head it read and the
 * expiry it signs (apps/web/src/lib/blurt/sign.ts). Subtracting it recovers,
 * near enough, the head-block time the sender was looking at — which is within
 * one block of the timestamp the head tailer would stamp on the same message.
 *
 * WHY THIS IS SAFE ACROSS INSTANCES, which is worth stating because it looks
 * like it should not be. `sentAt` orders the transcript, so a value derived
 * from the SENDER's clock would let two instances with skewed clocks render
 * consecutive messages in the wrong order. It is not derived from a clock: the
 * client builds the expiry from the CHAIN's head block time
 * (`getRefBlockInfo`), and every instance in the federation reads the same
 * chain. Clock skew between operators therefore cannot reorder anything.
 *
 * WHAT IS NOT SAFE is this number drifting from the client's. The two are
 * written in separate packages with nothing linking them, and a change to one
 * alone would shift every fast-path message's `sentAt` by the difference —
 * silently, and only against messages that arrived by the OTHER route, which
 * is the hardest kind of ordering bug to see. `chat-expiry-lead-parity-smoke`
 * exists for exactly that, and asserts the round trip rather than the token.
 */
export const CLIENT_EXPIRY_LEAD_MS = 60_000;

/** Recover the sender's clock from the signed expiry. Falls back to ours when
 *  the field is unusable, and never returns a time in the future: a message
 *  cannot have been sent later than it arrived, and letting one claim otherwise
 *  would park it at the bottom of every transcript it landed in. */
export function sentAtFromExpiry(expiration: unknown, now: Date): Date {
	if (typeof expiration !== 'string') return now;
	const exp = Date.parse(expiration.endsWith('Z') ? expiration : `${expiration}Z`);
	if (!Number.isFinite(exp)) return now;
	const sent = exp - CLIENT_EXPIRY_LEAD_MS;
	return sent > now.getTime() ? now : new Date(sent);
}
