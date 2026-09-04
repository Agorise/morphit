/**
 * federatedPriceFetcher — the hidden-only PRIMARY price source (v1.15.x stage 2).
 *
 * A hidden-only node can't (and, post stage-1, won't — fail-closed) fetch a
 * clearnet price API. Instead it prices from the FEDERATION: the median of
 *   { every recent peer's morphit_native price, this node's own native price }
 * where the peer prices are the ones `peerPriceMonitor` already samples into
 * `price_peer_observations` over Tor/I2P. No new network path — this reads what
 * the monitor already collected.
 *
 * Manipulation resistance is the same as the peer monitor's: MEDIAN (an
 * attacker must control > half the observations to move it) + a floor on the
 * observation count (below it, return null → the composite falls to the static
 * floor rather than trust a thin, movable sample). Freshness-bounded so a dead
 * peer's stale number ages out.
 *
 * NOTE: this consumes peers' morphit_native price. Per ADR-0039 that price is
 * "not an oracle" for a SINGLE instance — the defence here is aggregation: a
 * federation-wide median of independently-derived, moderation-filtered,
 * per-trader-median prices is far harder to move than any one instance's.
 */
import type { Database } from '$db/pool';
import type { PriceFetch } from '$indexer/price/source';

/** Manipulation-resistant median: needs at least `minCount` positive samples,
 *  else null (caller falls back to the static floor). PURE. */
export function federatedMedian(prices: readonly number[], minCount: number): number | null {
	const clean = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
	if (clean.length < minCount) return null;
	const mid = Math.floor(clean.length / 2);
	return clean.length % 2 === 1 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2;
}

export interface FederatedFetcherDeps {
	readonly db: Database | undefined;
	readonly asset: string;
	readonly denominationFiat: string;
	/** This node's own morphit_native fetch (adds one more independent sample). */
	readonly ownNative: PriceFetch | null;
	/** Only observations newer than this count toward the median. */
	readonly freshnessMinutes: number;
	/** Minimum total samples (peers + self) before a median is trusted. */
	readonly minObservations: number;
}

/**
 * Build the hidden-only federated PriceFetch. Reads recent peer morphit_native
 * observations from `price_peer_observations` (sampled by peerPriceMonitor over
 * Tor/I2P), adds this node's own native price, and returns the median — or null
 * when too few samples exist (→ static floor).
 */
export function createFederatedFetcher(deps: FederatedFetcherDeps): PriceFetch {
	return async (): Promise<number | null> => {
		let peers: number[] = [];
		try {
			if (deps.db) {
				const res = await deps.db.query<{ observed_price: string }>(
				`SELECT observed_price
				   FROM price_peer_observations
				  WHERE asset = $1
				    AND denomination_fiat = $2
				    AND source_native = 'morphit_native'
				    AND observed_at >= now() - make_interval(mins => $3)`,
				[deps.asset, deps.denominationFiat, deps.freshnessMinutes]
			);
				peers = res.rows.map((r) => Number(r.observed_price)).filter((p) => Number.isFinite(p) && p > 0);
			}
		} catch {
			peers = [];
		}
		const samples = [...peers];
		if (deps.ownNative) {
			const own = await deps.ownNative().catch(() => null);
			if (own !== null && Number.isFinite(own) && own > 0) samples.push(own);
		}
		return federatedMedian(samples, deps.minObservations);
	};
}
