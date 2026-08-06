import { describe, it, expect } from 'vitest';
import { buildRelistPrefill, RELIST_PREFILL_KEY } from './relist';
import type { OrderRecord } from '@morphit/indexer-client';

const mkOrder = (over: Partial<OrderRecord>): OrderRecord =>
	({
		account: 'kentest3',
		permlink: 'order-abc',
		side: 'buy',
		asset: 'BLURT',
		asset_network: null,
		fiat_currency: 'MXN',
		amount_min: 500,
		amount_max: null,
		price_model: {},
		location_region: null,
		payment_methods: [],
		accepted_assets: null,
		terms: null,
		...over
	}) as unknown as OrderRecord;

describe('buildRelistPrefill', () => {
	it('always produces a fresh-listing prefill (30-day expiry, reason relist)', () => {
		const p = buildRelistPrefill(mkOrder({}));
		expect(p.expiresDays).toBe(30);
		expect(p.reason).toBe('relist');
	});

	it('carries the core fields forward', () => {
		const p = buildRelistPrefill(
			mkOrder({
				side: 'sell',
				asset: 'XMR',
				fiat_currency: 'EUR',
				amount_min: 100,
				amount_max: 900,
				location_region: 'Berlin',
				terms: 'cash only'
			})
		);
		expect(p.side).toBe('sell');
		expect(p.asset).toBe('XMR');
		expect(p.fiat).toBe('EUR');
		expect(p.amountMin).toBe('100');
		expect(p.amountMax).toBe('900');
		expect(p.region).toBe('Berlin');
		expect(p.terms).toBe('cash only');
	});

	it('maps a spread price_model to the split form state', () => {
		const p = buildRelistPrefill(mkOrder({ price_model: { kind: 'spread', percent: 2.5 } }));
		expect(p.priceModelKind).toBe('spread');
		expect(p.spreadPercent).toBe('2.5');
		expect(p.fixedPrice).toBe('');
	});

	it('maps a fixed price_model to the split form state', () => {
		const p = buildRelistPrefill(mkOrder({ price_model: { kind: 'fixed', price: 0.0013 } }));
		expect(p.priceModelKind).toBe('fixed');
		expect(p.fixedPrice).toBe('0.0013');
		expect(p.spreadPercent).toBe('0');
	});

	it('falls back to spread 0 on an unknown price_model shape', () => {
		const p = buildRelistPrefill(mkOrder({ price_model: { weird: true } as never }));
		expect(p.priceModelKind).toBe('spread');
		expect(p.spreadPercent).toBe('0');
		expect(p.fixedPrice).toBe('');
	});

	it('carries a multi-network asset_network forward (empty picker bug guard)', () => {
		const p = buildRelistPrefill(mkOrder({ asset: 'USDT', asset_network: 'trc20' }));
		expect(p.assetNetwork).toBe('trc20');
	});

	it('normalises null amounts + nullable fields to empty strings', () => {
		const p = buildRelistPrefill(
			mkOrder({ amount_min: null, amount_max: null, location_region: null, terms: null })
		);
		expect(p.amountMin).toBe('');
		expect(p.amountMax).toBe('');
		expect(p.region).toBe('');
		expect(p.terms).toBe('');
	});

	it('copies payment_methods into a NEW array (no shared mutable ref)', () => {
		const src = ['cash_in_person', 'bank_transfer'];
		const p = buildRelistPrefill(mkOrder({ payment_methods: src }));
		expect(p.paymentMethods).toEqual(src);
		expect(p.paymentMethods).not.toBe(src);
	});

	it('exposes the /post prefill key', () => {
		expect(RELIST_PREFILL_KEY).toBe('morphit.post.prefill');
	});
});
