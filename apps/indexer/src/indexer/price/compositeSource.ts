/**
 * Composite cached BLURT/USD price source.
 *
 * Refreshes in the background every `refreshIntervalMs`. Each
 * refresh walks tiers in precedence order: an optional PRIMARY BLEND
 * (several feeds asked together and averaged — for BLURT, Blurt's own
 * `api.blurt.blog/price_info` and Cexius's BLURT/USDT, v1.24.0) wins
 * whenever one of them returns a plausible value; then the optional
 * PRIMARY sources one by one (BTC/XMR: the onion pricenodes); only when
 * those are down/implausible does the refresh fall through to the
 * EXTERNAL aggregator-average, then the native FALLBACK tier, then the
 * static floor. It commits the first
 * plausible value the chain yields. If everything fails, the last good
 * value is served with stale=true; if nothing has ever succeeded, the
 * static floor is served.
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
import { aggregateRobust } from '$indexer/price/aggregate';

const log = logger('price');

export interface CompositePriceSourceConfig {
	/** EXTERNAL market upstreams, fetched ALL-AT-ONCE each refresh and
	 *  combined via the median-anchored robust mean (aggregateRobust):
	 *  the median anchors, sources >`outlierTolerance` off it are
	 *  dropped, and the survivors are averaged.  This damps the swing
	 *  a single off/stale provider would cause.  ≥1 up → averaged
	 *  value committed (source 'external_avg'). */
	readonly upstreams: ReadonlyArray<{
		readonly name: string;
		readonly fetch: PriceFetch;
	}>;
	/** OPTIONAL PRIMARY upstream(s) — tried one by one after the primary
	 *  blend, ahead of the external average.  The first that returns a
	 *  plausible value is committed as the price (source = that upstream's
	 *  own name) and the external aggregators are NOT queried that cycle.
	 *  BTC and XMR: the onion pricenodes; a hidden-only node adds the
	 *  federation after them.  The aggregator-average (`upstreams`) +
	 *  native fallback serve only when every primary is down or
	 *  implausible. */
	readonly primaryUpstreams?: ReadonlyArray<{
		readonly name: string;
		readonly fetch: PriceFetch;
	}>;
	/** OPTIONAL PRIMARY BLEND (v1.24.0) — asked first of all, together.
	 *  The plausible answers are combined like the external tier
	 *  (aggregateRobust: two answers give their midpoint; nothing is flagged
	 *  as an outlier, each source's own price shows on the health view) and
	 *  committed: as source 'primary_avg' when two or more answered, else
	 *  under the one that did.  When none answers, `primaryUpstreams` and
	 *  the rest follow as before.  For BLURT: Blurt's own feed and Cexius's
	 *  BLURT/USDT.
	 *
	 *  (v1.24.0 review) Answers further apart than BLEND_MAX_SPREAD are not
	 *  averaged: the FIRST source in the list that answered is committed
	 *  alone (for BLURT, Blurt's own feed, the primary before Cexius joined).
	 *  A thin market's one odd trade must not move the price by half its
	 *  distance. */
	readonly primaryBlend?: ReadonlyArray<{
		readonly name: string;
		readonly fetch: PriceFetch;
	}>;
	/** FALLBACK upstreams (e.g. morphit_native), tried in order ONLY
	 *  when every external upstream is unavailable this cycle.  Kept
	 *  as a distinct tier — NOT blended into the external average —
	 *  so the disagreement monitor's external-vs-native cross-check
	 *  stays meaningful (native is the thing checked against, and the
	 *  thing served only when externals are all down).  Optional;
	 *  omit for an externals-only source. */
	readonly fallbackUpstreams?: ReadonlyArray<{
		readonly name: string;
		readonly fetch: PriceFetch;
	}>;
	/** When this says true and no primary had a value, the EXTERNAL tier is
	 *  not asked this cycle (the cached / static value stays). The onion
	 *  pricenodes use it while their first round is still out, so a node that
	 *  may use clearnet does not ask the clearnet aggregators at every boot
	 *  just because Tor is slower; once the round lands it refreshes this
	 *  source, and the clearnet tier serves only if that round made no price. */
	readonly deferExternal?: () => boolean;
	/** Relative band for outlier rejection in the external average,
	 *  e.g. 0.05 = keep readings within ±5% of the median.  Crypto
	 *  spreads across exchanges are wider than FX; default 0.05. */
	readonly outlierTolerance?: number;
	/** Per-asset plausibility window.  A committed value outside
	 *  [plausibleMin, plausibleMax] is rejected as garbage.  These
	 *  MUST be asset-appropriate: BLURT ~[0.0001, 0.1], BTC
	 *  ~[1000, 1e7], XMR ~[1, 1e5].  Default to the BLURT window for
	 *  backward compatibility with callers that don't set them. */
	readonly plausibleMin?: number;
	readonly plausibleMax?: number;
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
	/** Defense B (slow-drift) wiring.  When db, asset, and
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
 *  the OPTIONAL USD display only: if Coingecko gets
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

/** Default outlier band for the external average when a source
 *  doesn't set one.  Crypto cross-exchange spreads are wider than
 *  FX, so 5% (vs FX's 2%). */
