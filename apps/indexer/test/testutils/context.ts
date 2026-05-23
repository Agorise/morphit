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
		feeBaseBlurt: 60,
		feeTolerance: 0.001,
		// Part 121 — empty by default, meaning every canonical
		// registry asset is enabled.  Tests that exercise the
		// instance-wide disable gate override with e.g.
		// `{ disabledAssets: ['USDT'] }`.
		disabledAssets: [],
		priceFeedEnabled: false,
		priceFeedStaticFloor: 0.002,
		// cp128: default to USD for backwards-compatibility with
		// existing tests; tests of non-USD denomination override this.
		priceFeedDenominationFiat: 'USD',
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
