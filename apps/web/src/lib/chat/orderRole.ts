/**
 * Money-flow helper for the chat's order context.
 *
 * A chat can be about an order posted by EITHER party: usually the peer (we
 * opened the chat from their order in the book), but also us (the peer opened
 * the chat about OUR order). An order's `side` is ALWAYS from the poster's
 * perspective — a "buy" order means the poster wants to buy the asset, a "sell"
 * order means they want to sell it.
 *
 * The chat's button gating (ConversationView) is expressed in terms of the
 * PEER's side: peer buys the asset ⇒ I send the crypto ⇒ show "Pay now"; peer
 * sells ⇒ I receive it ⇒ show "Share address". So we must translate the raw
 * order side into the peer's side, which depends on who owns the order:
 *   • order owned by the peer  → owner side IS the peer side (as-is)
 *   • order owned by me        → the peer is the opposite of my side
 *
 * This is money-flow critical (it decides which of "Pay now" / "Share address"
 * shows and which asset the Pay-now modal locks to), so it lives here as a pure
 * function with a smoke (posting-key… no — order-role-smoke) rather than inline
 * in the Svelte derived. Normalization matches orderTitle.ts: anything that
 * isn't exactly 'sell' is treated as 'buy'.
 */
export type CryptoSide = 'buy' | 'sell';

export function peerCryptoSide(rawOrderSide: string, orderIsMine: boolean): CryptoSide {
	const ownerSide: CryptoSide = rawOrderSide === 'sell' ? 'sell' : 'buy';
	// Peer's order → the owner's side is already the peer's side.
	// My order → the peer takes the opposite side of the trade.
	if (!orderIsMine) return ownerSide;
	return ownerSide === 'sell' ? 'buy' : 'sell';
}

/** cp406 (Ken) — which of the two crypto money-flow buttons a chat should
 *  show. Takes the RESOLVED order record (or null for a chat with no live
 *  order — an unsolicited chat opened from a profile's Message button, or a
 *  chat whose order is no longer live) and whether that order is ours.
 *
 *  Hard rule: with no live order there is nothing to pay for, so BOTH buttons
 *  are hidden. With a live order, exactly one shows, per peerCryptoSide():
 *  peer BUYS ⇒ I send crypto ⇒ Pay now; peer SELLS ⇒ I receive crypto ⇒ Share
 *  address. The physical mailing/shipment controls layer on top of these
 *  (see ConversationView.orderCanShip).
 *
 *  cp474 (t.txt #6) — "no longer live" now actually means it.
 *
 *  This function used to test `if (!order)` and nothing else, so "no longer
 *  live" only held for a chat with no order AT ALL. But the chat resolves its
 *  order from `getOrdersByAccount`, which returns the account's orders
 *  whatever their state — that is how the RE: line can show "(Cancelled)". So
 *  a COMPLETED order still arrived here as a perfectly good `{side}` and lit
 *  the button row. Ken hit it on a fulfilled BLURT trade where both parties
 *  already held a Payment Receipt: the chat was still offering "Pay now" for a
 *  trade that was paid and closed — an invitation to pay twice.
 *
 *  The gate is a DENYLIST of dead states, not an allowlist of `=== 'live'`,
 *  because `status` is OPTIONAL on OrderRecord: a federated peer running an
 *  older indexer omits it, and an allowlist would silently strip the buttons
 *  from every chat against those instances. An unknown/absent status keeps
 *  today's behaviour; only a state we positively know is finished hides them. */
const DEAD_ORDER_STATES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'expired']);

export function chatMoneyFlow(
	order: { side: string; status?: string } | null,
	orderIsMine: boolean
): { payNow: boolean; shareAddress: boolean } {
	if (!order) return { payNow: false, shareAddress: false };
	if (order.status !== undefined && DEAD_ORDER_STATES.has(order.status)) {
		return { payNow: false, shareAddress: false };
	}
	const side = peerCryptoSide(order.side, orderIsMine);
	return { payNow: side === 'buy', shareAddress: side === 'sell' };
}
