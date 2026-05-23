/**
 * Price-source factory.
 *
 * Builds a CompositeCachedPriceSource from operator config.  The
 * source serves an OPTIONAL USD echo on /v1/listing-fee — fee
 * verification is BLURT-native and doesn't need it.
 *
 * Only invoked when `config.priceFeedEnabled === true` (operator
 * opt-in).  Default operator deployments leave it off; the
 * indexer makes ZERO outbound HTTP calls for pricing.
 *
 * Composition: Klingex (preferred — Blurt-ecosystem-native,
 * Agorise-operated) → Coingecko (broader but more rate-limited).
 * If both fail, the static floor in
 * `config.priceFeedStaticFloor` is served until the next
 * successful refresh.
 *
 * The factory returns a BlurtPriceSource that's started-ready;
 * caller must invoke source.start() when the indexer's other
 * long-lived concerns come up, and source.stop() on shutdown.
 */

import type { Config } from '$config';
import type { Database } from '$db/pool';
import type { BlurtPriceSource } from '$indexer/price/source';
import { CompositeCachedPriceSource } from '$indexer/price/compositeSource';
import { createKlingexFetcher } from '$indexer/price/klingexFetcher';
import { createCoingeckoFetcher } from '$indexer/price/coingeckoFetcher';
import { createMorphitNativeFetcher } from '$indexer/price/morphitNativeFetcher';

/** Build a price source from the current config.
 *
 *  When `priceFeedNativeEnabled` is true AND a database handle is
 *  provided, morphit_native is slotted between coingecko and the
 *  static floor.  The composite chain becomes:
 *
 *    klingex → coingecko → morphit_native → static floor
 *
 *  When `priceFeedNativeEnabled` is false (default), the chain is
 *  unchanged:
 *
 *    klingex → coingecko → static floor
 *
 *  The db parameter is optional so existing call sites that don't
 *  yet plumb a Database (e.g., the legacy listing-fee path) can
 *  call `createPriceSource(config)` without breaking — they'll get
 *  the old behavior even if `priceFeedNativeEnabled` is true.
 *  The main wiring path will pass `db`. */
export function createPriceSource(config: Config, db?: Database): BlurtPriceSource {
	const upstreams: Array<{ name: string; fetch: () => Promise<number | null> }> = [
		{
			name: 'klingex',
			fetch: createKlingexFetcher({
				baseUrl: config.klingexBaseUrl,
				timeoutMs: 5_000
			})
		},
		{
			name: 'coingecko',
			fetch: createCoingeckoFetcher({
				baseUrl: config.coingeckoBaseUrl,
				apiKey: config.coingeckoApiKey,
				coinId: 'blurt',
				timeoutMs: 5_000
			})
		}
	];

	// cp127: append morphit_native AFTER coingecko, BEFORE static
	// floor.  This means external sources remain primary; native
	// only fires when external is unavailable.  The disagreement
	// monitor surfaces sustained external-vs-native divergence; the
	// priority-flip env var lets operators opt into preferring
	// native when disagreeing.
	if (config.priceFeedNativeEnabled && db) {
		upstreams.push({
			name: 'morphit_native',
			fetch: createMorphitNativeFetcher({
				asset: 'BLURT',
				denominationFiat: 'USD',
				stablecoinKeys: config.priceFeedStablecoinKeys,
				db,
				minPlausibleUsd: config.priceFeedNativePlausibleMin,
				maxPlausibleUsd: config.priceFeedNativePlausibleMax
			})
		});
	}

	return new CompositeCachedPriceSource({
		upstreams,
		staticFloor: config.priceFeedStaticFloor,
		refreshIntervalMs: config.priceRefreshIntervalMs
	});
}
