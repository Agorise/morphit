/**
 * the chat's crypto money-flow buttons must disappear once
 * the order is finished.
 *
 * THE BUG THIS GUARDS AGAINST. on live morphit.io: a fulfilled BLURT trade
 * where both parties already held a Payment Receipt was STILL showing the "Pay
 * now" / "Share crypto address" row across the bottom of the chatroom. That is
 * not just clutter — it invites a second payment on a closed trade.
 *
 * `chatMoneyFlow` tested `if (!order)` and nothing else, so "no longer live"
 * only held for a chat with no order at all. But the chat resolves its order
 * via `getOrdersByAccount`, which returns the account's orders in ANY state —
 * that's how the RE: line can read "(Cancelled)". A completed order therefore
 * arrived as a perfectly good `{ side }` and lit the row. the comment had
 * claimed these were hidden for a dead order since an earlier release; the code never did it.
 *
 * The gate is a denylist, deliberately: `status` is OPTIONAL on OrderRecord, so
 * a federated peer on an older indexer omits it, and an `=== 'live'` allowlist
 * would silently strip the buttons from every chat against those instances.
 */

import { describe, expect, it } from 'vitest';
import {
	chatMoneyFlow,
	chatMoneyFlowLabels,
	chatOrderHeading,
	cryptoSideOfOrder,
	orderCanShip,
	peerCryptoSide,
	inboxOrderVoice
} from './orderRole';

describe('peerCryptoSide', () => {
	it("uses the owner's side as-is for the peer's order", () => {
		expect(peerCryptoSide('sell', false)).toBe('sell');
		expect(peerCryptoSide('buy', false)).toBe('buy');
	});

	it('flips the side when the order is mine', () => {
		expect(peerCryptoSide('sell', true)).toBe('buy');
		expect(peerCryptoSide('buy', true)).toBe('sell');
	});
});

describe('chatMoneyFlow', () => {
	it('shows exactly one button for a live order', () => {
		// Peer BUYS ⇒ I send the crypto ⇒ Pay now.
		expect(chatMoneyFlow({ side: 'buy', status: 'live' }, false)).toEqual({
			payNow: true,
			shareAddress: false
		});
		// Peer SELLS ⇒ I receive the crypto ⇒ Share address.
		expect(chatMoneyFlow({ side: 'sell', status: 'live' }, false)).toEqual({
			payNow: false,
			shareAddress: true
		});
	});

	it('shows nothing when there is no order at all', () => {
		// An unsolicited chat opened from a profile's Message button.
		expect(chatMoneyFlow(null, false)).toEqual({ payNow: false, shareAddress: false });
	});

	// ─── ─────────────────────────────────────────
	it('shows nothing for a COMPLETED order — the trade is paid and closed', () => {
		// The maintainer's exact case: the fulfilled BLURT trade, both parties holding a
		// Payment Receipt, still offering "Pay now".
		expect(chatMoneyFlow({ side: 'buy', status: 'completed' }, false)).toEqual({
			payNow: false,
			shareAddress: false
		});
		expect(chatMoneyFlow({ side: 'sell', status: 'completed' }, false)).toEqual({
			payNow: false,
			shareAddress: false
		});
	});

	it('shows nothing for a CANCELLED or EXPIRED order', () => {
		// Same class, and visible all over the maintainer's Archived tab, which is full of
		// "(Cancelled)" threads.
		expect(chatMoneyFlow({ side: 'buy', status: 'cancelled' }, false)).toEqual({
			payNow: false,
			shareAddress: false
		});
		expect(chatMoneyFlow({ side: 'sell', status: 'expired' }, false)).toEqual({
			payNow: false,
			shareAddress: false
		});
	});

	it('still shows buttons when status is ABSENT (older federated indexer)', () => {
		// `status` is optional on OrderRecord. An allowlist (`=== 'live'`) would
		// silently strip the money-flow controls from every chat against a peer
		// running an older indexer — a worse bug than the one being fixed.
		expect(chatMoneyFlow({ side: 'buy' }, false)).toEqual({
			payNow: true,
			shareAddress: false
		});
	});

	it('still shows buttons for a status this build does not know', () => {
		// Forward-compat: a newer peer inventing a state we've never heard of must
		// not blank the UI. Only states we positively know are finished hide it.
		expect(chatMoneyFlow({ side: 'sell', status: 'some_future_state' }, false)).toEqual({
			payNow: false,
			shareAddress: true
		});
	});

	it('applies the dead-order gate regardless of whose order it is', () => {
		expect(chatMoneyFlow({ side: 'buy', status: 'completed' }, true)).toEqual({
			payNow: false,
			shareAddress: false
		});
	});
});

