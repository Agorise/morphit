/**
 * Whether an inbox card's order reads "(Paid)".
 *
 * The local trade with THAT card's peer reached a paid phase (the fast path,
 * before the indexer reports the order completed), or the order is completed.
 * The trade store keeps one entry per order, and an order the local user
 * posted can have several inquirers: read without the card's peer, one
 * inquirer's payment showed "(Paid)" on every inquirer's card. The chat
 * header reads it with the peer as well.
 */
import { tradeStateWith, type TradeState } from '$lib/trades/tradeStatusPure';

export function inboxOrderPaid(
	states: ReadonlyMap<string, TradeState>,
	peer: string,
	order: { readonly account: string; readonly permlink: string; readonly status: string }
): boolean {
	if (order.status === 'completed') return true;
	const phase = tradeStateWith(states, order.account, order.permlink, peer)?.phase;
	return phase === 'paid_verified' || phase === 'released' || phase === 'completed';
}
