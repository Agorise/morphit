/**
 * FX-source factory.
 *
 * Builds a CompositeCachedFxSource from operator config — the
 * USD→fiat analogue of price/factory.ts.  Only invoked when
 * `config.fxFeedEnabled === true` (default ON; operator can
 * disable).  When disabled the caller holds a null source and the
 * order floor falls back to its USD-only behaviour.
 *
 * Failover chain (the node-hopping-rotator model):
 *   Frankfurter (ECB) → open.er-api.com → currency-api (jsDelivr)
 *   → hardcoded static table (inside the composite).
 *
 * Every provider is free, no-key, and privacy-respecting; each
 * refresh pulls the WHOLE table (base=USD) so no provider learns
 * any individual user's currency.  Adding another provider is a
 * one-line push() here.
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

/** Build the USD→fiat FX source, or null when the feed is disabled.
 *  Caller is responsible for start()/stop() lifecycle. */
export function createFxRateSource(config: Config): FxRateSource | null {
	if (!config.fxFeedEnabled) return null;

	const timeoutMs = config.fxFetchTimeoutMs;
	const upstreams = [
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

	return new CompositeCachedFxSource({
		upstreams,
		refreshIntervalMs: config.fxRefreshIntervalMs
	});
}
