/**
 * The inbox card's "(Paid)" speaks for the trade with that card's peer only:
 * one inquirer's verified payment on our order must not mark every other
 * inquirer's card paid.
 *
 * The real trade-store rules (tradeStatusPure); nothing faked.
 */
import { describe, expect, it } from 'vitest';
import { inboxOrderPaid } from './inboxPaid';
import {
	recordAddressSharedPure,
	recordFundsSentPure,
	recordVerificationPure,
	type TradeState
} from '$lib/trades/tradeStatusPure';

const ME = 'seller-me';
const ORDER = { account: ME, permlink: 'sell-blurt-1', status: 'live' };

/** We shared our address with bob, bob paid, and the chain confirmed it. */
function bobPaidVerified(): ReadonlyMap<string, TradeState> {
	let s: ReadonlyMap<string, TradeState> = new Map();
	s = recordAddressSharedPure(s, {
		orderOwner: ME,
		orderPermlink: ORDER.permlink,
		peer: 'bob',
		method: 'blurt',
		address: ME,
		expectedAmount: 10,
		direction: 'outgoing'
	});
	s = recordFundsSentPure(s, {
		orderOwner: ME,
		orderPermlink: ORDER.permlink,
		peer: 'bob',
		method: 'blurt',
		txid: 'a'.repeat(40),
		amount: 10,
		direction: 'incoming'
	});
	return recordVerificationPure(s, {
		orderOwner: ME,
		orderPermlink: ORDER.permlink,
		verifyResult: { kind: 'verified' },
		counterparty: 'bob',
		amountConfirmed: true
	});
}

describe('inbox "(Paid)"', () => {
	it('bob’s card reads Paid; carol’s card on the same order does not', () => {
		const s = bobPaidVerified();
		expect(inboxOrderPaid(s, 'bob', ORDER)).toBe(true);
		expect(inboxOrderPaid(s, 'carol', ORDER)).toBe(false);
	});

	it('another owner’s order with the same permlink is not paid by it', () => {
		const s = bobPaidVerified();
		expect(inboxOrderPaid(s, 'bob', { ...ORDER, account: 'bob' })).toBe(false);
	});

	it('a payment claimed but not yet verified is not Paid', () => {
		const s = recordFundsSentPure(new Map(), {
			orderOwner: ME,
			orderPermlink: ORDER.permlink,
			peer: 'bob',
			method: 'btc',
			txid: 'b'.repeat(64),
			direction: 'incoming'
		});
		expect(inboxOrderPaid(s, 'bob', ORDER)).toBe(false);
	});

	it('a completed order reads Paid on every card', () => {
		expect(inboxOrderPaid(new Map(), 'carol', { ...ORDER, status: 'completed' })).toBe(true);
	});
});
