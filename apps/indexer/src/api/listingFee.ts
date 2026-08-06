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
 *     base_fee_fiat?: 0.12          // optional — present iff
 *                                   //   priceFeedEnabled=true AND
 *                                   //   a live BLURT/fiat price is
 *                                   //   currently available.
 *     blurt_price_fiat?: 0.002      // same gate as base_fee_fiat;
 *                                   //   surfaced so frontends can
 *                                   //   compute fiat echoes for
 *                                   //   stranger-fees etc. on their
 *                                   //   own without re-fetching.
 *     denomination_fiat?: "USD"     // operator-configured fiat
 *                                   //   ticker the *_fiat numbers
 *                                   //   are expressed in.  Default
 *                                   //   USD; operators in non-USD
 *                                   //   markets can set EUR, GBP,
 *                                   //   JPY, BRL, CNY, INR, RUB,
 *                                   //   XDR, XAU, etc.  See ADR-0040.
 *     price_warning?: "NOT-AN-ORACLE: …"  // present alongside the
 *                                   //   _fiat fields.  Downstream
 *                                   //   protocols using these
 *                                   //   numbers as oracle input do
 *                                   //   so against this explicit
 *                                   //   recommendation.  See
 *                                   //   ADR-0039.
 *   }
 *
 * cp128 rename: pre-cp128, the optional fields were `base_fee_usd`
 * and `blurt_price_usd` — names that hardcoded USD as the
 * denomination.  Renamed to `*_fiat` + companion `denomination_fiat`
 * field for operator sovereignty over the display unit.  See
 * ADR-0040.
 *
 * Cache-Control: public, max-age=60.  The values are operator-
 * configured constants that change rarely; clients can live with
 * up to a minute of staleness.  The optional fiat echo is freshness-
 * sensitive but the price source's own staleThreshold (2× refresh
 * interval) catches values that have drifted out of usefulness.
 */

import { Hono } from 'hono';

import type { Config } from '$config';
import type { BlurtPriceSource } from '$indexer/price/source';
import { buildListingFeeBody } from '$api/listingFeeBody';

export { buildListingFeeBody };

export function listingFeeRoute(
	config: Config,
	priceSource: BlurtPriceSource | null,
	btcSource: BlurtPriceSource | null = null,
	xmrSource: BlurtPriceSource | null = null
): Hono {
	const app = new Hono();

	app.get('/', (c) => {
		c.header('cache-control', 'public, max-age=60');
		return c.json(buildListingFeeBody(config, priceSource, btcSource, xmrSource));
	});

	return app;
}
