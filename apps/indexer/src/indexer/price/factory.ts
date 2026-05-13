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
import type { BlurtPriceSource } from '$indexer/price/source';
import { CompositeCachedPriceSource } from '$indexer/price/compositeSource';
import { createKlingexFetcher } from '$indexer/price/klingexFetcher';
import { createCoingeckoFetcher } from '$indexer/price/coingeckoFetcher';

/** Build a price source from the current config. */
export function createPriceSource(config: Config): BlurtPriceSource {
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

	return new CompositeCachedPriceSource({
		upstreams,
		staticFloor: config.priceFeedStaticFloor,
		refreshIntervalMs: config.priceRefreshIntervalMs
	});
}
