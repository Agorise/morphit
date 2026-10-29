import { describe, expect, it } from 'vitest';
import { isCryptoForCrypto, twoLegButtons, twoLegPlan, type ThreadFact } from './cryptoLegs';

/** An order buying BLURT, paying XMR or BTC. */
const BLURT_FOR_XMR_BTC = {
	side: 'buy',
	status: 'live',
	asset: 'BLURT',
	payment_methods: ['pay_xmr', 'pay_btc']
};
const ORDER = 'order-bob1';
const addr = (mine: boolean, method: 'xmr' | 'btc' | 'blurt'): ThreadFact => ({
	kind: 'address',
	mine,
	method,
	orderPermlink: ORDER
});
const paid = (mine: boolean, method: 'xmr' | 'btc' | 'blurt'): ThreadFact => ({
	kind: 'funds_sent',
	mine,
	method,
	orderPermlink: ORDER,
	txid: 'a'.repeat(64)
});

describe('twoLegPlan', () => {
	it('a BLURT buy paid in XMR or BTC: the seller (not the owner) sends BLURT and is paid first', () => {
		expect(twoLegPlan(BLURT_FOR_XMR_BTC, false)).toEqual({
			paymentCoins: ['xmr', 'btc'],
			paymentAddressCoins: ['xmr', 'btc'],
			asset: 'blurt',
			iSendAsset: true
		});
		expect(twoLegPlan(BLURT_FOR_XMR_BTC, true)?.iSendAsset).toBe(false);
	});
	it('buying XMR with BLURT: the XMR seller asks for BLURT (his account and the amount)', () => {
		const p = twoLegPlan({ side: 'buy', asset: 'XMR', payment_methods: ['pay_blurt'] }, false);
		expect(p?.paymentCoins).toEqual(['blurt']);
		expect(p?.paymentAddressCoins).toEqual(['blurt']);
	});
	it('not this flow: any non-crypto method, barter, no methods, a finished order, no order', () => {
		expect(
			twoLegPlan({ side: 'buy', asset: 'BLURT', payment_methods: ['pay_xmr', 'paypal'] }, false)
		).toBeNull();
		expect(
			twoLegPlan({ side: 'sell', asset: 'BARTER', payment_methods: ['pay_xmr'] }, false)
		).toBeNull();
		expect(twoLegPlan({ side: 'buy', asset: 'BLURT', payment_methods: [] }, false)).toBeNull();
		expect(twoLegPlan({ ...BLURT_FOR_XMR_BTC, status: 'completed' }, false)).toBeNull();
		expect(twoLegPlan(null, false)).toBeNull();
	});
	it('a method naming the asset itself is not a payment coin', () => {
		expect(
			twoLegPlan({ side: 'buy', asset: 'BLURT', payment_methods: ['pay_blurt'] }, false)
		).toBeNull();
	});
});

