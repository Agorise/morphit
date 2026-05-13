/**
 * Morphit indexer — /v1/listing-fee endpoint.
 *
 * Returns the current baseline listing-fee quote in BLURT.  The
 * frontend reads this on the compose-order page so the UI shows
 * the same number the indexer will check at broadcast time.
 *
 * Response shape:
 *   {
 *     base_fee_blurt: 60,
 *     feature_fee_blurt_per_hour: 50,
 *     quote_ttl_seconds: 300,
 *     base_fee_usd?: 0.12          // optional — present iff
 *                                  //   priceFeedEnabled=true AND
 *                                  //   a live BLURT/USD price is
 *                                  //   currently available.
 *     blurt_price_usd?: 0.002      // same gate as base_fee_usd;
 *                                  //   surfaced so frontends can
 *                                  //   compute USD echoes for
 *                                  //   stranger-fees etc. on their
 *                                  //   own without re-fetching.
 *   }
 *
 * Cache-Control: public, max-age=60.  The values are operator-
 * configured constants that change rarely; clients can live with
 * up to a minute of staleness.  The optional USD echo is freshness-
 * sensitive but the price source's own staleThreshold (2× refresh
 * interval) catches values that have drifted out of usefulness.
 */

import { Hono } from 'hono';

import type { Config } from '$config';
import type { BlurtPriceSource } from '$indexer/price/source';
import { buildListingFeeBody } from '$api/listingFeeBody';

export { buildListingFeeBody };

export function listingFeeRoute(config: Config, priceSource: BlurtPriceSource | null): Hono {
	const app = new Hono();

	app.get('/', (c) => {
		c.header('cache-control', 'public, max-age=60');
		return c.json(buildListingFeeBody(config, priceSource));
	});

	return app;
}
