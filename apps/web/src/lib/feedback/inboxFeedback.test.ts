/**
 * The inbox offers "Leave feedback" on a card only for the trade with THAT
 * card's peer (v1.21.14 review, W-H1 family): another inquirer's paid trade
 * on our order offered it on every other inquirer's card.
 *
 * The real trade-store rules (tradeStatusPure); nothing faked.
 */
import { describe, expect, it } from 'vitest';
import { inboxTradeSettled } from './inboxFeedback';
import {
	recordAddressSharedPure,
	recordFundsSentPure,
	type TradeState
} from '$lib/trades/tradeStatusPure';

const ME = 'seller-me';
const ORDER = { account: ME, permlink: 'sell-blurt-1' };

/** We shared our address with bob, and bob says he paid. */
function bobPaid(): ReadonlyMap<string, TradeState> {
	let s: ReadonlyMap<string, TradeState> = new Map();
	s = recordAddressSharedPure(s, {
		orderOwner: ME,
		orderPermlink: ORDER.permlink,
		peer: 'bob',
		method: 'blurt',
		address: ME,
		expectedAmount: 10,
		expectedMemo: 'm',
		direction: 'outgoing'
	});
	return recordFundsSentPure(s, {
		orderOwner: ME,
		orderPermlink: ORDER.permlink,
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		claimedMemo: 'm',
		amount: 10,
		direction: 'incoming'
	});
}

describe('the inbox "Leave feedback" condition', () => {
	it("bob's card: his trade moved past address-sharing", () => {
		expect(inboxTradeSettled(bobPaid(), { peer: 'bob', order: ORDER })).toBe(true);
	});

	it("carol, another inquirer on the same order: not settled by bob's payment", () => {
		expect(inboxTradeSettled(bobPaid(), { peer: 'carol', order: ORDER })).toBe(false);
	});

	it('the same permlink on ANOTHER owner’s order: not ours to read', () => {
		expect(
			inboxTradeSettled(bobPaid(), { peer: 'bob', order: { ...ORDER, account: 'someone' } })
		).toBe(false);
	});

	it('a card with no order: never', () => {
		expect(inboxTradeSettled(bobPaid(), { peer: 'bob', order: null })).toBe(false);
	});
});