describe('twoLegButtons — the BLURT seller (pays BLURT, is paid XMR/BTC first)', () => {
	const plan = twoLegPlan(BLURT_FOR_XMR_BTC, false)!;
	it('first: share an XMR/BTC address; no "Send BLURT" yet', () => {
		expect(twoLegButtons(plan, [], ORDER, null)).toEqual({
			sharePaymentAddress: true,
			sendAsset: false,
			sendAssetUnchecked: false,
			confirmInWallet: false,
			payBlurt: false,
			shareAssetAddress: false,
			hint: 'waiting_payment'
		});
	});
	it('address shared, payment recorded, check running: still no "Send BLURT"', () => {
		const b = twoLegButtons(plan, [addr(true, 'xmr'), paid(false, 'xmr')], ORDER, 'checking');
		expect(b.sendAsset).toBe(false);
		expect(b.sharePaymentAddress).toBe(false);
		expect(b.hint).toBe('checking_payment');
	});
	it('the payment is seen (even at 0 confirmations): "Send BLURT"', () => {
		const b = twoLegButtons(plan, [addr(true, 'xmr'), paid(false, 'xmr')], ORDER, 'seen');
		expect(b.sendAsset).toBe(true);
		expect(b.sendAssetUnchecked).toBe(false);
		expect(b.hint).toBeNull();
	});
	it('not confirmed here: no "Send BLURT" until HE says he sees it in his wallet', () => {
		const b = twoLegButtons(plan, [paid(false, 'btc')], ORDER, 'unverifiable');
		expect(b.sendAsset).toBe(false);
		expect(b.confirmInWallet).toBe(true);
		expect(b.hint).toBe('check_wallet');
		const after = twoLegButtons(plan, [paid(false, 'btc')], ORDER, 'unverifiable', true);
		expect(after.sendAsset).toBe(true);
		expect(after.sendAssetUnchecked).toBe(true);
		expect(after.confirmInWallet).toBe(false);
		expect(after.hint).toBeNull();
	});
	it('his word does not stand in for a payment still checking, unshared, older than his address or reused', () => {
		for (const v of ['checking', 'no_address', 'old', 'reused'] as const) {
			const b = twoLegButtons(plan, [paid(false, 'xmr')], ORDER, v, true);
			expect(b.sendAsset).toBe(false);
			expect(twoLegButtons(plan, [paid(false, 'xmr')], ORDER, v).confirmInWallet).toBe(false);
		}
	});
	it('a payment not matching the ask (paid in parts, to an earlier address): his wallet may settle it', () => {
		const b = twoLegButtons(plan, [paid(false, 'xmr')], ORDER, 'mismatch');
		expect(b.sendAsset).toBe(false);
		expect(b.confirmInWallet).toBe(true);
		expect(b.hint).toBe('payment_short');
		expect(twoLegButtons(plan, [paid(false, 'xmr')], ORDER, 'mismatch', true).sendAsset).toBe(true);
	});
	it('older than his address: told so', () => {
		expect(twoLegButtons(plan, [paid(false, 'xmr')], ORDER, 'old').hint).toBe('payment_old');
	});
	it('paid in a coin with no address shared: told so, and he may share one', () => {
		const b = twoLegButtons(plan, [paid(false, 'xmr')], ORDER, 'no_address');
		expect(b.hint).toBe('payment_no_address');
		expect(b.sharePaymentAddress).toBe(true);
		expect(b.confirmInWallet).toBe(false);
	});
	it('arrived with no amount asked: "The amount is right" first, then "Send BLURT"', () => {
		const b = twoLegButtons(plan, [paid(false, 'xmr')], ORDER, 'unasked');
		expect(b.sendAsset).toBe(false);
		expect(b.confirmInWallet).toBe(true);
		expect(b.hint).toBe('check_amount');
		const after = twoLegButtons(plan, [paid(false, 'xmr')], ORDER, 'unasked', true);
		expect(after.sendAsset).toBe(true);
		expect(after.hint).toBeNull();
	});
	it('a txid already cited for another order: told so, nothing to send, no wallet button', () => {
		const b = twoLegButtons(plan, [paid(false, 'xmr')], ORDER, 'reused', true);
		expect(b.sendAsset).toBe(false);
		expect(b.confirmInWallet).toBe(false);
		expect(b.hint).toBe('payment_reused');
	});
	it('once the asset is sent, no wallet button either', () => {
		const b = twoLegButtons(plan, [paid(false, 'xmr'), paid(true, 'blurt')], ORDER, 'unverifiable');
		expect(b.confirmInWallet).toBe(false);
		expect(b.sendAssetUnchecked).toBe(false);
	});
	it('short or to another address: no "Send BLURT", and he is told', () => {
		const b = twoLegButtons(plan, [paid(false, 'xmr')], ORDER, 'mismatch');
		expect(b.sendAsset).toBe(false);
		expect(b.hint).toBe('payment_short');
	});
	it('his own receipt does not count as the buyer’s payment', () => {
		expect(twoLegButtons(plan, [paid(true, 'xmr')], ORDER, 'seen').sendAsset).toBe(false);
	});
	it('a payment about another order does not count', () => {
		const other: ThreadFact = { ...paid(false, 'xmr'), orderPermlink: 'order-other' } as ThreadFact;
		expect(twoLegButtons(plan, [other], ORDER, 'seen').sendAsset).toBe(false);
	});
	it('once he has sent the BLURT, the row is done', () => {
		const b = twoLegButtons(plan, [paid(false, 'xmr'), paid(true, 'blurt')], ORDER, 'seen');
		expect(b.sendAsset).toBe(false);
		expect(b.hint).toBeNull();
	});
});

