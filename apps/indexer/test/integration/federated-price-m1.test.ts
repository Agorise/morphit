/**
 * v1.18.0 deep-deep, M1 — Sybil peers must not control the federated price a
 * hidden-only node quotes fees from.
 *
 * rv6 A6: the federated median was taken over every OBSERVATION ROW, not one
 * sample per peer operator, and nothing bounded it. Five free sybil peers at
 * 0.1 USD/BLURT outvoted three honest peers + self, the hidden-only node quoted
 * ~1.25 BLURT against an enforced floor of ~106, and every order landed
 * `underpaid` (fee lost). This runs the real fetcher against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FEE_PRICE_TOLERANCE } from '@morphit/asset-registry';

import { createFederatedFetcher } from '../../src/indexer/price/federatedPriceFetcher';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';

const PINNED = 0.002; // USD/BLURT implied by the chain-pinned fee base

describe.skipIf(!INTEGRATION_ENABLED)(
	'M1 — federated price: one sample per operator, clamped to the pin',
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			if (fx) await fx.teardown();
		});
		beforeEach(async () => {
			await truncateAll(fx);
			await fx.db.query(`TRUNCATE known_instances, price_peer_observations CASCADE`);
		});

		async function peer(origin: string, operator: string) {
			await fx.db.query(
				`INSERT INTO known_instances (origin, operator_account, registered_at_block, registered_at_time, last_probe_status)
			 VALUES ($1, $2, 1, NOW(), 'good') ON CONFLICT DO NOTHING`,
				[origin, operator]
			);
		}
		async function observe(origin: string, price: number, minutesAgo = 1) {
			await fx.db.query(
				`INSERT INTO price_peer_observations (peer_origin, asset, denomination_fiat, observed_price, observed_at, source_native)
			 VALUES ($1, 'BLURT', 'USD', $2, NOW() - make_interval(mins => $3), 'morphit_native')`,
				[origin, price, minutesAgo]
			);
		}
		function fetcher(pinned: number | null = PINNED) {
			return createFederatedFetcher({
				db: fx.db,
				asset: 'BLURT',
				denominationFiat: 'USD',
				ownNative: async () => 0.0021,
				freshnessMinutes: 240,
				minObservations: 3,
				pinnedPrice: async () => pinned
			});
		}

		it('many samples (and many origins) of ONE operator count once', async () => {
			await peer('http://h1.example', 'h1');
			await peer('http://h2.example', 'h2');
			await observe('http://h1.example', 0.0022);
			await observe('http://h2.example', 0.002);
			// One operator, three origins, many repeated samples at 0.0023.
			for (const o of ['http://s-a.example', 'http://s-b.example', 'http://s-c.example']) {
				await peer(o, 'sybil');
				for (let i = 0; i < 4; i++) await observe(o, 0.0023, i + 1);
			}
			// Samples: h1 0.0022, h2 0.002, sybil 0.0023, self 0.0021 → median 0.00215.
			expect(await fetcher()()).toBeCloseTo(0.00215, 8);
		});

		it("an operator's LATEST sample is the one that counts", async () => {
			await peer('http://h1.example', 'h1');
			await peer('http://h2.example', 'h2');
			await observe('http://h1.example', 0.0022, 1);
			await observe('http://h1.example', 0.09, 60); // older, superseded
			await observe('http://h2.example', 0.002, 1);
			// h1 0.0022, h2 0.002, self 0.0021 → 0.0021
			expect(await fetcher()()).toBeCloseTo(0.0021, 8);
		});

		it('observations from origins not in the federation directory are ignored', async () => {
			await peer('http://h1.example', 'h1');
			await peer('http://h2.example', 'h2');
			await observe('http://h1.example', 0.0022);
			await observe('http://h2.example', 0.002);
			for (let i = 0; i < 5; i++) await observe(`http://ghost${i}.example`, 0.1);
			expect(await fetcher()()).toBeCloseTo(0.0021, 8);
		});

		it('the rv6 A6 sybil majority is clamped to the chain-pinned price ± FEE_PRICE_TOLERANCE', async () => {
			let i = 0;
			for (const p of [0.0021, 0.0022, 0.002]) {
				await peer(`http://honest${i}.example`, `honest${i}`);
				await observe(`http://honest${i++}.example`, p);
			}
			for (let k = 0; k < 5; k++) {
				await peer(`http://sybil${k}.example`, `sybil${k}`);
				await observe(`http://sybil${k}.example`, 0.1);
			}
			const high = await fetcher()();
			expect(high).not.toBeNull();
			expect(high!).toBeLessThanOrEqual(PINNED * (1 + FEE_PRICE_TOLERANCE) + 1e-12);

			await fx.db.query(
				`UPDATE price_peer_observations SET observed_price = 0.0000001 WHERE peer_origin LIKE 'http://sybil%'`
			);
			const low = await fetcher()();
			expect(low!).toBeGreaterThanOrEqual(PINNED * (1 - FEE_PRICE_TOLERANCE) - 1e-12);
		});

		it('with no pinned price available the median is returned unclamped (non-USD / no pin)', async () => {
			await peer('http://h1.example', 'h1');
			await peer('http://h2.example', 'h2');
			await observe('http://h1.example', 0.0022);
			await observe('http://h2.example', 0.002);
			expect(await fetcher(null)()).toBeCloseTo(0.0021, 8);
		});
	}
);
