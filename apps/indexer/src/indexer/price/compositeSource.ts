/**
 * Composite cached BLURT/USD price source.
 *
 * Refreshes in the background every `refreshIntervalMs`. Each
 * refresh tries a chain of upstream PriceFetch callables in
 * priority order (e.g. Klingex first, Coingecko second) and
 * commits the first positive number returned as the new current
 * value. If all upstreams fail, the last good value is served
 * with stale=true; if nothing has ever succeeded, the static
 * floor is served.
 *
 * Invariants:
 *   - current() is synchronous and never throws
 *   - current() always returns a positive number
 *   - refresh failures are logged but not propagated
 *   - start() is idempotent and returns immediately (refresh is
 *     async in the background)
 *   - stop() cancels the interval and awaits nothing; any
 *     in-flight refresh completes on its own without updating
 *     state after stop() returns
 */

import { logger } from '$log';
import type { BlurtPriceSource, PriceFetch } from '$indexer/price/source';
import type { Database } from '$db/pool';
import { updateAndCheckDrift, type DriftCheckResult } from '$indexer/price/driftMonitor';

const log = logger('price');

export interface CompositePriceSourceConfig {
	/** Upstream fetchers in priority order. First to return a
	 *  positive number wins the refresh cycle. */
	readonly upstreams: ReadonlyArray<{
		readonly name: string;
		readonly fetch: PriceFetch;
	}>;
	/** Absolute-floor fallback when no upstream has ever succeeded.
	 *  Operator-tunable via MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR
	 *  (default $0.002).  Only used when the optional price feed
	 *  is enabled. */
	readonly staticFloor: number;
	/** How often the background loop attempts a refresh, in ms.
	 *  5 minutes in production; tests pass a small value. */
	readonly refreshIntervalMs: number;
	/** How long a cached value is considered "fresh" before the
	 *  detailed report marks it stale. Defaults to 2×
	 *  refreshIntervalMs — allows one skipped refresh before
	 *  alerting operators. */
	readonly staleThresholdMs?: number;
	/** Clock injection for tests. Defaults to Date.now. */
	readonly now?: () => number;
	/** setInterval injection. Defaults to global setInterval. Tests
	 *  pass a no-op or a manually-driven fake. */
	readonly setInterval?: typeof globalThis.setInterval;
	/** clearInterval injection. */
	readonly clearInterval?: typeof globalThis.clearInterval;
	/** cp233 — Defense B (slow-drift) wiring.  When db, asset, and
	 *  denominationFiat are ALL provided, every successful refresh
	 *  updates the persisted drift baseline (price_drift_baseline)
	 *  via updateAndCheckDrift() and fires a logged + /v1/health-
	 *  surfaced alert on sustained divergence from baseline.  All
	 *  three are optional so tests/smokes can construct the source
	 *  without a database — drift monitoring is simply skipped then,
	 *  and price serving behaves identically. */
	readonly db?: Database;
	/** Asset ticker for the drift baseline row, e.g. 'BLURT'. */
	readonly asset?: string;
	/** Denomination fiat for the drift baseline row, e.g. 'USD'. */
	readonly denominationFiat?: string;
}

/** Plausibility bounds for a BLURT/USD price.  Any upstream
 *  value outside this window is rejected as likely manipulated
 *  or buggy.  The window is wider than BLURT's realistic
 *  trading range (typically $0.001-$0.005) but tight enough to
 *  catch a compromised oracle that would otherwise mislead users
 *  with a wildly-wrong USD echo.
 *
 *  After the §F.11 BLURT-native fee refactor, the price feed is
 *  no longer in the fee-verification critical path — fees are
 *  denominated directly in BLURT.  The bound therefore protects
 *  the OPTIONAL USD display only: if Klingex or Coingecko gets
 *  compromised and starts returning $1.00/BLURT, the bound
 *  rejects the value rather than letting the frontend show
 *  "60 BLURT (~$60.00)" next to listing fees.
 *
 *  $0.10 caps the upward swing at 50× current trading range,
 *  generous enough to absorb a real bull run without rejecting
 *  legitimate prices.
 *
 *  The lower bound rejects zero-tickers from a misconfigured
 *  upstream.  $0.0001 is BLURT's historical floor; below this
 *  the price is almost certainly an empty/zero result rather
 *  than a market signal.
 *
 *  Defense-in-depth: a multi-source quorum (require 2+ upstreams
 *  to agree within ε) would be the next defense upgrade — that's
 *  tracked as a future improvement. */
const PRICE_PLAUSIBLE_MIN_USD = 0.0001;
const PRICE_PLAUSIBLE_MAX_USD = 0.1;

interface CachedEntry {
	price: number;
	source: string;
	updatedAt: number; // ms epoch
}

export class CompositeCachedPriceSource implements BlurtPriceSource {
	private timer: ReturnType<typeof setInterval> | null = null;
	private cached: CachedEntry | null = null;
	/** cp233 — last Defense B drift-check result; null until the
	 *  first successful refresh runs the check (or when drift
	 *  monitoring is unwired). Exposed read-only via driftStatus(). */
	private lastDrift: DriftCheckResult | null = null;
	private readonly now: () => number;
	private readonly setIntervalFn: typeof globalThis.setInterval;
	private readonly clearIntervalFn: typeof globalThis.clearInterval;
	private readonly staleThresholdMs: number;