describe('twoLegButtons — the BLURT buyer (pays XMR/BTC first, receives BLURT)', () => {
	const plan = twoLegPlan(BLURT_FOR_XMR_BTC, true)!;
	it('never "Share your Blurt account"; waits for the seller’s address', () => {
		expect(twoLegButtons(plan, [], ORDER, null)).toEqual({
			sharePaymentAddress: false,
			sendAsset: false,
			sendAssetUnchecked: false,
			confirmInWallet: false,
			payBlurt: false,
			shareAssetAddress: false,
			hint: 'waiting_address'
		});
	});
	it('once the address is in the chat, the hint goes (he pays from the address card)', () => {
		expect(twoLegButtons(plan, [addr(false, 'btc')], ORDER, null).hint).toBeNull();
	});
});

describe('twoLegButtons — buying XMR with BLURT', () => {
	const order = { side: 'buy', asset: 'XMR', payment_methods: ['pay_blurt'] };
	it('the XMR seller first asks for BLURT; nothing to send yet', () => {
		const b = twoLegButtons(twoLegPlan(order, false)!, [], ORDER, null);
		expect(b.sharePaymentAddress).toBe(true);
		expect(b.sendAsset).toBe(false);
		expect(b.hint).toBe('waiting_payment');
	});
	it('the XMR buyer waits for that ask, then pays it; he shares his XMR address any time', () => {
		const plan = twoLegPlan(order, true)!;
		const before = twoLegButtons(plan, [], ORDER, null);
		expect(before.payBlurt).toBe(false);
		expect(before.hint).toBe('waiting_address');
		expect(before.shareAssetAddress).toBe(true);
		const asked = twoLegButtons(plan, [addr(false, 'blurt')], ORDER, null);
		expect(asked.payBlurt).toBe(true);
		expect(asked.hint).toBeNull();
		// His own BLURT "address" is no ask.
		expect(twoLegButtons(plan, [addr(true, 'blurt')], ORDER, null).payBlurt).toBe(false);
	});
	it('after paying, no second BLURT button', () => {
		expect(
			twoLegButtons(
				twoLegPlan(order, true)!,
				[addr(false, 'blurt'), paid(true, 'blurt')],
				ORDER,
				null
			).payBlurt
		).toBe(false);
	});
	it('the XMR seller sends XMR once the BLURT is seen (verified against his ask) and the buyer said where', () => {
		const plan = twoLegPlan(order, false)!;
		const where = addr(false, 'xmr');
		expect(twoLegButtons(plan, [where, paid(false, 'blurt')], ORDER, null).sendAsset).toBe(false);
		expect(twoLegButtons(plan, [where, paid(false, 'blurt')], ORDER, 'seen').sendAsset).toBe(true);
		expect(twoLegButtons(plan, [where, paid(false, 'blurt')], ORDER, 'unasked').sendAsset).toBe(
			false
		);
	});
	it('paid, but no XMR address from the buyer yet: no "Send XMR", and he is told what he waits for', () => {
		const plan = twoLegPlan(order, false)!;
		const b = twoLegButtons(plan, [paid(false, 'blurt')], ORDER, 'seen');
		expect(b.sendAsset).toBe(false);
		expect(b.hint).toBe('waiting_asset_address');
		// His own XMR address is not where to send.
		expect(
			twoLegButtons(plan, [addr(true, 'xmr'), paid(false, 'blurt')], ORDER, 'seen').sendAsset
		).toBe(false);
		// Vouched from his wallet: the same.
		const v = twoLegButtons(plan, [paid(false, 'blurt')], ORDER, 'unasked', true);
		expect(v.sendAsset).toBe(false);
		expect(v.sendAssetUnchecked).toBe(false);
		expect(v.hint).toBe('waiting_asset_address');
	});
});

describe('isCryptoForCrypto (whatever the status)', () => {
	it('only other coins, a coin asset', () => {
		const finished = { ...BLURT_FOR_XMR_BTC, status: 'completed' };
		expect(isCryptoForCrypto(finished)).toBe(true);
		expect(isCryptoForCrypto({ asset: 'BLURT', payment_methods: ['pay_xmr', 'paypal'] })).toBe(
			false
		);
		expect(isCryptoForCrypto({ asset: 'BLURT', payment_methods: ['pay_blurt'] })).toBe(false);
		expect(isCryptoForCrypto({ asset: 'BARTER', payment_methods: ['pay_xmr'] })).toBe(false);
		expect(isCryptoForCrypto({ asset: 'BLURT', payment_methods: [] })).toBe(false);
		expect(isCryptoForCrypto(null)).toBe(false);
	});
});