const CRYPTO_OUTLIER_TOLERANCE_DEFAULT = 0.05;

interface CachedEntry {
	price: number;
	source: string;
	updatedAt: number; // ms epoch
}

/** How far apart the blend's answers may be and still be averaged: the
 *  higher at most this fraction above the lower (see `primaryBlend`). Blurt's
 *  feed and Cexius were 13% apart when Cexius joined (v1.24.0): a normal gap
 *  between two markets, averaged; one odd trade at twice the price is not. */
export const BLEND_MAX_SPREAD = 0.5;

export class CompositeCachedPriceSource implements BlurtPriceSource {
	private timer: ReturnType<typeof setInterval> | null = null;
	private cached: CachedEntry | null = null;
	/** last Defense B drift-check result; null until the
	 *  first successful refresh runs the check (or when drift
	 *  monitoring is unwired). Exposed read-only via driftStatus(). */
	private lastDrift: DriftCheckResult | null = null;
	private readonly now: () => number;
	private readonly setIntervalFn: typeof globalThis.setInterval;
	private readonly clearIntervalFn: typeof globalThis.clearInterval;
	private readonly staleThresholdMs: number;
	private readonly plausibleMin: number;
	private readonly plausibleMax: number;
	private readonly outlierTolerance: number;
	/** Per-external-source health, surfaced to the morphit-ops view. */
	private readonly extStats: Map<
		string,
		{
			lastOkAt: number | null;
			lastTriedAt: number | null;
			okLastCycle: boolean;
			lastValue: number | null;
		}
	>;
	/** Whether the last committed external average dropped any source
	 *  as an outlier (a disagreement signal worth surfacing). */
	private lastOutlierRejected = false;

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
		this.plausibleMin = config.plausibleMin ?? PRICE_PLAUSIBLE_MIN_USD;
		this.plausibleMax = config.plausibleMax ?? PRICE_PLAUSIBLE_MAX_USD;
		this.outlierTolerance = config.outlierTolerance ?? CRYPTO_OUTLIER_TOLERANCE_DEFAULT;
		this.extStats = new Map(
			[...(config.primaryBlend ?? []), ...(config.primaryUpstreams ?? []), ...config.upstreams].map(
				(u) => [u.name, { lastOkAt: null, lastTriedAt: null, okLastCycle: false, lastValue: null }]
			)
		);
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

