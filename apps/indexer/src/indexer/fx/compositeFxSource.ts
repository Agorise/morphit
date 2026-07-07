/**
 * Composite cached USD→fiat FX source — multi-source AVERAGING.
 *
 * Each refresh fetches ALL configured upstreams concurrently
 * (Promise.allSettled), then for every currency aggregates the
 * readings from every source that returned a plausible table via
 * the median-anchored robust mean (aggregateRobust): the median
 * anchors, outliers more than FX_OUTLIER_TOLERANCE off it are
 * dropped, and the survivors are averaged.  This damps the price
 * swing that a single off/stale provider would otherwise cause —
 * one bad source is rejected outright rather than dragging the
 * committed rate.
 *
 * Failover is layered behind the averaging:
 *   - ≥1 source up   → averaged table committed
 *   - 0 sources up   → last good averaged table served (stale), or
 *                      the hardcoded static table if none cached
 *   - currency absent from the live table → static-table value
 *
 * Per-source status is tracked so the morphit-ops health view can
 * show, at a glance, which providers are up, when each last
 * answered, and whether sources are disagreeing (outliers rejected).
 *
 * Invariants (unchanged): rate()/usdToFiat()/fiatToUsd() are
 * synchronous and NEVER throw; rate('USD') is always 1; refresh
 * failures are logged, never propagated.  Privacy: each refresh
 * pulls whole tables (base=USD); no per-user query ever leaves the
 * box.
 */

import { logger } from '$log';
import {
	type FxRateSource,
	type FxFetch,
	type FxRateTable,
	isPlausibleFxTable,
	FX_RATE_PLAUSIBLE_MIN,
	FX_RATE_PLAUSIBLE_MAX
} from '$indexer/fx/source';
import { STATIC_FX_TABLE } from '$indexer/fx/staticTable';
import { aggregateRobust } from '$indexer/price/aggregate';

const log = logger('fx');

/** Keep FX readings within ±2% of the median.  Independent FX
 *  providers (all tracking the same interbank market) normally
 *  agree to <0.5%; a reading >2% off is stale/broken and dropped. */
export const FX_OUTLIER_TOLERANCE = 0.02;

export interface CompositeFxSourceConfig {
	readonly upstreams: ReadonlyArray<{ readonly name: string; readonly fetch: FxFetch }>;
	readonly refreshIntervalMs: number;
	readonly staleThresholdMs?: number;
	readonly now?: () => number;
	readonly setInterval?: typeof globalThis.setInterval;
	readonly clearInterval?: typeof globalThis.clearInterval;
}

/** Per-source health, surfaced to the morphit-ops node-health view. */
export interface FxSourceStatus {
	readonly name: string;
	/** Contributed a plausible table in the most recent refresh. */
	readonly ok: boolean;
	/** When this source last returned a plausible table (null = never). */
	readonly lastOkAt: Date | null;
	/** When this source was last attempted (null = never). */
	readonly lastTriedAt: Date | null;
	/** Currencies in its most recent good table. */
	readonly currencyCount: number;
}

interface SourceStat {
	lastOkAt: number | null;
	lastTriedAt: number | null;
	okLastCycle: boolean;
	currencyCount: number;
}

interface CachedTable {
	table: FxRateTable;
	contributingSources: string[];
	updatedAt: number;
	/** Peak inlier count across currencies (≈ how many sources agreed). */
	maxContributors: number;
	/** Any currency had ≥1 source rejected as an outlier this cycle. */
	anyRejected: boolean;
}

export class CompositeCachedFxSource implements FxRateSource {
	private timer: ReturnType<typeof setInterval> | null = null;
	private cached: CachedTable | null = null;
	private readonly now: () => number;
	private readonly setIntervalFn: typeof globalThis.setInterval;
	private readonly clearIntervalFn: typeof globalThis.clearInterval;
	private readonly staleThresholdMs: number;
	private readonly sourceStats: Map<string, SourceStat>;

	constructor(private readonly config: CompositeFxSourceConfig) {
		if (config.refreshIntervalMs <= 0) {
			throw new Error('CompositeCachedFxSource: refreshIntervalMs must be > 0');
		}
		this.now = config.now ?? (() => Date.now());
		this.setIntervalFn = config.setInterval ?? globalThis.setInterval;
		this.clearIntervalFn = config.clearInterval ?? globalThis.clearInterval;
		this.staleThresholdMs = config.staleThresholdMs ?? config.refreshIntervalMs * 3;
		this.sourceStats = new Map(
			config.upstreams.map((u) => [
				u.name,
				{ lastOkAt: null, lastTriedAt: null, okLastCycle: false, currencyCount: 0 }
			])
		);
	}

	private isServeable(v: number): boolean {
		return Number.isFinite(v) && v >= FX_RATE_PLAUSIBLE_MIN && v <= FX_RATE_PLAUSIBLE_MAX;
	}

	rate(fiat: string): number | null {
		const code = fiat.trim().toUpperCase();
		if (code === 'USD') return 1;
		const live = this.cached?.table.rates[code];
		if (typeof live === 'number' && this.isServeable(live)) return live;
		const stat = STATIC_FX_TABLE.rates[code];
		if (typeof stat === 'number' && this.isServeable(stat)) return stat;
		return null;
	}

