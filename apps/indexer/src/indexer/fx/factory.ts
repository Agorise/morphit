/**
 * FX-source factory.
 *
 * Builds a CompositeCachedFxSource from operator config — the
 * USD→fiat analogue of price/factory.ts.  Only invoked when
 * `config.fxFeedEnabled === true` (default ON; operator can
 * disable).  When disabled the caller holds a null source and the
 * order floor falls back to its USD-only behaviour.
 *
 * Order:
 *   1. the Haveno / Bisq pricenodes over Tor (their consensus table, each
 *      fiat per USD derived from the fiat-per-BTC quotes;
 *      price/pricenodes.ts) — the primary;
 *   2. only when they give no table, and only where clearnet is allowed:
 *      Frankfurter (ECB) + open.er-api.com + currency-api (jsDelivr),
 *      averaged;
 *   3. the hardcoded static table (inside the composite).
 * A zero-clearnet node has no step 2.
 *
 * Every provider is free and no-key; each refresh pulls the WHOLE table
 * (base=USD) so no provider learns any individual user's currency.
 *
 * The factory returns a started-ready FxRateSource; the caller
 * invokes source.start()/stop() for lifecycle (same contract as
 * the price factory).
 */

import type { Config } from '$config';
import type { FxRateSource } from '$indexer/fx/source';
import { CompositeCachedFxSource } from '$indexer/fx/compositeFxSource';
import { createFrankfurterFetcher } from '$indexer/fx/frankfurterFetcher';
import { createErApiFetcher } from '$indexer/fx/erApiFetcher';
import { createCurrencyApiFetcher } from '$indexer/fx/currencyApiFetcher';
import { pricenodesFor, pricenodeFxFetch, tiePricenodeLifecycle } from '$indexer/price/pricenodes';

/** Build the USD→fiat FX source, or null when the feed is disabled.
 *  Caller is responsible for start()/stop() lifecycle. */
export function createFxRateSource(config: Config): FxRateSource | null {
	if (!config.fxFeedEnabled) return null;

	const timeoutMs = config.fxFetchTimeoutMs;
	const pricenodes = pricenodesFor(config);
	// No clearnet RPC = a zero-clearnet node: no clearnet FX provider at all.
	const clearnetAllowed = config.blurtRpcEndpoints.length > 0;
	const clearnet = [
		{
			name: 'frankfurter',
			fetch: createFrankfurterFetcher({ baseUrl: config.fxFrankfurterBaseUrl, timeoutMs })
		},
		{
			name: 'er_api',
			fetch: createErApiFetcher({ baseUrl: config.fxErApiBaseUrl, timeoutMs })
		},
		{
			name: 'currency_api',
			fetch: createCurrencyApiFetcher({ baseUrl: config.fxCurrencyApiBaseUrl, timeoutMs })
		}
	];

	const source = new CompositeCachedFxSource({
		primaryUpstreams:
			pricenodes !== null ? [{ name: 'pricenodes', fetch: pricenodeFxFetch(pricenodes) }] : [],
		upstreams: clearnetAllowed ? clearnet : [],
		...(pricenodes !== null ? { deferUpstreams: () => pricenodes.awaitingFirstRound() } : {}),
		refreshIntervalMs: config.fxRefreshIntervalMs
	});
	return pricenodes !== null ? tiePricenodeLifecycle(source, pricenodes) : source;
}