/**
 * BARTER orders store the GOODS direction in `side`, the inverse of the crypto
 * direction. A banana seller (side 'sell', asset 'BARTER') is ACQUIRING crypto,
 * so the goods buyer must get "Pay now" and the goods seller "Share crypto
 * address", and the goods seller (who receives crypto) ships the goods.
 */
describe('barter orders', () => {
	it('flips the crypto side for BARTER only', () => {
		expect(cryptoSideOfOrder({ side: 'sell', asset: 'BARTER' })).toBe('buy');
		expect(cryptoSideOfOrder({ side: 'buy', asset: 'BARTER' })).toBe('sell');
		expect(cryptoSideOfOrder({ side: 'sell', asset: 'XMR' })).toBe('sell');
		expect(cryptoSideOfOrder({ side: 'buy', asset: 'BTC' })).toBe('buy');
		expect(cryptoSideOfOrder({ side: 'sell' })).toBe('sell');
	});

	it("goods buyer on a peer's SELL barter listing pays; the goods seller shares an address", () => {
		// I am the goods buyer, chatting about the peer's banana listing.
		expect(chatMoneyFlow({ side: 'sell', status: 'live', asset: 'BARTER' }, false)).toEqual({
			payNow: true,
			shareAddress: false
		});
		// I am the goods seller, the listing is mine.
		expect(chatMoneyFlow({ side: 'sell', status: 'live', asset: 'BARTER' }, true)).toEqual({
			payNow: false,
			shareAddress: true
		});
	});

	it('on a BUY barter listing the poster pays and the goods seller shares an address', () => {
		expect(chatMoneyFlow({ side: 'buy', status: 'live', asset: 'BARTER' }, true)).toEqual({
			payNow: true,
			shareAddress: false
		});
		expect(chatMoneyFlow({ side: 'buy', status: 'live', asset: 'BARTER' }, false)).toEqual({
			payNow: false,
			shareAddress: true
		});
	});

	it('still hides everything on a finished barter order', () => {
		expect(chatMoneyFlow({ side: 'sell', status: 'completed', asset: 'BARTER' }, false)).toEqual({
			payNow: false,
			shareAddress: false
		});
	});
});

describe('orderCanShip', () => {
	it('is true for a BARTER order even though its methods are only pay_<coin> rails', () => {
		expect(orderCanShip({ asset: 'BARTER', payment_methods: ['pay_xmr', 'pay_blurt'] })).toBe(true);
	});
	it('follows the payment methods for crypto orders', () => {
		expect(orderCanShip({ asset: 'XMR', payment_methods: ['cash_by_mail'] })).toBe(true);
		expect(orderCanShip({ asset: 'BTC', payment_methods: ['barter_goods'] })).toBe(true);
		expect(orderCanShip({ asset: 'XMR', payment_methods: ['precious_metals'] })).toBe(true);
		expect(orderCanShip({ asset: 'XMR', payment_methods: ['cash_in_person', 'paypal'] })).toBe(
			false
		);
		expect(orderCanShip({ asset: 'BTC', payment_methods: ['pay_btc'] })).toBe(false);
	});
	it('is false with no order', () => {
		expect(orderCanShip(null)).toBe(false);
	});
});

