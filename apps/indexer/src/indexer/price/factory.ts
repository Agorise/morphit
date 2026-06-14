/**
 * Price-source factory (cp130 multi-asset).
 *
 * Builds CompositeCachedPriceSource instances from operator config.
 * Each price source serves an OPTIONAL fiat echo for one (asset,
 * denomination_fiat) pair.  Fee verification on /v1/listing-fee is
 * BLURT-native and doesn't need any of these — they're for display
 * surfaces (listing-fee USD echo for BLURT, future orderbook
 * USD-equivalent display for BTC/XMR/etc.).
 *
 * Only invoked when `config.priceFeedEnabled === true` (operator
 * opt-in).  Default operator deployments leave it off; the
 * indexer makes ZERO outbound HTTP calls for pricing.
 *
 * Per-asset composition
 * ─────────────────────
 *   BLURT/USD:  Klingex → Coingecko → morphit_native → static floor
 *   BTC/USD:                Coingecko → morphit_native → static floor
 *   XMR/USD:                Coingecko → morphit_native → static floor
 *
 * Klingex is BLURT-only (the exchange's flagship pair is BLURT/USDT;
 * it doesn't trade BTC/USDT or XMR/USDT at scale, so we don't query
 * it for non-BLURT assets).
 *
 * The factory returns a BlurtPriceSource per asset, each started-
 * ready; caller must invoke source.start() and source.stop() for
 * lifecycle management.
 *
 * cp128 denomination
 * ──────────────────
 * `denominationFiat` (operator config) applies uniformly to all
 * assets.  An operator who sets `priceFeedDenominationFiat=EUR`
 * gets BLURT/EUR, BTC/EUR, XMR/EUR — coherent display unit across
 * the whole instance.  Per-asset denomination override was
 * considered (item #3 from Ken's six-bullet ask) but deemed
 * preemptive complexity; if a concrete use case appears (e.g.
 * operator wants BTC priced in USD but BLURT in EUR), revisit then.
 *
 * cp130 architecture
 * ──────────────────
 * The previous `createPriceSource(config, db)` returned just one
 * BlurtPriceSource (BLURT-only).  cp130 keeps that signature for
 * backwards compatibility (the listing-fee endpoint uses it) and
 * adds a new `createMultiAssetPriceSources(config, db)` that
 * returns a Map of sources for BLURT + BTC + XMR.  Each source is
 * independent — different cache, different upstream chain.
 */

import type { Config } from '$config';
import type { Database } from '$db/pool';
import type { BlurtPriceSource, PriceFetch } from '$indexer/price/source';
import { CompositeCachedPriceSource } from '$indexer/price/compositeSource';
import { createKlingexFetcher } from '$indexer/price/klingexFetcher';
import { createCoingeckoFetcher } from '$indexer/price/coingeckoFetcher';
import { createMorphitNativeFetcher } from '$indexer/price/morphitNativeFetcher';
import { DisagreementMonitor } from '$indexer/price/disagreementMonitor';

/** Per-asset configuration for one price source.
 *
 *  Captures everything that differs per-asset so the generic
 *  factory below can build any (asset, denomination_fiat) pair.
 *
 *  cp130 assets supported: BLURT, BTC, XMR.  Future assets are a
 *  matter of adding entries here. */
export interface AssetPriceSourceOptions {
	/** Asset ticker, e.g. 'BLURT', 'BTC', 'XMR'. */
	readonly asset: string;
	/** Coingecko's internal coin id for this asset, e.g. 'blurt',
	 *  'bitcoin', 'monero'. */
	readonly coingeckoCoinId: string;
	/** Whether to include the Klingex upstream.  True for BLURT
	 *  (Klingex's flagship pair); false for BTC/XMR (Klingex
	 *  doesn't trade these at scale). */
	readonly enableKlingex: boolean;
	/** Static fallback price for this asset, in the configured
	 *  denomination fiat.  Used when all upstreams fail and no
	 *  cached value exists since boot.  Per-asset defaults:
	 *    BLURT: 0.002    (rough recent BLURT/USD)
	 *    BTC:   60_000   (rough recent BTC/USD)
	 *    XMR:   200      (rough recent XMR/USD)
	 *  An operator on a non-USD denomination should override
	 *  these via env vars. */
	readonly staticFloor: number;
}

