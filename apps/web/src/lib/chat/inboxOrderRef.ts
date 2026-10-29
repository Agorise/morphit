import type { ConversationOrderRef, OrderRecord } from '@morphit/indexer-client';

/**
 * An inbox card's order, from the order itself — for a card the fast push
 * brought (it names only the permlink) until its durable row arrives.
 *
 * v1.21.17: the inbox subject is the full sentence ("Who is buying at least
 * 25 BRL of BLURT with XMR or BTC"), which needs what the order settles in:
 * its payment methods and, for a barter order, the accepted coins and its own
 * title. Left out, the card read "…with" until the durable row came.
 */
export function inboxOrderRef(rec: OrderRecord): ConversationOrderRef {
	return {
		permlink: rec.permlink,
		account: rec.account,
		side: rec.side,
		asset: rec.asset,
		fiat_currency: rec.fiat_currency,
		amount_min: rec.amount_min,
		amount_max: rec.amount_max,
		// Absent status → no label, rather than inventing "(Live)" for an order
		// that might be cancelled. The durable row settles it shortly.
		status: rec.status ?? '',
		payment_methods: rec.payment_methods,
		accepted_assets: rec.accepted_assets ?? null,
		specific_barter_title: rec.specific_barter_title ?? null
	};
}