describe('chatMoneyFlowLabels (v1.21.16): the buttons name the coin', () => {
	it('BLURT: “Send BLURT”, and the receiver shares a Blurt ACCOUNT, not an address', () => {
		expect(chatMoneyFlowLabels({ asset: 'BLURT' })).toEqual({
			payNow: { key: 'chat.funds_sent.button_asset', values: { asset: 'BLURT' } },
			payNowAria: { key: 'chat.funds_sent.button_aria_asset', values: { asset: 'BLURT' } },
			shareAddress: { key: 'chat.address.share_button_blurt' },
			shareAddressAria: { key: 'chat.address.share_button_aria_blurt' }
		});
	});
	it('another coin: “Send XMR” / “Share your XMR address”', () => {
		expect(chatMoneyFlowLabels({ asset: 'XMR' })).toEqual({
			payNow: { key: 'chat.funds_sent.button_asset', values: { asset: 'XMR' } },
			payNowAria: { key: 'chat.funds_sent.button_aria_asset', values: { asset: 'XMR' } },
			shareAddress: { key: 'chat.address.share_button_asset', values: { asset: 'XMR' } },
			shareAddressAria: { key: 'chat.address.share_button_aria_asset', values: { asset: 'XMR' } }
		});
	});
	it('the ticker is shown upper-case whatever case it arrives in', () => {
		expect(chatMoneyFlowLabels({ asset: 'btc' }).payNow.values).toEqual({ asset: 'BTC' });
		expect(chatMoneyFlowLabels({ asset: 'blurt' }).shareAddress.key).toBe(
			'chat.address.share_button_blurt'
		);
	});
	it('a barter order that accepts ONE coin names it', () => {
		expect(chatMoneyFlowLabels({ asset: 'BARTER', accepted_assets: ['XMR'] }).payNow).toEqual({
			key: 'chat.funds_sent.button_asset',
			values: { asset: 'XMR' }
		});
		expect(
			chatMoneyFlowLabels({ asset: 'BARTER', accepted_assets: ['BLURT'] }).shareAddress
		).toEqual({ key: 'chat.address.share_button_blurt' });
	});
	it('a barter order (several coins), no asset or no order: the generic labels', () => {
		const generic = {
			payNow: { key: 'chat.funds_sent.button' },
			payNowAria: { key: 'chat.funds_sent.button_aria' },
			shareAddress: { key: 'chat.address.share_button' },
			shareAddressAria: { key: 'chat.address.share_button_aria' }
		};
		expect(chatMoneyFlowLabels({ asset: 'BARTER' })).toEqual(generic);
		expect(chatMoneyFlowLabels({ asset: 'BARTER', accepted_assets: ['XMR', 'BLURT'] })).toEqual(
			generic
		);
		expect(chatMoneyFlowLabels({ asset: 'BARTER', accepted_assets: [] })).toEqual(generic);
		expect(chatMoneyFlowLabels({ asset: 'BARTER', accepted_assets: null })).toEqual(generic);
		expect(chatMoneyFlowLabels({ asset: '' })).toEqual(generic);
		expect(chatMoneyFlowLabels({})).toEqual(generic);
		expect(chatMoneyFlowLabels(null)).toEqual(generic);
	});
});

describe('chatOrderHeading (v1.21.16): “Regarding …” from the reader’s side', () => {
	it('my own order: “Regarding my order”, the title in the first person', () => {
		expect(chatOrderHeading(true, 'alice')).toEqual({
			label: { key: 'chat.header.re_mine' },
			voice: 'poster'
		});
	});
	it('the peer’s order: “Regarding @bob’s order”, the title in the third person', () => {
		expect(chatOrderHeading(false, 'bob')).toEqual({
			label: { key: 'chat.header.re_peer', values: { owner: 'bob' } },
			voice: 'third'
		});
	});
});

describe('inboxOrderVoice', () => {
	it('my own order reads "Regarding my …", the other person\u2019s "Who is …"', () => {
		expect(inboxOrderVoice(true)).toBe('mine');
		expect(inboxOrderVoice(false)).toBe('who');
	});
});