/** Per-asset known defaults for the cp130 launch set.  Operators
 *  who want different values override via env vars.
 *
 *  Coingecko coin ids are stable (the Coingecko project doesn't
 *  rename these often; the IDs were stable for years for BTC and
 *  XMR — 'bitcoin' since 2013, 'monero' since 2014).
 *
 *  Static-floor defaults are ROUGH and intentionally so — the
 *  composite source uses the static floor only when all live
 *  upstreams have failed AND no cached value exists.  In normal
 *  operation the static floor never surfaces to users.  Operators
 *  in non-USD denominations should override the floors via env
 *  vars to match their unit. */
export const CP130_ASSET_DEFAULTS: Record<string, AssetPriceSourceOptions> = {
	BLURT: {
		asset: 'BLURT',
		coingeckoCoinId: 'blurt',
		enableKlingex: true,
		staticFloor: 0.002
	},
	BTC: {
		asset: 'BTC',
		coingeckoCoinId: 'bitcoin',
		enableKlingex: false,
		staticFloor: 60_000
	},
	XMR: {
		asset: 'XMR',
		coingeckoCoinId: 'monero',
		enableKlingex: false,
		staticFloor: 200
	}
};

/** Generic per-asset price source builder.  Same logic as the
 *  pre-cp130 BLURT-only factory, generalized on the asset
 *  parameters.
 *
 *  Composes:
 *   - Klingex (if enableKlingex)
 *   - Coingecko (always; needs the per-asset coinId)
 *   - morphit_native (if priceFeedNativeEnabled AND db provided)
 *   - Static floor
 *
 *  Caller is responsible for calling source.start() and
 *  source.stop() for lifecycle. */
export function createAssetPriceSource(
	config: Config,
	options: AssetPriceSourceOptions,
	db?: Database
): BlurtPriceSource {
	const upstreams: Array<{ name: string; fetch: () => Promise<number | null> }> = [];

	if (options.enableKlingex) {
		upstreams.push({
			name: 'klingex',
			fetch: createKlingexFetcher({
				baseUrl: config.klingexBaseUrl,
				timeoutMs: 5_000
			})
		});
	}

	// cp130: Coingecko now takes vsCurrency from operator config
	// (was hardcoded 'usd' pre-cp130).  Coingecko's own free-tier
	// supports many vs_currencies — usd, eur, gbp, jpy, brl, cny,
	// inr, rub, etc.
	upstreams.push({
		name: 'coingecko',
		fetch: createCoingeckoFetcher({
			baseUrl: config.coingeckoBaseUrl,
			apiKey: config.coingeckoApiKey,
			coinId: options.coingeckoCoinId,
			vsCurrency: config.priceFeedDenominationFiat,
			timeoutMs: 5_000
		})
	});

	// morphit_native (cp127), routed to this asset+denomination pair.
	// Slotted between coingecko and the static floor — external
	// sources remain primary; native fires when external is
	// unavailable (or operators opt into preferring native via the
	// disagreement-monitor priority flip).  See ADR-0039.
	//
	// cp233: built via the shared buildMorphitNativeFetch helper so
	// defense C's cross-check reuses the EXACT same construction (same
	// config args) — no drift between the upstream and the monitor.
	// The helper returns null when native is disabled or no db is
	// available, which folds the old `priceFeedNativeEnabled && db`
	// guard into the null check.
	const nativeFetch = buildMorphitNativeFetch(config, options.asset, db);
	if (nativeFetch) {
		upstreams.push({ name: 'morphit_native', fetch: nativeFetch });
	}

	return new CompositeCachedPriceSource({
		upstreams,
		staticFloor: options.staticFloor,
		refreshIntervalMs: config.priceRefreshIntervalMs,
		// cp233 — Defense B (slow-drift) wiring: pass db + asset +
		// denomination so each successful refresh updates the persisted
		// drift baseline (price_drift_baseline) and surfaces sustained
		// divergence on /v1/health.  db may be undefined for callers
		// that don't need persistence (then drift monitoring is skipped).
		db,
		asset: options.asset,
		denominationFiat: config.priceFeedDenominationFiat
	});
}

