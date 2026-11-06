import { describe, expect, it } from 'vitest';

import { coinAmountForFiat, fiatPerCoin } from './coinValue';

const FX = {
	base: 'USD',
	rates: { BRL: 5.477830612916686, USD: 1 },
	updated_at: '2026-11-06T16:53:33.440Z',
	stale: false,
	source: 'pricenodes'
} as never;

describe('coinValue (v1.23.2)', () => {
	it('what one coin is worth in the order currency', () => {
		expect(fiatPerCoin(75487.124, FX, 'BRL')).toBeCloseTo(413505.6, 0);
		expect(fiatPerCoin(null, FX, 'BRL')).toBeNull();
		expect(fiatPerCoin(75487.124, FX, 'XYZ')).toBeNull();
		expect(fiatPerCoin(75487.124, null, 'BRL')).toBeNull();
	});

	it("11 BRL in BTC, rounded to BTC's 8 decimals", () => {
		const per = fiatPerCoin(75487.124, FX, 'BRL')!;
		expect(coinAmountForFiat(11, per, 8)).toBe(0.0000266);
	});

	it('11 BRL in BLURT, to 3 decimals', () => {
		const per = fiatPerCoin(0.00072966, FX, 'BRL')!;
		expect(coinAmountForFiat(11, per, 3)).toBe(2752.096);
	});

	it('nothing for an unknown price or a non-positive amount', () => {
		expect(coinAmountForFiat(11, null, 8)).toBeNull();
		expect(coinAmountForFiat(0, 5, 8)).toBeNull();
		expect(coinAmountForFiat(11, 0, 8)).toBeNull();
		expect(coinAmountForFiat(1e-12, 1, 8)).toBeNull();
	});
});
