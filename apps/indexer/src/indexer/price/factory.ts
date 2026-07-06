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
 * EXTERNAL tier (queried together, then median-anchored + averaged
 * with outlier rejection so no single off/stale provider can swing
 * the committed price), then a FALLBACK tier (morphit_native, kept
 * OUT of the average so the external-vs-native cross-check stays
 * meaningful), then the static floor:
 *
 *   BLURT/USD:  Coingecko + CoinPaprika + CryptoCompare
 *               (+ CoinCap/Messari when keyed, + CoinLore when id set)
 *               → morphit_native → static floor
 *   BTC/USD:    Coingecko + CoinPaprika + Kraken + Binance + Coinbase
 *               + OKX + Bybit + CryptoCompare
 *               (+ CoinCap/CoinLore/Messari when configured)
 *               → morphit_native → static floor
 *   XMR/USD:    Coingecko + CoinPaprika + Kraken + CryptoCompare
 *               (+ CoinCap/CoinLore/Messari when configured)
 *               → morphit_native → static floor
 *
 * Multi-source rationale: a single upstream is an availability AND
 * accuracy risk (it can ban us, rate-limit us to nothing, or simply
 * be wrong).  Querying many and taking the outlier-rejected median
 * survives any one provider failing and tightens accuracy.  Each
 * extra source contributes only when it returns a positive number;
 * a wrong id / dead endpoint / missing listing / required-but-unset
 * key returns null and is silently excluded — it can never corrupt
 * the price.  CEX sources quote USDT or USD and only join when the
 * instance prices in USD.  (XMR is delisted from most CEXes, so
 * only Kraken covers it there; the aggregators carry XMR + BLURT.
 * DEX trackers like DexScreener/GeckoTerminal/Birdeye are not wired
 * — BLURT/BTC/XMR are not DEX-traded pairs there.)
 *
 * (Klingex — the Blurt-community exchange that used to be BLURT's
 * primary external upstream — went out of business in 2026 and was
 * removed; the multi-source set above replaced the single-upstream
 * design.)
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
import { createCoingeckoFetcher } from '$indexer/price/coingeckoFetcher';
import { createBlurtBlogFetcher } from '$indexer/price/blurtBlogFetcher';
import { createCoinpaprikaFetcher } from '$indexer/price/coinpaprikaFetcher';
import { createKrakenFetcher } from '$indexer/price/krakenFetcher';
import { createCryptocompareFetcher } from '$indexer/price/cryptocompareFetcher';
import { createBinanceFetcher } from '$indexer/price/binanceFetcher';
import { createCoinbaseFetcher } from '$indexer/price/coinbaseFetcher';
import { createOkxFetcher } from '$indexer/price/okxFetcher';
import { createBybitFetcher } from '$indexer/price/bybitFetcher';
import { createCoincapFetcher } from '$indexer/price/coincapFetcher';
import { createCoinloreFetcher } from '$indexer/price/coinloreFetcher';
import { createMessariFetcher } from '$indexer/price/messariFetcher';
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
	/** CoinPaprika coin id for the multi-source average (USD only),
	 *  e.g. 'btc-bitcoin'.  Omit for assets CoinPaprika doesn't list. */
	readonly coinpaprikaId?: string;
	/** Kraken USD pair for the multi-source average (USD only), e.g.
	 *  'XBTUSD'.  Omit for assets Kraken doesn't list (e.g. BLURT). */
	readonly krakenPair?: string;
	/** CryptoCompare ticker symbol (USD only), e.g. 'BTC'.  Symbol-
	 *  keyed, no numeric-id lookup; covers BLURT/BTC/XMR. */
	readonly cryptocompareSymbol?: string;
	/** Binance spot symbol (USD only), e.g. 'BTCUSDT'.  Omit for
	 *  assets Binance doesn't list (XMR delisted; no BLURT). */
	readonly binanceSymbol?: string;
	/** Coinbase product id (USD only), e.g. 'BTC-USD'.  Omit for
	 *  assets Coinbase doesn't list (no XMR; no BLURT). */
	readonly coinbaseProduct?: string;
	/** OKX instrument id (USD only), e.g. 'BTC-USDT'.  Omit for
	 *  assets OKX doesn't list (XMR delisted; no BLURT). */
	readonly okxInstId?: string;
	/** Bybit spot symbol (USD only), e.g. 'BTCUSDT'.  Omit for
	 *  assets Bybit doesn't list (XMR delisted; no BLURT). */
	readonly bybitSymbol?: string;
	/** CoinCap asset id (USD only; KEY-GATED), e.g. 'bitcoin'.
	 *  Only joins when an operator CoinCap key is configured. */
	readonly coincapId?: string;
	/** CoinLore numeric asset id as a string (USD only), e.g. '90'
	 *  for Bitcoin.  Opaque per-provider id — must be verified
	 *  against CoinLore; assets without a known id don't wire it. */
	readonly coinloreId?: string;
	/** Messari asset slug (USD only; KEY-GATED), e.g. 'bitcoin'.
	 *  Only joins when an operator Messari key is configured. */
	readonly messariSlug?: string;
	/** Per-asset plausibility window for a committed price.  MUST be
	 *  asset-appropriate — BLURT's tight [0.0001, 0.1] would reject
	 *  every real BTC/XMR quote, so each asset sets its own. */
	readonly plausibleMin: number;
	readonly plausibleMax: number;
	/** Static fallback price for this asset, in the configured
	 *  denomination fiat.  Used when all upstreams fail and no
	 *  cached value exists since boot.  Per-asset defaults:
	 *    BLURT: 0.002    (rough recent BLURT/USD)
	 *    BTC:   60_000   (rough recent BTC/USD)
	 *    XMR:   200      (rough recent XMR/USD)
	 *  An operator on a non-USD denomination should override
	 *  these via env vars. */
	readonly staticFloor: number;
	/** cp425 — true only for BLURT: pull the Blurt-native price feed
	 *  (api.blurt.blog/price_info) as one more external-average source. */
	readonly blurtPriceFeed?: boolean;
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
		coinpaprikaId: 'blurt-blurt',
		// CEXes (Kraken/Binance/Coinbase/OKX/Bybit) don't list BLURT —
		// it averages across the aggregators (Coingecko + CoinPaprika +
		// CryptoCompare, plus CoinCap/Messari when keyed), with
		// morphit_native as the fallback tier + cross-check.  These ids
		// are best-effort and must be verified against each live API on
		// deploy; a wrong id returns null and is harmlessly excluded.
		cryptocompareSymbol: 'BLURT',
		coincapId: 'blurt',
		messariSlug: 'blurt',
		blurtPriceFeed: true,
		staticFloor: 0.002,
		plausibleMin: 0.0001,
		plausibleMax: 0.1
	},
	BTC: {
		asset: 'BTC',
		coingeckoCoinId: 'bitcoin',
		coinpaprikaId: 'btc-bitcoin',
		krakenPair: 'XBTUSD',
		cryptocompareSymbol: 'BTC',
		binanceSymbol: 'BTCUSDT',
		coinbaseProduct: 'BTC-USD',
		okxInstId: 'BTC-USDT',
		bybitSymbol: 'BTCUSDT',
		coincapId: 'bitcoin',
		coinloreId: '90', // CoinLore's stable numeric id for Bitcoin
		messariSlug: 'bitcoin',
		staticFloor: 60_000,
		plausibleMin: 1_000,
		plausibleMax: 10_000_000
	},
	XMR: {
		asset: 'XMR',
		coingeckoCoinId: 'monero',
		coinpaprikaId: 'xmr-monero',
		krakenPair: 'XMRUSD',
		// Binance/Coinbase/OKX/Bybit have delisted or never listed XMR;
		// Kraken is the CEX that still covers it, plus the aggregators.
		// (coinloreId omitted — verify CoinLore's XMR numeric id on
		// deploy before wiring it; until then CoinLore skips XMR.)
		cryptocompareSymbol: 'XMR',
		coincapId: 'monero',
		messariSlug: 'monero',
		staticFloor: 200,
		plausibleMin: 1,
		plausibleMax: 100_000
	}
};

