/**
 * v1.21.15 — on a CLEARNET node whose every clearnet price source is down, the
 * BLURT price comes from the federation (peers' receipts, reached over Tor/I2P
 * when their web address does not answer) before this node's own native price
 * alone or the static floor. The owner's rule: when clearnet does not answer,
 * use the hidden sources.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEE_PRICE_TOLERANCE } from '@morphit/asset-registry';
import type pg from 'pg';

import type { Database } from '$db/pool';
import { createPriceSource } from '$indexer/price/factory';
import { pinnedFeeImpliedUsdPrice } from '$indexer/price/federatedPriceFetcher';
import { fakeConfig } from '../../testutils/context';

/** A database whose only rows are peers' recent BLURT receipts — and, when
 *  `ownTrades` is given, six traders' live fixed-price BLURT/USD orders at that
 *  price (what this node's own morphit_native price is made from). */
function dbWithPeerPrices(prices: number[], ownTrades?: number): Database {
	const query = (async (text: string) => {
		if (text.includes('FROM price_peer_observations ppo')) {
			return { rows: prices.map((p) => ({ observed_price: String(p) })), rowCount: prices.length };
		}
		if (ownTrades !== undefined && text.includes('AND o.fiat_currency = $2')) {
			const rows = Array.from({ length: 6 }, (_, i) => ({
				account: `trader${i}`,
				price_str: String(ownTrades),
				permlink: `o${i}`
			}));
			return { rows, rowCount: rows.length };
		}
		return { rows: [], rowCount: 0 };
	}) as unknown as Database['query'];
	return {
		query,
		async withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
			return fn({} as pg.PoolClient);
		},
		async close() {}
	};
}

afterEach(() => vi.unstubAllGlobals());

describe('BLURT price on a clearnet node with every clearnet source down', () => {
	it('uses the federation’s price, not the static floor', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new Error('connect ETIMEDOUT');
		});
		const config = fakeConfig();
		expect(config.blurtRpcEndpoints.length, 'a clearnet node').toBeGreaterThan(0);
		const pinned = pinnedFeeImpliedUsdPrice('BLURT', {
			blurtBase: config.feeBaseBlurt,
			btcSatoshis: null,
			xmrPiconero: null
		});
		expect(pinned).not.toBeNull();
		const p = pinned ?? 0;
		const source = createPriceSource(config, dbWithPeerPrices([p * 0.99, p, p * 1.01]));
		await (source as unknown as { refreshOnce(): Promise<void> }).refreshOnce();
		const got = source.currentDetailed();
		expect(got.source).toBe('federated');
		expect(got.price).toBeCloseTo(p, 10);
	});

	it('the federation comes BEFORE this node’s own native price (which is only one sample)', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new Error('connect ETIMEDOUT');
		});
		const config = fakeConfig({ priceFeedNativeEnabled: true });
		const p =
			pinnedFeeImpliedUsdPrice('BLURT', {
				blurtBase: config.feeBaseBlurt,
				btcSatoshis: null,
				xmrPiconero: null
			}) ?? 0;
		const source = createPriceSource(config, dbWithPeerPrices([p * 0.99, p, p * 1.01], p * 1.04));
		await (source as unknown as { refreshOnce(): Promise<void> }).refreshOnce();
		const got = source.currentDetailed();
		expect(got.source).toBe('federated');
		// The median of three peers and this node: (p + 1.01p) / 2.
		expect(got.price).toBeCloseTo(p * 1.005, 10);
	});

	it('ten sybil peers at ten times the price cannot move it past the fee band (the chain pin bounds it)', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new Error('connect ETIMEDOUT');
		});
		const config = fakeConfig();
		const p =
			pinnedFeeImpliedUsdPrice('BLURT', {
				blurtBase: config.feeBaseBlurt,
				btcSatoshis: null,
				xmrPiconero: null
			}) ?? 0;
		const sybils = Array.from({ length: 10 }, () => p * 10);
		const source = createPriceSource(config, dbWithPeerPrices([p * 0.99, p, p * 1.01, ...sybils]));
		await (source as unknown as { refreshOnce(): Promise<void> }).refreshOnce();
		const got = source.currentDetailed();
		expect(got.source).toBe('federated');
		expect(got.price).toBeLessThanOrEqual(p * (1 + FEE_PRICE_TOLERANCE) + 1e-12);
	});

	it('with too few peer receipts, it still ends where it did before (no federated value)', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new Error('connect ETIMEDOUT');
		});
		const source = createPriceSource(fakeConfig(), dbWithPeerPrices([0.004]));
		await (source as unknown as { refreshOnce(): Promise<void> }).refreshOnce();
		expect(source.currentDetailed().source).not.toBe('federated');
	});

	it('not where the chain pin cannot bound it (a non-USD denomination)', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new Error('connect ETIMEDOUT');
		});
		const source = createPriceSource(
			fakeConfig({ priceFeedDenominationFiat: 'EUR' }),
			dbWithPeerPrices([0.004, 0.004, 0.004])
		);
		await (source as unknown as { refreshOnce(): Promise<void> }).refreshOnce();
		expect(source.currentDetailed().source).not.toBe('federated');
	});
});
