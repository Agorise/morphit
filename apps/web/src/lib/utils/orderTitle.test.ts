import { describe, expect, it } from 'vitest';
import { orderTitleParts } from './orderTitle';

/** The chat header reads someone else's order in the third person (v1.21.16):
 *  "Buying at least 25 BRL of BLURT …", not the poster's own "I'm buying …".
 *  Same values; only the key family changes. */
const base = {
	side: 'buy',
	asset: 'BLURT',
	fiat_currency: 'BRL',
	payment_methods: ['pay_xmr', 'pay_btc']
};
const shapes: ReadonlyArray<[string, { amount_min: number | null; amount_max: number | null }]> = [
	['min', { amount_min: 25, amount_max: null }],
	['max', { amount_min: null, amount_max: 25 }],
	['range', { amount_min: 25, amount_max: 50 }],
	['exact', { amount_min: 25, amount_max: 25 }],
	['any', { amount_min: null, amount_max: null }]
];

describe('orderTitleParts voice', () => {
	for (const side of ['buy', 'sell'] as const) {
		for (const [shape, amounts] of shapes) {
			it(`${side}_${shape}: poster by default, order_title_3p for 'third', same values`, () => {
				const o = { ...base, side, ...amounts };
				const poster = orderTitleParts(o);
				const explicit = orderTitleParts(o, undefined, undefined, { voice: 'poster' });
				const third = orderTitleParts(o, undefined, undefined, { voice: 'third' });
				expect(poster.key).toBe(`order_title.${side}_${shape}`);
				expect(explicit).toEqual(poster);
				expect(third.key).toBe(`order_title_3p.${side}_${shape}`);
				expect(third.values).toEqual(poster.values);
			});
		}
	}
	it('a valueless barter listing reads in the third person too', () => {
		const o = {
			side: 'sell',
			asset: 'BARTER',
			fiat_currency: 'USD',
			amount_min: null,
			amount_max: null,
			accepted_assets: ['XMR']
		};
		expect(orderTitleParts(o, undefined, 'goods', { voice: 'third' }).key).toBe(
			'order_title_3p.sell_barter_novalue'
		);
		expect(orderTitleParts(o, undefined, 'goods').key).toBe('order_title.sell_barter_novalue');
	});
});
