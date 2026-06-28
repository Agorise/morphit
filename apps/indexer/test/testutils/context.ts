/**
 * Test fixtures — OpContext builder.
 *
 * Handler tests care about: the payload, the signer, and
 * occasionally the config. Everything else gets sensible defaults.
 * Using this builder keeps tests focused on the distinguishing
 * inputs rather than the 9 fields of OpContext scaffolding.
 */

import type { BlurtClient } from '$blurt/client';
import type { Config } from '$config';
import type { OpContext } from '$indexer/handler-contract';
import { FEE_FALLBACK } from '@morphit/asset-registry';

/** A BlurtClient stand-in that throws if any method is called.
 *  Handlers that don't touch the chain get one of these; any
 *  accidental chain access fails the test loudly. */
export function unusedBlurt(): BlurtClient {
	return new Proxy({} as BlurtClient, {
		get(_, prop) {
			throw new Error(
				`Test BlurtClient method \`${String(prop)}\` was called; ` +
					`handler should not touch the chain in this test`
			);
		}
	});
}

/** A configurable BlurtClient mock for the release handler and
 *  anyone else who does chain reads. */
export function mockBlurt(overrides: Partial<BlurtClient>): BlurtClient {
	return new Proxy({} as BlurtClient, {
		get(_, prop) {
			const key = prop as keyof BlurtClient;
			const fn = overrides[key];
			if (fn) return fn;
			throw new Error(
				`Test BlurtClient method \`${String(prop)}\` was called ` + `but no override was provided`
			);
		}
	});
}

/** Minimal Config for handler tests. Only the release handler
 *  actually reads from config; everyone else ignores it. */
export function fakeConfig(overrides: Partial<Config> = {}): Config {
	return {
		listenHost: '127.0.0.1',
		listenPort: 0,
		publicOrigin: 'http://127.0.0.1:0',
		databaseUrl: 'postgres://test',
		blurtRpcEndpoints: ['https://rpc.example.invalid'],
		chainId: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
		startBlock: 1,
		blockIntervalMs: 3_000,
		errorBackoffMs: 10_000,
		staleLagThreshold: 30,
		allowedOrigins: [],
		maxRequestBodyBytes: 4_096,
		listRatePerMin: 120,
		resourceRatePerMin: 600,
		officialPostingPubkey: 'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
		officialAccountName: 'morphit',
		operatorAccountName: 'morphit',
		feeRecipient: 'morphit-fees',
		// cp370: mock the BLURT base at the CANONICAL on-target value
		// (LISTING_FEE_USD.blurt ÷ reference price = 62.5 BLURT,
		// exported as FEE_FALLBACK.blurtBase) so fee-amount tests anchor
		// to the source of truth rather than a magic constant.  NOTE the
		// deployed config DEFAULT is still 60 (the historical ≈12¢
		// approximation).  cp372 Model A: the /v1/listing-fee DISPLAY
		// now live-tracks the operator's USD-equivalent fee, and the
		// order handler accepts the pinned base ± FEE_PRICE_TOLERANCE
		// (15%); enforcement stays BLURT-native (no price read).
		feeBaseBlurt: FEE_FALLBACK.blurtBase,
		feeTolerance: 0.001,
		// cp372: pinned BTC/XMR fee amounts, anchored to the canonical
		// fallbacks (≈$0.25 at the reference prices) so listing-fee
		// display tests have realistic bases to live-scale.
		btcFeeSatoshis: FEE_FALLBACK.satoshis,
		xmrFeePiconero: FEE_FALLBACK.piconero,
		// Part 121 — empty by default, meaning every canonical
		// registry asset is enabled.  Tests that exercise the
		// instance-wide disable gate override with e.g.
		// `{ disabledAssets: ['USDT'] }`.
		disabledAssets: [],
		disabledPaymentMethods: [],
		priceFeedEnabled: false,
		priceFeedStaticFloor: 0.002,
		// cp128: default to USD for backwards-compatibility with
		// existing tests; tests of non-USD denomination override this.
		priceFeedDenominationFiat: 'USD',
		// cp130: per-asset static-floor defaults (USD-shaped).
		priceFeedBtcStaticFloor: 60_000,
		priceFeedXmrStaticFloor: 200,
		// cp130 factory needs these — sane defaults for tests.
		coingeckoBaseUrl: 'https://api.coingecko.com/api/v3',
		coingeckoApiKey: '',
		// cp372 additional crypto sources + outlier tolerance.
		coinpaprikaBaseUrl: 'https://api.coinpaprika.com/v1',
		krakenBaseUrl: 'https://api.kraken.com/0/public',
		cryptocompareBaseUrl: 'https://min-api.cryptocompare.com',
		binanceBaseUrl: 'https://api.binance.com',
		coinbaseBaseUrl: 'https://api.exchange.coinbase.com',
		okxBaseUrl: 'https://www.okx.com',
		bybitBaseUrl: 'https://api.bybit.com',
		coinloreBaseUrl: 'https://api.coinlore.net',
		coincapBaseUrl: 'https://rest.coincap.io/v3',
		messariBaseUrl: 'https://data.messari.io',
		priceOutlierTolerance: 0.05,
		priceRefreshIntervalMs: 300_000,
		// cp372 FX feed defaults — disabled in tests by default (the
		// FX-aware floor uses ctx.fiatToUsd, which makeCtx stubs).
		fxFeedEnabled: false,
		fxRefreshIntervalMs: 3_600_000,
		fxFetchTimeoutMs: 5_000,
		fxFrankfurterBaseUrl: 'https://api.frankfurter.dev/v1',
		fxErApiBaseUrl: 'https://open.er-api.com/v6',
		fxCurrencyApiBaseUrl: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1',
		// cp127 native fetcher defaults (factory consults when
		// priceFeedNativeEnabled).
		priceFeedNativeEnabled: false,
		priceFeedStablecoinKeys: ['usdt', 'usdc', 'dai'],
		priceFeedNativePlausibleMin: 0.0001,
		priceFeedNativePlausibleMax: 0.1,
		featureFeeBlurtPerHour: 50,
		verboseHealth: false,
		// Part 111: default to 'morphit' so existing tests by default
		// exercise the "served by this instance, queue payouts" path.
		// Tests of the federation-scope gate override this.
		instanceOperatorTag: 'morphit',
		...overrides
	} as Config;
}