	usdToFiat(usd: number, fiat: string): number | null {
		if (!Number.isFinite(usd)) return null;
		const r = this.rate(fiat);
		if (r === null) return null;
		const out = usd * r;
		return Number.isFinite(out) ? out : null;
	}

	fiatToUsd(amount: number, fiat: string): number | null {
		if (!Number.isFinite(amount)) return null;
		const r = this.rate(fiat);
		if (r === null || r <= 0) return null;
		const out = amount / r;
		return Number.isFinite(out) ? out : null;
	}

	/** Per-source status for the morphit-ops health view. */
	sourceStatus(): FxSourceStatus[] {
		return this.config.upstreams.map((u) => {
			const s = this.sourceStats.get(u.name)!;
			return {
				name: u.name,
				ok: s.okLastCycle,
				lastOkAt: s.lastOkAt === null ? null : new Date(s.lastOkAt),
				lastTriedAt: s.lastTriedAt === null ? null : new Date(s.lastTriedAt),
				currencyCount: s.currencyCount
			};
		});
	}

	currentDetailed(): {
		rates: Readonly<Record<string, number>>;
		source: string;
		updated_at: Date;
		stale: boolean;
		live_currency_count: number;
		contributing_sources: string[];
		outlier_rejected: boolean;
	} {
		if (!this.cached) {
			return {
				rates: STATIC_FX_TABLE.rates,
				source: 'static_table',
				updated_at: new Date(0),
				stale: true,
				live_currency_count: 0,
				contributing_sources: [],
				outlier_rejected: false
			};
		}
		const ageMs = this.now() - this.cached.updatedAt;
		return {
			rates: this.cached.table.rates,
			source: this.cached.contributingSources.join('+') || 'averaged',
			updated_at: new Date(this.cached.updatedAt),
			stale: ageMs > this.staleThresholdMs,
			live_currency_count: Object.keys(this.cached.table.rates).length,
			contributing_sources: [...this.cached.contributingSources],
			outlier_rejected: this.cached.anyRejected
		};
	}

	start(): void {
		if (this.timer !== null) return;
		void this.refreshOnce();
		this.timer = this.setIntervalFn(() => {
			void this.refreshOnce();
		}, this.config.refreshIntervalMs);
		if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
			(this.timer as { unref: () => void }).unref();
		}
	}

	stop(): void {
		if (this.timer === null) return;
		this.clearIntervalFn(this.timer);
		this.timer = null;
	}

	/** One refresh pass: fetch ALL upstreams concurrently, then
	 *  aggregate per-currency.  Public for deterministic tests. */
	async refreshOnce(): Promise<void> {
		const now = this.now();
		const results = await Promise.allSettled(this.config.upstreams.map((u) => u.fetch()));

		const goodTables: Array<{ name: string; table: FxRateTable }> = [];
		results.forEach((res, i) => {
			const up = this.config.upstreams[i]!;
			const stat = this.sourceStats.get(up.name)!;
			stat.lastTriedAt = now;
			let table: FxRateTable | null = null;
			if (res.status === 'fulfilled') {
				table = res.value;
			} else {
				// FxFetch contract says "never throws"; a buggy impl
				// shouldn't crash the refresher.
				log.warn('upstream_threw', { source: up.name }, res.reason);
			}
			// Capture as boolean (no inline narrowing); the explicit
			// `table !== null` below restores FxRateTable narrowing and
			// keeps the implausible-but-non-null case reachable for logging.
			const plausible = isPlausibleFxTable(table);
			if (plausible && table !== null) {
				stat.lastOkAt = now;
				stat.okLastCycle = true;
				stat.currencyCount = Object.keys(table.rates).length;
				goodTables.push({ name: up.name, table });
			} else {
				stat.okLastCycle = false;
				if (table !== null) {
					log.warn('upstream_implausible_table', { source: up.name });
				}
			}
		});

		if (goodTables.length === 0) {
			if (this.cached) {
				log.warn('all_upstreams_failed_serving_cache', {
					cached_age_ms: now - this.cached.updatedAt
				});
			} else {
				log.warn('all_upstreams_failed_serving_static_table', {
					static_currency_count: Object.keys(STATIC_FX_TABLE.rates).length
				});
			}
			return;
		}

		// Union of all currency codes seen this cycle.
		const codes = new Set<string>();
		for (const g of goodTables) {
			for (const c of Object.keys(g.table.rates)) codes.add(c);
		}

		const rates: Record<string, number> = {};
		let maxContributors = 0;
		let anyRejected = false;
		for (const code of codes) {
			const vals: number[] = [];
			for (const g of goodTables) {
				const v = g.table.rates[code];
				if (typeof v === 'number') vals.push(v);
			}
			const agg = aggregateRobust(vals, FX_OUTLIER_TOLERANCE);
			if (agg && this.isServeable(agg.value)) {
				rates[code] = agg.value;
				maxContributors = Math.max(maxContributors, agg.contributors);
				if (agg.rejected > 0) anyRejected = true;
			}
		}
		rates.USD = 1; // normalize the base identity

		this.cached = {
			table: { base: 'USD', rates },
			contributingSources: goodTables.map((g) => g.name),
			updatedAt: now,
			maxContributors,
			anyRejected
		};
		log.info('refreshed_averaged', {
			sources: goodTables.map((g) => g.name),
			currency_count: Object.keys(rates).length,
			max_contributors: maxContributors,
			any_outlier_rejected: anyRejected
		});
	}
}