/** Generic per-asset price source builder.  Same logic as the
 *  pre-cp130 BLURT-only factory, generalized on the asset
 *  parameters.
 *
 *  Composes:
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
	const isUsd = config.priceFeedDenominationFiat.toUpperCase() === 'USD';

	// ── EXTERNAL tier (averaged all-at-once) ──
	// Coingecko always (it supports any vs_currency).  CoinPaprika +
	// Kraken return USD quotes, so they only join the average when the
	// instance prices in USD AND the asset has a known symbol there.
	// Pulling from several at once + median-anchored averaging means a
	// single off/stale provider can't swing the committed price.
	const upstreams: Array<{ name: string; fetch: PriceFetch }> = [
		{
			name: 'coingecko',
			fetch: createCoingeckoFetcher({
				baseUrl: config.coingeckoBaseUrl,
				apiKey: config.coingeckoApiKey,
				coinId: options.coingeckoCoinId,
				vsCurrency: config.priceFeedDenominationFiat,
				timeoutMs: 5_000
			})
		}
	];
	if (isUsd && options.coinpaprikaId) {
		upstreams.push({
			name: 'coinpaprika',
			fetch: createCoinpaprikaFetcher({
				baseUrl: config.coinpaprikaBaseUrl,
				coinId: options.coinpaprikaId,
				vsCurrency: 'USD',
				timeoutMs: 5_000
			})
		});
	}
	if (isUsd && options.krakenPair) {
		upstreams.push({
			name: 'kraken',
			fetch: createKrakenFetcher({
				baseUrl: config.krakenBaseUrl,
				pair: options.krakenPair,
				timeoutMs: 5_000
			})
		});
	}
	if (isUsd && options.cryptocompareSymbol) {
		upstreams.push({
			name: 'cryptocompare',
			fetch: createCryptocompareFetcher({
				baseUrl: config.cryptocompareBaseUrl,
				symbol: options.cryptocompareSymbol,
				apiKey: config.cryptocompareApiKey,
				timeoutMs: 5_000
			})
		});
	}
	if (isUsd && options.binanceSymbol) {
		upstreams.push({
			name: 'binance',
			fetch: createBinanceFetcher({
				baseUrl: config.binanceBaseUrl,
				symbol: options.binanceSymbol,
				timeoutMs: 5_000
			})
		});
	}
	if (isUsd && options.coinbaseProduct) {
		upstreams.push({
			name: 'coinbase',
			fetch: createCoinbaseFetcher({
				baseUrl: config.coinbaseBaseUrl,
				product: options.coinbaseProduct,
				timeoutMs: 5_000
			})
		});
	}
	if (isUsd && options.okxInstId) {
		upstreams.push({
			name: 'okx',
			fetch: createOkxFetcher({
				baseUrl: config.okxBaseUrl,
				instId: options.okxInstId,
				timeoutMs: 5_000
			})
		});
	}
	if (isUsd && options.bybitSymbol) {
		upstreams.push({
			name: 'bybit',
			fetch: createBybitFetcher({
				baseUrl: config.bybitBaseUrl,
				symbol: options.bybitSymbol,
				timeoutMs: 5_000
			})
		});
	}
	if (isUsd && options.coinloreId) {
		upstreams.push({
			name: 'coinlore',
			fetch: createCoinloreFetcher({
				baseUrl: config.coinloreBaseUrl,
				assetId: options.coinloreId,
				timeoutMs: 5_000
			})
		});
	}
	// KEY-GATED aggregators — only join the average when the operator
	// has configured the provider's API key (otherwise they'd 401 →
	// null on every call, which is harmless but pointless traffic).
	if (isUsd && options.coincapId && config.coincapApiKey) {
		upstreams.push({
			name: 'coincap',
			fetch: createCoincapFetcher({
				baseUrl: config.coincapBaseUrl,
				assetId: options.coincapId,
				apiKey: config.coincapApiKey,
				timeoutMs: 5_000
			})
		});
	}
	if (isUsd && options.messariSlug && config.messariApiKey) {
		upstreams.push({
			name: 'messari',
			fetch: createMessariFetcher({
				baseUrl: config.messariBaseUrl,
				slug: options.messariSlug,
				apiKey: config.messariApiKey,
				timeoutMs: 5_000
			})
		});
	}
	// cp425 — Blurt-native price feed (api.blurt.blog/price_info). BLURT
	// only, USD only (the feed quotes USD), and only when a URL is set
	// (an operator can blank MORPHIT_INDEXER_BLURT_PRICE_FEED_URL to opt
	// out). One more independent reading in the robust average — and a
	// self-sovereign, non-CEX source, which suits Morphit's priorities.
	if (isUsd && options.blurtPriceFeed && config.blurtPriceFeedUrl) {
		upstreams.push({
			name: 'blurt_price_feed',
			fetch: createBlurtBlogFetcher({
				url: config.blurtPriceFeedUrl,
				plausibleMin: options.plausibleMin,
				plausibleMax: options.plausibleMax,
				timeoutMs: 5_000
			})
		});
	}

	// ── FALLBACK tier (native) — NOT blended into the external
	// average, so defense C's external-vs-native cross-check stays
	// meaningful.  Tried only when every external is down.
	const fallbackUpstreams: Array<{ name: string; fetch: PriceFetch }> = [];
	const nativeFetch = buildMorphitNativeFetch(config, options.asset, db);
	if (nativeFetch) {
		fallbackUpstreams.push({ name: 'morphit_native', fetch: nativeFetch });
	}

	return new CompositeCachedPriceSource({
		upstreams,
		fallbackUpstreams,
		outlierTolerance: config.priceOutlierTolerance,
		plausibleMin: options.plausibleMin,
		plausibleMax: options.plausibleMax,
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
