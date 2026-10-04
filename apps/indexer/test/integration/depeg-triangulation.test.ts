/**
 * With three stablecoins, one manipulated pair does not mark healthy coins
 * depegged, and a coin that really depegs is the only one marked, on
 * real Postgres with the real detector.
 *
 * Each coin has two pairs, and the "median" of two deviations is their mean:
 * three traders pushing ONE pair 7% marked both of its (healthy) coins
 * depegged, and a real 8% depeg of DAI marked USDT depegged as well — knocking
 * honest stablecoins out of the tier-2 price.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { detectStablecoinDepeg } from '../../src/indexer/price/stablecoinDepegDetector';

describe.skipIf(!INTEGRATION_ENABLED)('stablecoin depeg triangulation', () => {
	let fx: IntegrationFixture;
	let n = 0;

	/** Three traders, each with a prior order (the cold-start floor) and a live
	 *  order selling `asset` paid in `pay` at `price`. */
	async function seed(asset: string, pay: string, price: number, tag: string): Promise<void> {
		for (let t = 0; t < 3; t++) {
			const acct = `d${tag}${t}`;
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, expires_at, fee_status)
				 VALUES ($1, $2, 'sell', $3, 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'], 'completed',
				         NOW() - interval '3 days', NOW(), NOW() + interval '9 days', 'verified')`,
				[acct, `prev${n++}`, asset]
			);
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, expires_at, fee_status)
				 VALUES ($1, $2, 'sell', $3, 'USD', jsonb_build_object('kind', 'fixed', 'price', $4::numeric),
				         ARRAY[$5], 'live', NOW() - interval '1 hour', NOW(), NOW() + interval '9 days', 'verified')`,
				[acct, `p${n++}`, asset, price, pay]
			);
		}
	}
	const detect = async () =>
		(
			await detectStablecoinDepeg(fx.db, {
				stablecoinKeys: ['USDT', 'USDC', 'DAI'],
				operatorAccountName: 'morphit'
			} as never)
		).status;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	beforeEach(async () => {
		await fx.db.query(`DELETE FROM orders`);
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('one pair pushed 7% marks nobody depegged', async () => {
		await seed('USDC', 'pay_usdt', 1.0, 'a');
		await seed('DAI', 'pay_usdc', 1.0, 'b');
		await seed('DAI', 'pay_usdt', 1.07, 'c');
		expect(await detect()).toEqual({ usdt: 'pegged', usdc: 'pegged', dai: 'pegged' });
	});

	it('a real DAI depeg marks DAI only', async () => {
		await seed('USDC', 'pay_usdt', 1.0, 'a');
		await seed('DAI', 'pay_usdc', 0.92, 'b');
		await seed('DAI', 'pay_usdt', 0.92, 'c');
		expect(await detect()).toEqual({ usdt: 'pegged', usdc: 'pegged', dai: 'depegged' });
	});
});
