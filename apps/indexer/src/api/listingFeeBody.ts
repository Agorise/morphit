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
import { listingFeeBlurtBase, listingFeeSatoshis, listingFeePiconero } from '@morphit/asset-registry';

export function buildListingFeeBody(
	config: Config,
	priceSource: BlurtPriceSource | null,
	btcSource: BlurtPriceSource | null = null,
	xmrSource: BlurtPriceSource | null = null
): Record<string, unknown> {
	// Model A (cp372, canonical): `base_fee_blurt` is the amount the UI
	// quotes and the user pays.  It tracks the CANONICAL USD target
	// (`listingFeeBlurtBase` = LISTING_FEE_USD.blurt ÷ live price ≈
	// 12.5¢) so the fee's USD value stays put instead of drifting as a
	// fixed BLURT constant.  Crucially it does NOT depend on the
	// operator's `feeBaseBlurt`: that value is the *enforcement floor*
	// (order handler accepts feeBaseBlurt × tier ± FEE_PRICE_TOLERANCE,
	// no price read → no TOCTOU, deterministic across the federation).
	// Keeping display canonical means the operator can adjust the floor
	// without distorting the quote.
	//
	// USD denomination only: for USD the live price IS BLURT/USD.  For a
	// non-USD operator the live USD figure isn't available here (no FX
	// source threaded into this route), so we fall back to the pinned
	// base — graceful, and the fiat echo still shows its live value.
	const isUsd = config.priceFeedDenominationFiat.toUpperCase() === 'USD';
	let baseFeeBlurt = config.feeBaseBlurt;
	let liveTracked = false;

	const body: Record<string, unknown> = {
		feature_fee_blurt_per_hour: config.featureFeeBlurtPerHour,
		// UI consults this to refresh its quote when the TTL
		// elapses. Keep it in sync with the frontend's quote
		// freshness constant.
		quote_ttl_seconds: 300
	};

	// Optional fiat-denomination echo.  Only attached when the
	// operator opted in to the price feed AND a live (non-stale)
	// value is available.  Frontends use these for ambient subtext
	// like "62 BLURT  (~$0.12)" (USD) or "62 BLURT  (~€0.11)" (EUR);
	// if the fields are absent, the UI shows BLURT only.
	if (priceSource !== null) {
		const detail = priceSource.currentDetailed();
		if (!detail.stale && detail.price > 0) {
			if (isUsd) {
				const live = listingFeeBlurtBase(detail.price);
				if (live !== null) {
					baseFeeBlurt = live;
					liveTracked = true;
				}
			}
			// USD value of the displayed amount.  With live tracking this
			// equals the canonical target (~$0.125, constant as BLURT
			// moves); with the fixed fallback it's the drifting value of
			// the pinned base at the live price.
			body.base_fee_fiat = baseFeeBlurt * detail.price;
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

	body.base_fee_blurt = baseFeeBlurt;
	// Tells the frontend whether base_fee_blurt is the live USD-tracked
	// amount (true) or the operator's pinned BLURT-native fallback
	// (false — price feed off/stale, or a non-USD denomination).
	body.base_fee_blurt_live = liveTracked;

	// ── Model A (cp372, canonical): live BTC/XMR fee amounts + USD echo ──
	// The order handler enforces the operator's chain-pinned satoshi /
	// piconero amount ± FEE_PRICE_TOLERANCE (see minAcceptableSatoshis
	// / minAcceptablePiconero).  Here we serve the amount the UI should
	// QUOTE: the CANONICAL USD target (LISTING_FEE_USD.{btc,xmr} ≈ 25¢)
	// converted at the live rate, independent of the pinned amount — so
	// the quote's USD value holds while the pinned floor stays
	// authoritative + deterministic.  Gated on a positive configured
	// amount (= the operator accepts that asset for fees).
	//
	// USD denomination only (no FX source in this route): a non-USD
	// operator omits these, and the UI falls back to the chain-pinned
	// amount it already fetches from /v1/release.
	if (isUsd && btcSource !== null && config.btcFeeSatoshis > 0) {
		const d = btcSource.currentDetailed();
		if (!d.stale && d.price > 0) {
			const liveSats = listingFeeSatoshis(d.price);
			if (liveSats !== null && liveSats > 0) {
				body.btc_fee_satoshis = liveSats;
				body.btc_fee_fiat = (liveSats / 1e8) * d.price;
				body.btc_price_fiat = d.price;
				body.btc_fee_live = true;
				body.denomination_fiat = config.priceFeedDenominationFiat;
				body.price_warning =
					'NOT-AN-ORACLE: For Morphit UI display only. Do NOT use as oracle.';
			}
		}
	}

	if (isUsd && xmrSource !== null && config.xmrFeePiconero > 0n) {
		const d = xmrSource.currentDetailed();
		if (!d.stale && d.price > 0) {
			const livePiconero = listingFeePiconero(d.price);
			if (livePiconero !== null && livePiconero > 0n) {
				// piconero as a string — matches /v1/release's
				// representation and avoids Number-range surprises.
				body.xmr_fee_piconero = livePiconero.toString();
				body.xmr_fee_fiat = (Number(livePiconero) / 1e12) * d.price;
				body.xmr_price_fiat = d.price;
				body.xmr_fee_live = true;
				body.denomination_fiat = config.priceFeedDenominationFiat;
				body.price_warning =
					'NOT-AN-ORACLE: For Morphit UI display only. Do NOT use as oracle.';
			}
		}
	}

	return body;
}
