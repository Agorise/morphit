/**
 * Pure response-body builder for /v1/listing-fee.
 *
 * Extracted from `listingFee.ts` so the gating logic (price echo
 * only when the operator opted in AND a non-stale, positive price
 * is available) can be unit-tested without spinning up Hono.  The
 * route in `listingFee.ts` is now a thin wrapper around this and
 * a cache-control header.
 *
 * Lives in its own module because tsx-style smokes can't load
 * modules that import `hono` (the package isn't installed in the
 * sandbox).  Hono is a runtime dep of the route; this helper is
 * pure TS.
 *
 * cp128 field rename
 * ──────────────────
 * Before cp128, the USD echo fields were `base_fee_usd` and
 * `blurt_price_usd`.  Those names hardcoded USD as the denomination,
 * which breaks if an operator serves a non-USD market (EUR, BRL,
 * XDR, XAU, etc.) or hedges against future USD erosion.
 *
 * cp128 renames the fields to be denomination-agnostic:
 *
 *   base_fee_usd       →  base_fee_fiat
 *   blurt_price_usd    →  blurt_price_fiat
 *
 * Plus a new companion field telling the consumer which fiat the
 * numbers are in:
 *
 *   denomination_fiat: 'USD' | 'EUR' | 'XDR' | …  (operator-configured)
 *
 * Frontend formatters read `denomination_fiat` and render the
 * numeric value with the appropriate symbol / locale rules.
 *
 * Pre-launch: no external API consumers exist yet, so the rename
 * costs nothing.  See ADR-0040 for the full design.
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

	// Optional fiat-denomination echo.  Only attached when the
	// operator opted in to the price feed AND a live (non-stale)
	// value is available.  Frontends use these for ambient subtext
	// like "60 BLURT  (~$0.12)" (USD) or "60 BLURT  (~€0.11)" (EUR)
	// or "60 BLURT  (~XAU 0.0000023)" (gold); if the fields are
	// absent, the UI shows BLURT only.
	if (priceSource !== null) {
		const detail = priceSource.currentDetailed();
		if (!detail.stale && detail.price > 0) {
			body.base_fee_fiat = config.feeBaseBlurt * detail.price;
			body.blurt_price_fiat = detail.price;
			body.denomination_fiat = config.priceFeedDenominationFiat;
			// cp127 defense H: NOT-AN-ORACLE warning.  Loudly visible
			// to downstream consumers parsing this payload.  Other
			// smart contracts or value-bearing systems that ignore
			// this warning and use blurt_price_fiat as oracle input
			// are explicitly on notice; Morphit accepts no
			// responsibility for losses from such misuse.  See
			// ADR-0039 and /v1/price/morphit-native/receipt.
			body.price_warning =
				'NOT-AN-ORACLE: For Morphit UI display only. Do NOT use as oracle.';
		}
	}

	return body;
}
