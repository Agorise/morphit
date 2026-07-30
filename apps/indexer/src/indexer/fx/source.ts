/**
 * Morphit indexer — USD→fiat FX rate source abstraction.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The first-trade minimum is "$1 USD-equivalent" of BLURT, and
 * grandma enters her order amounts in HER local fiat (AUD, EUR,
 * MXN, …), not USD.  To check "is her entered minimum at least
 * $1 worth?" — and to seed the Min-value field with a sensible
 * default in her currency — the system needs to know how much of
 * her fiat equals $1 USD.  That's a USD→fiat exchange rate.
 *
 * The BLURT/BTC/XMR price sources (price/) answer "crypto→fiat".
 * This answers "USD→fiat" (fiat↔fiat).  Different data, same
 * hardened, never-throws, cached, multi-source-with-failover
 * shape — deliberately modelled on BlurtPriceSource so the two
 * subsystems read identically.
 *
 * DESIGN PRIORITIES (mirror the price source, plus privacy):
 *   1. NEVER throw.  A broken FX feed must not brick order
 *      posting.  Fall back all the way to a hardcoded static
 *      table if every upstream is unreachable.
 *   2. Privacy #1 — the fetch is GENERIC.  The indexer pulls the
 *      WHOLE USD→fiat table in one request (base=USD); it never
 *      queries a specific currency on a user's behalf, so no
 *      provider ever learns which fiat any individual user picked.
 *      All FX traffic is server-side from the operator's box; the
 *      browser never calls an FX API.
 *   3. Stable + cached.  current rates are cached and refreshed in
 *      the background (FX moves slowly — hourly is ample); rate()
 *      is synchronous and never awaits a network call.
 *   4. Deep failover — like the RPC node-hopping rotator: a chain
 *      of independent providers (no key, privacy-respecting) tried
 *      in order, then the static table.  No single provider is a
 *      hard dependency.
 *   5. Operator-overridable / opt-out via env, but ON by default.
 *
 * USAGE:
 *   const fx = createFxRateSource(config);
 *   fx.start();                 // spawns background refresher
 *   const audPerUsd = fx.rate('AUD');   // never throws; null if unknown fiat
 *   fx.stop();
 */

/** Units of each fiat per 1 USD, e.g. { EUR: 0.92, AUD: 1.52, … }.
 *  USD itself is 1.0 (and may be omitted by a provider — callers
 *  treat a missing/identity USD as 1.0). */
export interface FxRateTable {
	/** Always 'USD' for this subsystem. */
	readonly base: 'USD';
	/** fiatCode (UPPERCASE) → units of that fiat per 1 USD. */
	readonly rates: Readonly<Record<string, number>>;
}

/** One attempt to fetch the live USD→fiat table.  Returns a table
 *  or `null` if the upstream couldn't provide one right now.  Must
 *  NEVER throw (a buggy impl is also caught by the composite). */
export type FxFetch = () => Promise<FxRateTable | null>;

/** The interface consumers (order floor, /v1 fx endpoint) use.
 *  Synchronous rate() is deliberate: no consumer should await a
 *  network call to validate a form field or an order. */
export interface FxRateSource {
	/** Units of `fiat` (case-insensitive) per 1 USD.  Returns 1.0
	 *  for USD.  Returns null when the fiat isn't in the current
	 *  table AND isn't in the static fallback table (genuinely
	 *  unknown currency).  Never throws. */
	rate(fiat: string): number | null;

	/** Convert a USD amount into `fiat`.  Convenience wrapper over
	 *  rate(); returns null for an unknown fiat.  Never throws. */
	usdToFiat(usd: number, fiat: string): number | null;

	/** Convert a `fiat` amount into USD — the floor's hot path
	 *  ("is this entered minimum ≥ $1?").  Returns null for an
	 *  unknown fiat.  Never throws. */
	fiatToUsd(amount: number, fiat: string): number | null;

