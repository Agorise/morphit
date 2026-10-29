import { describe, expect, it } from 'vitest';
import type { OrderRecord } from '@morphit/indexer-client';

import { inboxOrderRef } from './inboxOrderRef';

const rec = (over: Partial<OrderRecord> = {}): OrderRecord =>
	({
		account: 'bob',
		permlink: 'order-b1',
		side: 'buy',
		asset: 'BLURT',
		fiat_currency: 'BRL',
		amount_min: 25,
		amount_max: null,
		payment_methods: ['pay_xmr', 'pay_btc'],
		status: 'live',
		...over
	}) as OrderRecord;

describe('an inbox card’s order, from the order itself', () => {
	it('carries what the order settles in, so the subject is the full sentence', () => {
		expect(inboxOrderRef(rec())).toEqual({
			permlink: 'order-b1',
			account: 'bob',
			side: 'buy',
			asset: 'BLURT',
			fiat_currency: 'BRL',
			amount_min: 25,
			amount_max: null,
			status: 'live',
			payment_methods: ['pay_xmr', 'pay_btc'],
			accepted_assets: null,
			specific_barter_title: null
		});
	});
	it('a barter order: its accepted coins and its own title', () => {
		const r = inboxOrderRef(
			rec({
				asset: 'BARTER',
				payment_methods: ['pay_xmr'],
				accepted_assets: ['XMR'],
				specific_barter_title: 'Hand-made chair'
			})
		);
		expect(r.accepted_assets).toEqual(['XMR']);
		expect(r.specific_barter_title).toBe('Hand-made chair');
	});
	it('no status: no label', () => {
		expect(inboxOrderRef(rec({ status: undefined })).status).toBe('');
	});
});
