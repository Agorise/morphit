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
import { FEE_PRICE_TOLERANCE, LISTING_FEE_USD } from '@morphit/asset-registry';

/**
 * ONE sample per peer OPERATOR: the latest fresh
 * morphit_native observation of each operator account in the federation
 * directory. What was wrong: the median ran over every observation ROW, so a
 * peer sampled twice (or one operator publishing several origins) weighed
 * double, and rows from origins no longer in the directory still counted.
 * Shared by this fetcher and peerPriceMonitor's disagreement median.
 * Params: $1 asset, $2 denomination_fiat, $3 window start (timestamptz).
 */
export const PER_OPERATOR_LATEST_PRICE_SQL = `
	SELECT DISTINCT ON (ki.operator_account) ppo.observed_price::TEXT AS observed_price
	  FROM price_peer_observations ppo
	  JOIN known_instances ki ON ki.origin = ppo.peer_origin
	 WHERE ppo.asset = $1
	   AND ppo.denomination_fiat = $2
	   AND ppo.source_native = 'morphit_native'
	   AND ppo.observed_at >= $3
	 ORDER BY ki.operator_account, ppo.observed_at DESC`;

/**
 * Clamp a federated price to the chain-pinned price
 * ± FEE_PRICE_TOLERANCE. Per-operator aggregation alone cannot stop K+1 free
 * operator registrations from outvoting K honest peers, so the federated
 * number may never leave the band the chain-pinned fee amount already
 * implies: the order handler enforces the pinned fee base minus
 * FEE_PRICE_TOLERANCE, so a price inside ± that band always yields a quote the
 * indexer accepts (1/(1+T) > 1−T) and never more than ~1/(1−T) of the pin.
 * `pinned` null/invalid (no pin, non-USD) → unclamped. PURE.
 */
export function clampToPinned(price: number | null, pinned: number | null): number | null {
	if (price === null) return null;
	if (pinned === null || !Number.isFinite(pinned) || pinned <= 0) return price;
	const lo = pinned * (1 - FEE_PRICE_TOLERANCE);
	const hi = pinned * (1 + FEE_PRICE_TOLERANCE);
	return Math.min(hi, Math.max(lo, price));
}

/**
 * The USD price per whole coin that a chain-pinned
 * fee amount implies (the canonical USD fee target ÷ the pinned amount).
 * BLURT: base in BLURT; BTC: satoshis; XMR: piconero (string). null when the
 * asset has no pinned fee amount. PURE.
 */
export function pinnedFeeImpliedUsdPrice(
	asset: string,
	pin: { blurtBase?: number | null; btcSatoshis?: number | null; xmrPiconero?: string | null }
): number | null {
	const a = asset.toUpperCase();
	if (a === 'BLURT' && pin.blurtBase && pin.blurtBase > 0) return LISTING_FEE_USD.blurt / pin.blurtBase;
	if (a === 'BTC' && pin.btcSatoshis && pin.btcSatoshis > 0) return LISTING_FEE_USD.btc / (pin.btcSatoshis / 1e8);
	if (a === 'XMR' && pin.xmrPiconero) {
		const pico = Number(pin.xmrPiconero);
		if (Number.isFinite(pico) && pico > 0) return LISTING_FEE_USD.xmr / (pico / 1e12);
	}
	return null;
}

/** Manipulation-resistant median: needs at least `minCount` positive samples,
 *  else null (caller falls back to the static floor). PURE. */
export function federatedMedian(prices: readonly number[], minCount: number): number | null {
	const clean = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
	if (clean.length < minCount) return null;
	const mid = Math.floor(clean.length / 2);
	return clean.length % 2 === 1 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2;
}

/**
 * What the federated fetcher saw on its latest run, per asset: how many fresh
 * per-operator peer samples it had and whether that made a median. The
 * clearnet gate's `priceFederated` leg reads it (federatedPriceIsLive), so the
 * claim "this node prices from the federation" holds only while it actually
 * does — not merely because the node is hidden-only.
 */
interface FederatedRun {
	readonly at: number;
	readonly peerSamples: number;
	readonly median: boolean;
}
const latestRuns = new Map<string, FederatedRun>();

/** A run older than this no longer counts (the refresher stopped, or the
 *  operator set a refresh interval longer than this). */
export const FEDERATED_RUN_MAX_AGE_MS = 60 * 60_000;

/** True when the federated fetcher for `asset` ran within
 *  FEDERATED_RUN_MAX_AGE_MS and produced a median from fresh peer samples. */
export function federatedPriceIsLive(asset = 'BLURT', now: number = Date.now()): boolean {
	const r = latestRuns.get(asset.toUpperCase());
	return r !== undefined && now - r.at <= FEDERATED_RUN_MAX_AGE_MS && r.median && r.peerSamples > 0;
}

/** Tests only. */
export function _resetFederatedRuns(): void {
	latestRuns.clear();
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
	/** The price the chain-pinned fee amount implies
	 *  (USD only). The median is clamped to it ± FEE_PRICE_TOLERANCE. Absent or
	 *  null → unclamped. */
	readonly pinnedPrice?: () => Promise<number | null>;
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
				// one latest sample per operator account.
				const res = await deps.db.query<{ observed_price: string }>(
				PER_OPERATOR_LATEST_PRICE_SQL,
				[deps.asset, deps.denominationFiat, new Date(Date.now() - deps.freshnessMinutes * 60_000)]
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
		const med = federatedMedian(samples, deps.minObservations);
		latestRuns.set(deps.asset.toUpperCase(), {
			at: Date.now(),
			peerSamples: peers.length,
			median: med !== null
		});
		// bound it by the chain pin.
		const pinned = deps.pinnedPrice ? await deps.pinnedPrice().catch(() => null) : null;
		return clampToPinned(med, pinned);
	};
}