	/** Defense B: the last drift-check result, or null if
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

	/** One refresh pass.  External upstreams are fetched ALL-AT-ONCE
	 *  and combined via the median-anchored robust mean; if none are
	 *  available this cycle, the fallback tier (native) is tried in
	 *  order; if that also fails, the cached/static value persists.
	 *  Public for tests that want deterministic control. */
	async refreshOnce(): Promise<void> {
		const now = this.now();

		// ── Primary blend: asked together, the plausible answers averaged
		//    (for BLURT, Blurt's own feed and Cexius). ──
		const blend = this.config.primaryBlend ?? [];
		if (blend.length > 0) {
			let answered = await this.askAll(blend, now, 'primary');
			if (answered.length > 1) {
				const lo = Math.min(...answered.map((a) => a.value));
				const hi = Math.max(...answered.map((a) => a.value));
				if (hi > lo * (1 + BLEND_MAX_SPREAD)) {
					log.info('primary_blend_spread', {
						kept: answered[0]!.name,
						values: answered.map((a) => `${a.name}=${a.value}`).join(' ')
					});
					answered = answered.slice(0, 1);
				}
			}
			const agg = aggregateRobust(
				answered.map((a) => a.value),
				this.outlierTolerance
			);
			if (agg !== null && this.plausible(agg.value)) {
				// Not flagged as a provider disagreement: two markets a few
				// percent apart is their normal state (each one's own price is
				// on the health view), and the midpoint drops neither.
				this.lastOutlierRejected = false;
				const source = answered.length === 1 ? answered[0]!.name : 'primary_avg';
				await this.commit(agg.value, source, now);
				log.info('refreshed_primary', {
					source,
					considered: agg.considered,
					rejected: agg.rejected,
					price: agg.value
				});
				return;
			}
		}

		// ── Primary tier: authoritative sources one by one (BTC/XMR: the
		//    onion pricenodes; on a hidden-only node, then the federation).
		//    The first plausible reading wins and the external aggregators
		//    are skipped this cycle; the refresh falls through to the
		//    average only when every primary is down/implausible. ──
		for (const up of this.config.primaryUpstreams ?? []) {
			const stat = this.extStats.get(up.name)!;
			stat.lastTriedAt = now;
			let value: number | null;
			try {
				value = await up.fetch();
			} catch (err) {
				log.warn('primary_threw', { source: up.name }, err);
				stat.okLastCycle = false;
				continue;
			}
			if (
				value !== null &&
				Number.isFinite(value) &&
				value > 0 &&
				value >= this.plausibleMin &&
				value <= this.plausibleMax
			) {
				stat.lastOkAt = now;
				stat.okLastCycle = true;
				stat.lastValue = value;
				this.lastOutlierRejected = false;
				await this.commit(value, up.name, now);
				log.info('refreshed_primary', { source: up.name, price: value });
				return;
			}
			stat.okLastCycle = false;
			if (value !== null) {
				log.warn('primary_bad_or_out_of_range', {
					source: up.name,
					value,
					min: this.plausibleMin,
					max: this.plausibleMax
				});
			}
		}

		// ── External tier: fetch all concurrently, robust-average ──
		if (this.config.upstreams.length > 0 && this.config.deferExternal?.() === true) {
			log.info('external_tier_deferred', { reason: 'primary_pending' });
			return;
		}
		const values = (await this.askAll(this.config.upstreams, now, 'upstream')).map((a) => a.value);

		if (values.length > 0) {
			const agg = aggregateRobust(values, this.outlierTolerance);
			if (
				agg &&
				Number.isFinite(agg.value) &&
				agg.value >= this.plausibleMin &&
				agg.value <= this.plausibleMax
			) {
				this.lastOutlierRejected = agg.rejected > 0;
				await this.commit(agg.value, 'external_avg', now);
				log.info('refreshed_averaged', {
					contributors: agg.contributors,
					considered: agg.considered,
					rejected: agg.rejected,
					price: agg.value
				});
				return;
			}
		}

		// ── Fallback tier (native): sequential, first plausible wins ──
		for (const up of this.config.fallbackUpstreams ?? []) {
			let value: number | null;
			try {
				value = await up.fetch();
			} catch (err) {
				log.warn('fallback_threw', { source: up.name }, err);
				continue;
			}
			if (value === null) continue;
			if (
				!Number.isFinite(value) ||
				value <= 0 ||
				value < this.plausibleMin ||
				value > this.plausibleMax
			) {
				log.warn('fallback_bad_or_out_of_range', { source: up.name, value });
				continue;
			}
			this.lastOutlierRejected = false;
			await this.commit(value, up.name, now);
			log.info('refreshed_fallback', { source: up.name, price: value });
			return;
		}

		// ── Every upstream failed this round ──
		if (this.cached) {
			log.warn('all_upstreams_failed_serving_cache', {
				cached_source: this.cached.source,
				cached_age_ms: now - this.cached.updatedAt
			});
		} else {
			log.warn('all_upstreams_failed_no_cache_serving_floor', {
				floor: this.config.staticFloor
			});
		}
	}

