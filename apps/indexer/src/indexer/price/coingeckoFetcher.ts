/**
 * Coingecko BLURT/USD price fetcher.
 *
 * Secondary upstream, after Klingex. Free tier exists but is
 * aggressively rate-limited (~10-30 req/min); paid API is
 * ~$129/mo. For a single indexer refreshing every 5 minutes,
 * the free tier is comfortable (12 req/hour per instance).
 *
 * Endpoint: GET /api/v3/simple/price?ids=blurt&vs_currencies=usd
 * Response: { "blurt": { "usd": 0.00237 } }
 *
 * The free tier works without an API key. Paid tier uses header
 * `x-cg-pro-api-key: <key>` and a different base URL
 * (pro-api.coingecko.com). Configurable via the `apiKey` +
 * `baseUrl` options.
 *
 * ⚠ DATA QUALITY NOTE (2026-05): With ProBit defunct, BLURT
 * trades primarily on Klingex (BLURT/USDT).  Coingecko
 * aggregates whatever exchanges it sees BLURT on; the resulting
 * BLURT/USD figure is occasionally stale (CG sometimes reports
 * "no trade in last 24h").  Klingex remains Morphit's primary
 * upstream for fresher data; Coingecko is kept as fallback for
 * Klingex-only outages, but operators should expect occasional
 * staleness.
 *
 * Contract matches KlingexFetcher: never throws; returns a
 * positive number or null.
 */

import { logger } from '$log';

const log = logger('price-coingecko');

export interface CoingeckoConfig {
	/** Base URL. Default: https://api.coingecko.com/api/v3
	 *  (free tier). For paid tier, set to
	 *  https://pro-api.coingecko.com/api/v3 and provide apiKey. */
	readonly baseUrl: string;
	/** Optional pro API key. If set, it's sent as x-cg-pro-api-key.
	 *  If absent, the request uses the free tier's no-auth path. */
	readonly apiKey?: string;
	/** Coingecko's internal id for BLURT. Default 'blurt'. Kept
	 *  configurable so an operator can try alternate ids without
	 *  a code change if CG renames. */
	readonly coinId: string;
	/** Request timeout in ms. */
	readonly timeoutMs: number;
	/** fetch injection for tests. */
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createCoingeckoFetcher(config: CoingeckoConfig): () => Promise<number | null> {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const url = `${config.baseUrl.replace(/\/+$/, '')}/simple/price?ids=${encodeURIComponent(config.coinId)}&vs_currencies=usd`;

	return async function fetchCoingecko(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const headers: Record<string, string> = { accept: 'application/json' };
			if (config.apiKey) {
				headers['x-cg-pro-api-key'] = config.apiKey;
			}
			const res = await fetchImpl(url, {
				method: 'GET',
				headers,
				signal: ac.signal
			});
			if (res.status === 429) {
				// Rate-limited. Log at warn level so operators see it
				// if it becomes frequent; falls through to next
				// upstream in the composite chain via null return.
				log.warn('rate_limited', { url });
				return null;
			}
			if (!res.ok) {
				log.warn('http_not_ok', { url, status: res.status });
				return null;
			}
			const body = (await res.json()) as unknown;
			const price = extractPrice(body, config.coinId);
			if (price === null) {
				log.warn('unexpected_shape', { url, coin_id: config.coinId });
				return null;
			}
			return price;
		} catch (err) {
			log.warn('fetch_error', { url }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Shape: { "blurt": { "usd": 0.00237 } }. */
function extractPrice(body: unknown, coinId: string): number | null {
	if (typeof body !== 'object' || body === null) return null;
	const obj = body as Record<string, unknown>;
	const inner = obj[coinId];
	if (typeof inner !== 'object' || inner === null) return null;
	const usd = (inner as Record<string, unknown>).usd;
	if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
	return usd;
}