	/** Observability snapshot.  `source` names the upstream that
	 *  produced the live table ('static_table' when no upstream
	 *  has ever succeeded); `stale` is true when serving a table
	 *  older than the staleness threshold (refresh failing). */
	currentDetailed(): {
		rates: Readonly<Record<string, number>>;
		source: string;
		updated_at: Date;
		stale: boolean;
		/** How many fiats the live table covers (0 = serving static). */
		live_currency_count: number;
		/** Names of the upstreams that contributed to the current
		 *  averaged table (empty when serving the static table). */
		contributing_sources: string[];
		/** True iff ≥1 source was dropped as an outlier this cycle —
		 *  a provider-disagreement signal for the node-health view. */
		outlier_rejected: boolean;
	};

	/** Per-source health for the morphit-ops node-health view.
	 *  Optional — only the composite implements it. */
	sourceStatus?(): Array<{
		name: string;
		ok: boolean;
		lastOkAt: Date | null;
		lastTriedAt: Date | null;
		currencyCount: number;
	}>;

	/** Start background refresh. Idempotent, non-blocking. */
	start(): void;

	/** Stop background refresh. Idempotent. */
	stop(): void;
}

/** Plausibility bounds for a single USD→fiat rate.  Any rate
 *  outside this window is treated as a bad/garbage value and the
 *  whole table is rejected in favour of the next upstream.
 *
 *  Lower bound 1e-4: the strongest fiats sit near ~0.3 (KWD),
 *  ~0.38 (BHD); 1e-4 is far below any real currency and catches
 *  zero/near-zero garbage.
 *  Upper bound 1e7: hyperinflated currencies (IRR ~42k, some
 *  historical units in the millions) stay inside; 1e7 still
 *  rejects nonsense like Infinity-adjacent values. */
export const FX_RATE_PLAUSIBLE_MIN = 1e-4;
export const FX_RATE_PLAUSIBLE_MAX = 1e7;

/** A live table is only accepted if it has at least this many
 *  currencies AND passes the anchor sanity check below.  Real
 *  providers return 30–160 currencies; a table with a handful of
 *  entries is almost certainly a malformed/partial response. */
export const FX_MIN_TABLE_CURRENCIES = 10;

/** Anchor sanity: a genuine USD-based table has EUR within this
 *  window (EUR has traded ~0.8–1.0 per USD for two decades; the
 *  window is generous).  Used to reject a table that is secretly
 *  based on the wrong currency (e.g. an EUR-based table mislabelled
 *  USD would show EUR≈1.0 — still inside — but GBP/JPY would be
 *  wrong; EUR is the cheap first-line check, the composite also
 *  range-checks every served rate). */
export const FX_ANCHOR_EUR_MIN = 0.5;
export const FX_ANCHOR_EUR_MAX = 2.0;

/** True if a fetched table is structurally + numerically plausible
 *  enough to commit.  Shared by the composite and the fetchers'
 *  tests so the bar is defined in exactly one place. */
export function isPlausibleFxTable(table: FxRateTable | null): table is FxRateTable {
	if (!table || table.base !== 'USD' || typeof table.rates !== 'object' || table.rates === null) {
		return false;
	}
	const entries = Object.entries(table.rates);
	if (entries.length < FX_MIN_TABLE_CURRENCIES) return false;
	// Every present rate must be a finite positive number in range.
	for (const [code, value] of entries) {
		if (typeof code !== 'string' || code.length < 2) return false;
		if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false;
		if (value < FX_RATE_PLAUSIBLE_MIN || value > FX_RATE_PLAUSIBLE_MAX) return false;
	}
	// Anchor check: EUR must be present and sane.  Every real
	// USD-base provider includes EUR; its absence or an absurd
	// value is a strong "this table is wrong" signal.
	const eur = table.rates.EUR;
	if (typeof eur !== 'number' || eur < FX_ANCHOR_EUR_MIN || eur > FX_ANCHOR_EUR_MAX) {
		return false;
	}
	return true;
}