/** Build the BLURT price source from operator config.
 *
 *  Thin wrapper around `createAssetPriceSource` for the BLURT
 *  defaults; preserved as the public API for callers that only
 *  need BLURT pricing (e.g. listing-fee endpoint).
 *
 *  cp130: the actual logic moved into `createAssetPriceSource`;
 *  this function is now ~5 lines.  Existing callers see the same
 *  behavior. */
export function createPriceSource(config: Config, db?: Database): BlurtPriceSource {
	const blurtOptions: AssetPriceSourceOptions = {
		...CP130_ASSET_DEFAULTS.BLURT!,
		staticFloor: config.priceFeedStaticFloor
	};
	return createAssetPriceSource(config, blurtOptions, db);
}

/** Build a map of price sources for all cp130-supported assets.
 *
 *  Each entry's static-floor reads from a per-asset env var when
 *  available; the cp130 launch set:
 *
 *    BLURT: config.priceFeedStaticFloor              (existing env)
 *    BTC:   config.priceFeedBtcStaticFloor           (new env, cp130)
 *    XMR:   config.priceFeedXmrStaticFloor           (new env, cp130)
 *
 *  Returns a Map keyed by uppercase asset ticker.  Callers iterate
 *  to start() / stop() lifecycle; lookups for a specific asset use
 *  .get('BLURT'), etc.
 *
 *  All sources share the same operator-configured denomination
 *  (`priceFeedDenominationFiat`).  Per-asset denomination is not
 *  supported in cp130 (see factory.ts header comment for rationale). */
export function createMultiAssetPriceSources(
	config: Config,
	db?: Database
): Map<string, BlurtPriceSource> {
	const sources = new Map<string, BlurtPriceSource>();
	sources.set(
		'BLURT',
		createAssetPriceSource(
			config,
			{ ...CP130_ASSET_DEFAULTS.BLURT!, staticFloor: config.priceFeedStaticFloor },
			db
		)
	);
	sources.set(
		'BTC',
		createAssetPriceSource(
			config,
			{ ...CP130_ASSET_DEFAULTS.BTC!, staticFloor: config.priceFeedBtcStaticFloor },
			db
		)
	);
	sources.set(
		'XMR',
		createAssetPriceSource(
			config,
			{ ...CP130_ASSET_DEFAULTS.XMR!, staticFloor: config.priceFeedXmrStaticFloor },
			db
		)
	);
	return sources;
}

/** Build the morphit_native price fetcher for one (asset, fiat)
 *  pair, or null when native pricing is disabled / no db is
 *  available.  cp233 — extracted from createAssetPriceSource so the
 *  composite's native upstream AND defense C's cross-check share one
 *  construction (identical config args, no drift between them). */
function buildMorphitNativeFetch(
	config: Config,
	asset: string,
	db?: Database
): PriceFetch | null {
	if (!config.priceFeedNativeEnabled || !db) return null;
	return createMorphitNativeFetcher({
		asset,
		denominationFiat: config.priceFeedDenominationFiat,
		stablecoinKeys: config.priceFeedStablecoinKeys,
		db,
		operatorAccountName: config.operatorAccountName,
		minPlausibleUsd: config.priceFeedNativePlausibleMin,
		maxPlausibleUsd: config.priceFeedNativePlausibleMax
	});
}

/** cp233 — Defense C wiring.  Build the in-process disagreement
 *  monitor + the native fetcher for one asset, or null when the
 *  asset isn't eligible.
 *
 *  Eligibility: native pricing enabled + a db present (native
 *  derives from on-chain trade data).  An external reference is
 *  always available when external sources are reachable, because
 *  coingecko is an unconditional upstream for every asset — so the
 *  only gate is "do we have a native price to cross-check?".
 *
 *  Returns the monitor (held by the caller for /v1/health) and the
 *  native fetcher (driven by the monitor loop each cycle).  The
 *  denomination is the global operator setting (cp128). */
export function createDisagreementMonitor(
	config: Config,
	asset: string,
	db?: Database
): { monitor: DisagreementMonitor; nativeFetch: PriceFetch } | null {
	const nativeFetch = buildMorphitNativeFetch(config, asset, db);
	if (!nativeFetch) return null;
	const monitor = new DisagreementMonitor(asset, config.priceFeedDenominationFiat);
	return { monitor, nativeFetch };
}
