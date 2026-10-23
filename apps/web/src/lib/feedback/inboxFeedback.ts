/**
 * Whether an inbox card's trade has moved past "address shared" — the
 * condition for offering "Leave feedback" on it.
 *
 * The trade store keeps ONE entry per order (its owner and permlink), and an
 * order the local user posted can have several inquirers: the entry speaks
 * for the counterparty the order is ENGAGED with only. Read without the
 * card's peer, another inquirer's paid trade on our order offered "Leave
 * feedback" on every other inquirer's card too (v1.21.14 review, the W-H1
 * family; ConversationView already reads it with the peer).
 */
import { tradeStateWith, type TradeState } from '$lib/trades/tradeStatusPure';

export function inboxTradeSettled(
	states: ReadonlyMap<string, TradeState>,
	convo: {
		readonly peer: string;
		readonly order?: { readonly account: string; readonly permlink: string } | null;
	}
): boolean {
	const order = convo.order;
	if (!order) return false;
	const st = tradeStateWith(states, order.account, order.permlink, convo.peer);
	return (st?.phase ?? 'address_shared') !== 'address_shared';
}
