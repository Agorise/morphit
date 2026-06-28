/**
 * Morphit indexer — BLURT/USD price source abstraction.
 *
 * Today the listing-fee formula multiplies a BLURT amount by a
 * BLURT/USD rate. That rate was a static env var
 * (MORPHIT_INDEXER_BLURT_PRICE_USD, default $0.002) which worked
 * during Phase 3–4 when BLURT price was relatively flat, but
 * doesn't track real market moves. Phase 5 replaces the static
 * env var with this pluggable source.
 *
 * DESIGN PRIORITIES (per the backlog design decisions):
 *   1. NEVER throw. A broken price feed must not brick listing-fee
 *      quoting. Fall back all the way to the static $0.002 floor
 *      if every upstream is unreachable.
 *   2. Stable within a block. If two orders land in the same block,
 *      both should be priced with the same BLURT/USD rate. This
 *      means the source caches its latest good value and only
 *      refreshes in the background, not on every call.
 *   3. Operator-overridable. An operator who doesn't want Coingecko
 *      traffic from their VPS can configure their own stack
 *      (static-floor-only) via env vars.
 *   4. No hard dependency on any single provider. Coingecko may
 *      rate-limit or go down; morphit_native and the static floor
 *      are always there.
 *
 * USAGE:
 *   const source = createPriceSource(config);
 *   source.start(); // spawns background refresher
 *   // ... later, in a hot path ...
 *   const price = source.current(); // never throws; returns latest good
 *   // ... on shutdown ...
 *   source.stop();
 */

import type { DriftCheckResult } from '$indexer/price/driftMonitor';

/** One attempt to fetch a live price. Returns a number or `null` if
 *  the upstream couldn't provide a value right now. Must NEVER throw. */
export type PriceFetch = () => Promise<number | null>;

/** The interface consumers (listing-fee formula, quote endpoint)
 *  use. Synchronous current() is deliberate: no consumer should
 *  await a network call in a hot path. */
export interface BlurtPriceSource {
	/** The latest good BLURT/USD value. Never throws. Always
	 *  returns a positive number, falling back to the static
	 *  floor if every upstream has ever been unreachable. */
	current(): number;

	/** Source metadata for observability. `name` identifies which
	 *  upstream produced the current value; `updatedAt` is when it
	 *  was fetched. `stale` is true if we're serving a value older
	 *  than the configured refresh interval (i.e. refresh is
	 *  failing silently). */
	currentDetailed(): {
		price: number;
		source: string;
		updated_at: Date;
		stale: boolean;
	};

	/** Start background refresh. Idempotent. */
	start(): void;

	/** Stop background refresh. Idempotent. */
	stop(): void;

	/** cp233 — Defense B: the most recent drift-check result, or
	 *  null when drift monitoring isn't wired (no db/asset/fiat
	 *  configured) or no refresh has committed yet.  Surfaced on
	 *  /v1/health so an operator can see whether the published
	 *  price has drifted suspiciously far from its moving baseline.
	 *  Optional on the interface because only the composite source
	 *  computes it; other implementations may omit it. */
	driftStatus?(): DriftCheckResult | null;

	/** cp372 — per-external-source health for the morphit-ops
	 *  node-health view: which crypto providers answered, when each
	 *  last succeeded, and their last reading.  Optional — only the
	 *  composite implements it. */
	sourceStatus?(): Array<{
		name: string;
		ok: boolean;
		lastOkAt: Date | null;
		lastTriedAt: Date | null;
		lastValue: number | null;
	}>;

	/** cp372 — true iff the last committed external average dropped
	 *  at least one source as an outlier (provider disagreement).
	 *  Optional — only the composite implements it. */
	outlierRejected?(): boolean;
}
