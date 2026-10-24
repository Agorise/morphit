/**
 * v1.21.15 review — the federated price fails CLOSED: where the chain-pin
 * bound is meant to apply but cannot be had, a sybil majority (ten free peers
 * at ten times the price) must not become this node's price.
 */
import { describe, expect, it } from 'vitest';
import { FEE_PRICE_TOLERANCE } from '@morphit/asset-registry';
import { createFederatedFetcher } from '$indexer/price/federatedPriceFetcher';
import type { Database } from '$db/pool';

const HONEST = 0.002;
/** Three honest operators and ten sybils at 10x, one latest sample each. */
const db = {
	query: async () => ({
		rows: [
			...[0.0021, 0.0019, 0.002].map((p) => ({ observed_price: String(p) })),
			...Array.from({ length: 10 }, () => ({ observed_price: String(HONEST * 10) }))
		]
	})
} as unknown as Database;

const fetcher = (pinnedPrice?: () => Promise<number | null>) =>
	createFederatedFetcher({
		db,
		asset: 'BLURT',
		denominationFiat: 'USD',
		ownNative: async () => HONEST,
		freshnessMinutes: 240,
		minObservations: 3,
		...(pinnedPrice ? { pinnedPrice } : {})
	});

describe('federated price under a 10x sybil majority', () => {
	it('with the pin: held to the pin ± tolerance', async () => {
		const p = await fetcher(async () => HONEST)();
		expect(p).not.toBeNull();
		expect(p!).toBeLessThanOrEqual(HONEST * (1 + FEE_PRICE_TOLERANCE) + 1e-12);
	});
	it('pin meant to apply but none for this asset: no price (never the sybils’ 10x)', async () => {
		expect(await fetcher(async () => null)()).toBeNull();
	});
	it('pin read failing: no price', async () => {
		expect(
			await fetcher(async () => {
				throw new Error('db down');
			})()
		).toBeNull();
	});
	it('a nonsensical pin (zero, NaN): no price', async () => {
		expect(await fetcher(async () => 0)()).toBeNull();
		expect(await fetcher(async () => Number.NaN)()).toBeNull();
	});
	it('no bound meant to apply (non-USD / no database): the plain median, as before', async () => {
		expect(await fetcher()()).toBeCloseTo(HONEST * 10, 8);
	});
});
