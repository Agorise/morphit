/**
 * /v1/listing-fee carries the other coins' USD prices (v1.23.2, display
 * only) as `asset_prices_usd`: { ETH: 3005, LTC: 89.5, … }, so the browser
 * can show "(≈11 BRL)" beside an amount of any coin and fill the amount in.
 *
 * Always USD (each coin's price is converted to the order's currency with the
 * instance's FX table in the browser), whatever the operator's fee
 * denomination; present only when at least one coin has a fresh price.
 */
import { describe, expect, it } from 'vitest';

import { buildListingFeeBody } from '$api/listingFeeBody';
import { fakeConfig } from '../testutils/context';

const quotes = (m: Record<string, number>) => ({ currentUsd: () => ({ ...m }) });

describe('listing-fee: asset_prices_usd (v1.23.2)', () => {
	it('the fresh coin prices, with the not-an-oracle warning', () => {
		const body = buildListingFeeBody(
			fakeConfig({ priceFeedEnabled: true }),
			null,
			null,
			null,
			new Date(),
			quotes({ ETH: 3005, LTC: 89.5 })
		);
		expect(body.asset_prices_usd).toEqual({ ETH: 3005, LTC: 89.5 });
		expect(String(body.price_warning)).toMatch(/^NOT-AN-ORACLE/);
	});

	it('on an instance quoting fees in EUR it is still USD', () => {
		const body = buildListingFeeBody(
			fakeConfig({ priceFeedEnabled: true, priceFeedDenominationFiat: 'EUR' }),
			null,
			null,
			null,
			new Date(),
			quotes({ ETH: 3005 })
		);
		expect(body.asset_prices_usd).toEqual({ ETH: 3005 });
	});

	it('absent with no source, or no fresh price', () => {
		const cfg = fakeConfig({ priceFeedEnabled: true });
		expect(buildListingFeeBody(cfg, null, null, null, new Date())).not.toHaveProperty(
			'asset_prices_usd'
		);
		expect(buildListingFeeBody(cfg, null, null, null, new Date(), quotes({}))).not.toHaveProperty(
			'asset_prices_usd'
		);
	});
});
