/**
 * Morphit indexer — cross-source disagreement monitor (cp127, defense C).
 *
 * The black-hat scenario this defends against
 * ───────────────────────────────────────────
 * The Coingecko aggregation pipeline gets compromised and starts
 * returning prices with a slow bias.  morphit_native continues to
 * show real on-platform prices.  The composite source's priority
 * order is:
 *
 *   Coingecko > morphit_native > static floor
 *
 * Because external is preferred when available, we'd publish the
 * MANIPULATED Coingecko price even when our own data disagrees.
 *
 * The disagreement monitor detects when morphit_native and any
 * external source diverge materially for a sustained period.  It
 * does NOT auto-switch priority (that creates its own attack vector:
 * manipulate native to FORCE a priority flip).  Instead it makes
 * disagreement loudly visible:
 *
 *   - Logged with WARN severity on every detected divergence
 *   - Surfaced in /v1/health for operator dashboards
 *   - Exposed via /v1/price/morphit-native/receipt for forensic review
 *
 * Operators who trust their on-platform data more than external
 * feeds (likely once Morphit has substantial volume) can OPT IN to
 * priority-flip behavior via the env var
 * MORPHIT_INDEXER_PRICE_PREFER_NATIVE_WHEN_DISAGREEING.  Default:
 * false — external sources remain primary.
 *
 * Detection logic
 * ───────────────
 * Compare current morphit_native price against the price the
 * composite source actually committed (which is from the highest-
 * priority working upstream).  If they differ by more than the
 * threshold (default 25%), the disagreement is active.  Sustained
 * for 4+ hours = alert.  The 4-hour delay filters transient flickers
 * from genuine sustained divergence.
 *
 * No new database table needed; state is in-process.  On restart,
 * disagreement timer resets to zero (the disagreement, if real, will
 * be re-detected within hours).  This is an acceptable tradeoff:
 * persisting state for one purely advisory signal adds complexity
 * disproportionate to the marginal benefit.
 */

import { logger } from '$log';
import type { BlurtPriceSource, PriceFetch } from '$indexer/price/source';

const log = logger('price/disagree');

export const DISAGREEMENT_THRESHOLD = 0.25; // 25% divergence = disagreement
export const DISAGREEMENT_ALERT_SUSTAINED_HOURS = 4;

export interface DisagreementMonitorState {
	disagreementSince: Date | null;
	lastAlertFired: Date | null;
}

export interface DisagreementCheckInput {
	readonly externalPrice: number | null; // null if no external source available
	readonly externalSourceName: string | null;
	readonly nativePrice: number | null; // null if morphit_native couldn't derive
	readonly now: Date;
}

export interface DisagreementCheckResult {
	readonly active: boolean;
	readonly external_price: number | null;
	readonly external_source: string | null;
	readonly native_price: number | null;
	readonly deviation: number | null;
	readonly sustained_hours: number;
	readonly alert_fired: boolean;
}

/**
 * Stateful monitor.  Hold one instance per (asset, fiat) pair in
 * memory (typically just one for BLURT/USD in cp127).
 *
 * Pure-method-with-state pattern: the monitor's only state is the
 * "disagreement-since" timestamp.  All other inputs come from each
 * call's parameters.
 */
export class DisagreementMonitor {
	private state: DisagreementMonitorState = {
		disagreementSince: null,
		lastAlertFired: null
	};
	/** cp233 — last check result, retained for the /v1/health
	 *  disagreement surface (symmetric with B's drift surface).
	 *  null until the first check() runs. */
	private lastResult: DisagreementCheckResult | null = null;

	constructor(
		private readonly asset: string,
		private readonly denominationFiat: string,
		private readonly threshold: number = DISAGREEMENT_THRESHOLD,
		private readonly sustainedHours: number = DISAGREEMENT_ALERT_SUSTAINED_HOURS
	) {}

	/**
	 * Returns current state without mutating.  Useful for receipts
	 * + health endpoints.
	 */
	currentState(): DisagreementMonitorState {
		return {
			disagreementSince: this.state.disagreementSince,
			lastAlertFired: this.state.lastAlertFired
		};
	}

	/** cp233 — the most recent check result, or null before the
	 *  first check.  Read by /v1/health to show the live
	 *  external-vs-native deviation + alert state. */
	lastCheck(): DisagreementCheckResult | null {
		return this.lastResult;
	}