/** Build an OpContext with mostly-default fields; caller overrides
 *  only what the test cares about. */
export function makeCtx(overrides: Partial<OpContext> = {}): OpContext {
	return {
		blockNum: 12_345,
		trxInBlock: 0,
		opInTrx: 0,
		blockTime: new Date('2026-04-19T12:00:00Z'),
		trxId: '0000000000000000000000000000000000000000',
		signer: 'alice',
		payload: {},
		siblingOps: [],
		blurt: unusedBlurt(),
		config: fakeConfig(),
		// Empty by default — matches the "operator hasn't configured
		// BTC/XMR" case. Tests that exercise BTC/XMR paths pass
		// concrete verifiers via overrides.
		feeVerifiers: {},
		// Part 106 — empty fee amounts by default.  Tests that
		// exercise BTC/XMR fee verification override with concrete
		// amounts (e.g. { btcSatoshis: 416 } or
		// { xmrPiconero: 781250000n }).  An empty object means
		// "operator hasn't configured this method" and the order
		// handler rejects with `fee_amount_not_configured_<method>`.
		feeAmounts: {},
		// cp372 — FX-aware first-order floor converter.  Default is the
		// identity (treat the amount as its own USD value), which makes
		// existing USD-denominated floor tests behave exactly as before.
		// Tests exercising non-USD conversion override with a concrete
		// rate (e.g. (a, f) => f === 'AUD' ? a / 1.52 : a).
		fiatToUsd: (amount: number) => (Number.isFinite(amount) ? amount : null),
		// Phase E — orderbook event bus.  No-op default; tests that
		// want to assert emission count override with a tracking
		// stub.  Without this default, every handler that calls
		// ctx.recordOrderbookChange (order, orderReplace, orderCancel,
		// feeAttest) crashes the test with "not a function".
		recordOrderbookChange: () => {},
		// Phase E.5 — chat event bus.  Same no-op default as above.
		recordChatChange: () => {},
		...overrides
	};
}