	constructor(private readonly config: CompositePriceSourceConfig) {
		if (config.staticFloor <= 0) {
			throw new Error(
				`CompositeCachedPriceSource: staticFloor must be > 0, got ${config.staticFloor}`
			);
		}
		if (config.refreshIntervalMs <= 0) {
			throw new Error(`CompositeCachedPriceSource: refreshIntervalMs must be > 0`);
		}
		this.now = config.now ?? (() => Date.now());
		this.setIntervalFn = config.setInterval ?? globalThis.setInterval;
		this.clearIntervalFn = config.clearInterval ?? globalThis.clearInterval;
		this.staleThresholdMs = config.staleThresholdMs ?? config.refreshIntervalMs * 2;
	}

	current(): number {
		return this.cached?.price ?? this.config.staticFloor;
	}

	currentDetailed(): {
		price: number;
		source: string;
		updated_at: Date;
		stale: boolean;
	} {
		if (!this.cached) {
			return {
				price: this.config.staticFloor,
				source: 'static_floor',
				updated_at: new Date(0),
				stale: true
			};
		}
		const ageMs = this.now() - this.cached.updatedAt;
		return {
			price: this.cached.price,
			source: this.cached.source,
			updated_at: new Date(this.cached.updatedAt),
			stale: ageMs > this.staleThresholdMs
		};
	}

	/** cp233 — Defense B: the last drift-check result, or null if
	 *  drift monitoring is unwired (no db/asset/fiat) or no refresh
	 *  has committed yet.  Read by /v1/health for the drift surface. */
	driftStatus(): DriftCheckResult | null {
		return this.lastDrift;
	}

	start(): void {
		if (this.timer !== null) return; // already started
		// Fire one immediate refresh so we don't have to wait a full
		// interval for the first real value. Don't await — start()
		// must be non-blocking.
		void this.refreshOnce();
		this.timer = this.setIntervalFn(() => {
			void this.refreshOnce();
		}, this.config.refreshIntervalMs);
		// Don't let the interval keep the process alive on its own.
		// The indexer has other long-lived concerns (poller, HTTP
		// server) that gate process lifetime.
		if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
			(this.timer as { unref: () => void }).unref();
		}
	}

	stop(): void {
		if (this.timer === null) return;
		this.clearIntervalFn(this.timer);
		this.timer = null;
	}

	/** Attempt one refresh pass. Public for tests that want
	 *  deterministic control; production code relies on start()
	 *  to drive this via the interval. */
	async refreshOnce(): Promise<void> {
		for (const up of this.config.upstreams) {
			let value: number | null;
			try {
				value = await up.fetch();
			} catch (err) {
				// Defense in depth. PriceFetch contract says "never
				// throws" but a buggy implementation shouldn't crash us.
				log.warn('upstream_threw', { source: up.name }, err);
				continue;
			}

			if (value === null) {
				// Upstream couldn't provide a value this round. Try
				// next in chain. Not worth warn-logging — this is an
				// expected "upstream is temporarily unavailable" path.
				continue;
			}

			if (!Number.isFinite(value) || value <= 0) {
				log.warn('upstream_bad_value', { source: up.name, value });
				continue;
			}

			// Sanity clamp.  Outside this window the value is almost
			// certainly wrong (zero-tickers, compromised oracle, etc.)
			// — fall through to the next upstream rather than commit
			// it.  Defends the listing-fee economy against a single
			// upstream pushing a wildly skewed price.
			if (value < PRICE_PLAUSIBLE_MIN_USD || value > PRICE_PLAUSIBLE_MAX_USD) {
				log.warn('upstream_value_out_of_range', {
					source: up.name,
					value,
					min: PRICE_PLAUSIBLE_MIN_USD,
					max: PRICE_PLAUSIBLE_MAX_USD
				});
				continue;
			}

			// Got a good value — commit and done.
			const now = this.now();
			this.cached = { price: value, source: up.name, updatedAt: now };
			log.info('refreshed', { source: up.name, price: value });

			// cp233 — Defense B (slow-drift / "frog in boiling water"):
			// update the persisted drift baseline and check for a
			// sustained divergence from it.  Observational ONLY — the
			// value is already committed above, and a baseline-store
			// failure must never break price serving (invariant: refresh
			// failures are logged, not propagated), so it is fenced in
			// its own try/catch.  Runs only when the operator wired
			// db + asset + denomination (production path); test sources
			// constructed without them skip it.  Reuses `now` so the
			// baseline timestamps honor the same injected clock the rest
			// of the source uses.
			if (this.config.db && this.config.asset && this.config.denominationFiat) {
				try {
					this.lastDrift = await updateAndCheckDrift(
						this.config.db,
						this.config.asset,
						this.config.denominationFiat,
						value,
						{ now: () => new Date(now) }
					);
				} catch (err) {
					log.warn('drift_check_failed', { asset: this.config.asset }, err);
				}
			}
			return;
		}

		// Every upstream failed this round.
		if (this.cached) {
			log.warn('all_upstreams_failed_serving_cache', {
				cached_source: this.cached.source,
				cached_age_ms: this.now() - this.cached.updatedAt
			});
		} else {
			log.warn('all_upstreams_failed_no_cache_serving_floor', {
				floor: this.config.staticFloor
			});
		}
	}
}
