/**
 * Pure response-body builder for /v1/listing-fee.
 *
 * Extracted from `listingFee.ts` so the gating logic (USD echo
 * only when the operator opted in AND a non-stale, positive price
 * is available) can be unit-tested without spinning up Hono.  The
 * route in `listingFee.ts` is now a thin wrapper around this and
 * a cache-control header.
 *
 * Lives in its own module because tsx-style smokes can't load
 * modules that import `hono` (the package isn't installed in the
 * sandbox).  Hono is a runtime dep of the route; this helper is
 * pure TS.
 */

import type { Config } from '$config';
import type { BlurtPriceSource } from '$indexer/price/source';

export function buildListingFeeBody(
	config: Config,
	priceSource: BlurtPriceSource | null
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		base_fee_blurt: config.feeBaseBlurt,
		feature_fee_blurt_per_hour: config.featureFeeBlurtPerHour,
		// UI consults this to refresh its quote when the TTL
		// elapses. Keep it in sync with the frontend's quote
		// freshness constant.
		quote_ttl_seconds: 300
	};

	// Optional USD echo.  Only attached when the operator opted
	// in to the price feed AND a live (non-stale) value is
	// available.  Frontends use these for ambient subtext like
	// "60 BLURT  (~$0.12)"; if the fields are absent, the UI
	// shows BLURT only.
	if (priceSource !== null) {
		const detail = priceSource.currentDetailed();
		if (!detail.stale && detail.price > 0) {
			body.base_fee_usd = config.feeBaseBlurt * detail.price;
			body.blurt_price_usd = detail.price;
		}
	}

	return body;
}