	private plausible(value: number): boolean {
		return (
			Number.isFinite(value) &&
			value > 0 &&
			value >= this.plausibleMin &&
			value <= this.plausibleMax
		);
	}

	/** Ask every source of a tier at once; record each one's health and
	 *  return the plausible answers. Never throws (a PriceFetch should not,
	 *  and one that does is logged and counts as no answer). */
	private async askAll(
		sources: ReadonlyArray<{ readonly name: string; readonly fetch: PriceFetch }>,
		now: number,
		tier: 'primary' | 'upstream'
	): Promise<Array<{ name: string; value: number }>> {
		const results = await Promise.allSettled(sources.map((u) => u.fetch()));
		const out: Array<{ name: string; value: number }> = [];
		results.forEach((res, i) => {
			const up = sources[i]!;
			const stat = this.extStats.get(up.name)!;
			stat.lastTriedAt = now;
			let value: number | null = null;
			if (res.status === 'fulfilled') {
				value = res.value;
			} else {
				// PriceFetch contract says "never throws"; a buggy impl
				// shouldn't crash the refresher.
				log.warn(`${tier}_threw`, { source: up.name }, res.reason);
			}
			if (value !== null && this.plausible(value)) {
				stat.lastOkAt = now;
				stat.okLastCycle = true;
				stat.lastValue = value;
				out.push({ name: up.name, value });
			} else {
				stat.okLastCycle = false;
				if (value !== null) {
					log.warn(`${tier}_bad_or_out_of_range`, {
						source: up.name,
						value,
						min: this.plausibleMin,
						max: this.plausibleMax
					});
				}
			}
		});
		return out;
	}

	/** Commit a value as the new cached price + run the drift check.
	 *  Extracted so the external-average and native-fallback paths
	 *  share identical commit + Defense-B semantics. */
	private async commit(value: number, source: string, now: number): Promise<void> {
		this.cached = { price: value, source, updatedAt: now };

		// Defense B (slow-drift / "frog in boiling water"):
		// update the persisted drift baseline and check for a
		// sustained divergence from it.  Observational ONLY — the
		// value is already committed above, and a baseline-store
		// failure must never break price serving (invariant: refresh
		// failures are logged, not propagated), so it is fenced in
		// its own try/catch.  Runs only when the operator wired
		// db + asset + denomination (production path); test sources
		// constructed without them skip it.  Reuses `now` so the
		// baseline timestamps honor the same injected clock.
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
	}

	/** Per-external-source health for the morphit-ops node-health
	 *  view: which providers answered, when each last succeeded, and
	 *  their last reading. */
	sourceStatus(): Array<{
		name: string;
		ok: boolean;
		lastOkAt: Date | null;
		lastTriedAt: Date | null;
		lastValue: number | null;
	}> {
		return [
			...(this.config.primaryBlend ?? []),
			...(this.config.primaryUpstreams ?? []),
			...this.config.upstreams
		].map((u) => {
			const s = this.extStats.get(u.name)!;
			return {
				name: u.name,
				ok: s.okLastCycle,
				lastOkAt: s.lastOkAt === null ? null : new Date(s.lastOkAt),
				lastTriedAt: s.lastTriedAt === null ? null : new Date(s.lastTriedAt),
				lastValue: s.lastValue
			};
		});
	}

	/** Whether the last committed external average dropped at least
	 *  one source as an outlier (a disagreement signal). */
	outlierRejected(): boolean {
		return this.lastOutlierRejected;
	}
}