	/**
	 * Run one check; mutate state.  Returns the result for caller
	 * inspection.
	 *
	 * When external or native is null, no comparison is possible —
	 * the monitor returns inactive without alarming.  Disagreement
	 * requires BOTH sources to have produced values.
	 */
	check(input: DisagreementCheckInput): DisagreementCheckResult {
		const { externalPrice, nativePrice, now, externalSourceName } = input;

		if (
			externalPrice === null ||
			nativePrice === null ||
			externalPrice <= 0 ||
			nativePrice <= 0
		) {
			// Can't compare; not a disagreement either way.
			this.state.disagreementSince = null;
			this.lastResult = {
				active: false,
				external_price: externalPrice,
				external_source: externalSourceName,
				native_price: nativePrice,
				deviation: null,
				sustained_hours: 0,
				alert_fired: false
			};
			return this.lastResult;
		}

		const deviation = (nativePrice - externalPrice) / externalPrice;
		const active = Math.abs(deviation) > this.threshold;

		let alertFired = false;
		let sustainedHoursActual = 0;

		if (active) {
			if (this.state.disagreementSince === null) {
				this.state.disagreementSince = now;
			} else {
				const elapsedMs = now.getTime() - this.state.disagreementSince.getTime();
				sustainedHoursActual = elapsedMs / 3_600_000;
				if (sustainedHoursActual >= this.sustainedHours) {
					// Rate-limit alerts: only fire once per 24h per
					// (asset, fiat) pair, even if disagreement persists.
					// Spam-prevention.
					const lastAlert = this.state.lastAlertFired;
					const hoursSinceLastAlert =
						lastAlert === null
							? Infinity
							: (now.getTime() - lastAlert.getTime()) / 3_600_000;
					if (hoursSinceLastAlert >= 24) {
						alertFired = true;
						this.state.lastAlertFired = now;
						log.warn('price_source_disagreement', {
							asset: this.asset,
							denomination_fiat: this.denominationFiat,
							external_source: externalSourceName,
							external_price: externalPrice,
							native_price: nativePrice,
							deviation,
							sustained_hours: sustainedHoursActual,
							threshold: this.threshold
						});
					}
				}
			}
		} else {
			this.state.disagreementSince = null;
		}

		this.lastResult = {
			active,
			external_price: externalPrice,
			external_source: externalSourceName,
			native_price: nativePrice,
			deviation,
			sustained_hours: sustainedHoursActual,
			alert_fired: alertFired
		};
		return this.lastResult;
	}
}

/** Source names that count as a real EXTERNAL market reference for
 *  the disagreement comparison.  The composite's published price is
 *  reused as the external side (no extra outbound fetch) — but only
 *  when it actually came from one of these.  When the composite is
 *  serving the morphit_native fallback or the static floor, there is
 *  no external reference to compare against, so the cycle passes
 *  externalPrice=null and the monitor stays inactive.  This is what
 *  prevents a false "disagreement" alarm from comparing the native
 *  price against the tiny static floor while external sources are
 *  briefly unreachable. */
const EXTERNAL_MARKET_SOURCES: ReadonlySet<string> = new Set(['coingecko', 'external_avg']);

/** Run config for the cp233 disagreement-monitor loop.  Mirrors the
 *  shape of the peer-price monitor's config (defense F) so the two
 *  read alike at the main.ts wiring site. */
export interface DisagreementRunConfig {
	readonly monitor: DisagreementMonitor;
	/** Derives the morphit_native price for the asset.  Called every
	 *  cycle — native is the cross-check, and (unlike the external
	 *  price) it is NOT otherwise computed each refresh, because the
	 *  composite only reaches its native upstream when the external
	 *  ones fail.  PriceFetch never throws by contract; the cycle
	 *  fences it anyway. */
	readonly nativeFetch: PriceFetch;
	/** Live composite price source for the asset.  Supplies the
	 *  external side from its currently-published value (see
	 *  EXTERNAL_MARKET_SOURCES). */
	readonly priceSource: BlurtPriceSource;
	/** Clock injection for tests. Defaults to Date. */
	readonly now?: () => Date;
	/** setInterval/clearInterval injection for tests. */
	readonly setInterval?: typeof globalThis.setInterval;
	readonly clearInterval?: typeof globalThis.clearInterval;
}

/** Run one disagreement check cycle: take the external side from the
 *  composite's published price (only if it's a real external market
 *  source), derive the native side, and feed both to the monitor.
 *  Returns the result for testability / structural verification.
 *  Never throws (a monitor must never crash the indexer). */
export async function runDisagreementCheckCycle(
	cfg: DisagreementRunConfig,
	nowOverride?: Date
): Promise<DisagreementCheckResult> {
	const now = nowOverride ?? (cfg.now ? cfg.now() : new Date());

	// External side — reuse the composite's published value, but only
	// when it came from a real external market source.  Otherwise no
	// external reference exists this cycle (→ inactive, no false alarm).
	const detailed = cfg.priceSource.currentDetailed();
	const isExternal = EXTERNAL_MARKET_SOURCES.has(detailed.source);
	const externalPrice = isExternal ? detailed.price : null;
	const externalSourceName = isExternal ? detailed.source : null;

	// Native side — derived fresh each cycle.  Fenced even though
	// PriceFetch promises not to throw.
	let nativePrice: number | null = null;
	try {
		nativePrice = await cfg.nativeFetch();
	} catch (err) {
		log.warn('disagreement_native_fetch_failed', { err: String(err) });
	}

	return cfg.monitor.check({ externalPrice, externalSourceName, nativePrice, now });
}

/** Start the cp233 disagreement monitor.  Schedules a recurring
 *  check at `intervalMs` (main.ts passes the price-refresh interval,
 *  so the cross-check runs at the same cadence prices refresh).
 *  Returns a stop function for graceful shutdown.  Mirrors
 *  startPeerPriceMonitor (defense F). */
export function startDisagreementMonitor(
	cfg: DisagreementRunConfig,
	intervalMs: number
): () => void {
	const setIntervalFn = cfg.setInterval ?? globalThis.setInterval;
	const clearIntervalFn = cfg.clearInterval ?? globalThis.clearInterval;
	let running = true;

	async function tick(): Promise<void> {
		if (!running) return;
		try {
			await runDisagreementCheckCycle(cfg);
		} catch (err) {
			log.error('disagreement_check_cycle_failed', { err: String(err) });
		}
	}

	// Fire-and-forget initial cycle, then schedule recurring.
	void tick();
	const handle = setIntervalFn(() => void tick(), intervalMs);

	return (): void => {
		running = false;
		clearIntervalFn(handle);
	};
}
