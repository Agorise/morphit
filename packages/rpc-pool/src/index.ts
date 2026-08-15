/**
 * @morphit/rpc-pool — latency-aware RPC endpoint pool.
 *
 * Lifted at cp165 from the rotation/cooldown logic duplicated in
 * apps/indexer/src/blurt/client.ts and apps/relay/src/blurt/client.ts,
 * extended with two production-grade ingredients those clients
 * lacked:
 *
 *   1. EWMA latency tracking per endpoint.  The historical "last
 *      observed latency" sort used in the frontend was fragile —
 *      a single transient spike dropped a normally-fast endpoint to
 *      the back of the queue.  Exponential weighted moving average
 *      (alpha=0.25) smooths transients while still tracking real
 *      degradation within ~5–10 calls.
 *
 *   2. Adaptive request hedging.  When the historically-fastest
 *      endpoint's EWMA exceeds a degradation threshold, optionally
 *      fire the same request at the SECOND-best endpoint after a
 *      small stagger (default 150 ms or the fastest endpoint's
 *      P50, whichever is larger), and return whichever response
 *      arrives first.  The loser is cancelled via AbortController.
 *
 *      Hedging is opt-in per-call — callers pass `{ hedge: true }`
 *      to opt in.  Background workers (poller, drainer) leave it
 *      off so they don't double-load public Blurt RPC nodes.
 *      User-facing handlers (availability check, signup
 *      getAccount, chain-fee quote) turn it on.
 *
 * Behaviour matrix:
 *
 *   call type              ordering           hedging
 *   ─────────────────────  ──────────────────  ─────────────────────
 *   poller getBlock        fastest-first      OFF (background)
 *   poller getDGP          fastest-first      OFF (background)
 *   relay broadcast        fastest-first      OFF (don't double-send)
 *   relay availability     fastest-first      ON  (user typing name)
 *   relay signup getAcct   fastest-first      ON  (user waits)
 *   indexer chain-fee      fastest-first      ON  (user posts order)
 *
 * Failure semantics unchanged from the previous round-robin
 * clients: exponential cooldown ladder on transport failure, last-
 * ditch retry-all-ignoring-cooldowns, application-level RPC errors
 * thrown to the caller without rotating.
 */

/** Per-endpoint health + latency state. */
export interface EndpointState {
	readonly url: string;
	/** Exponential weighted moving average of successful-call latency
	 *  in milliseconds.  `null` when no successful call has been
	 *  observed yet (new endpoint or just-recovered from cooldown). */
	ewmaLatencyMs: number | null;
	/** Count of CONSECUTIVE transport failures since the last
	 *  success.  Drives the cooldown ladder.  Reset to 0 on success. */
	consecutiveFailures: number;
	/** Unix-ms timestamp before which this endpoint is in cooldown
	 *  and will be skipped by the primary pass.  0 = available. */
	cooldownUntil: number;
	/** Unix-ms timestamp of the most recent successful response,
	 *  or 0 if never.  Diagnostic only — exposed via `snapshot()`
	 *  for operator health views. */
	lastSuccessAt: number;
	/** cp474 — Unix-ms timestamp before which the next request to this
	 *  endpoint must not be dispatched, enforcing the per-endpoint RPS
	 *  ceiling.  Each in-flight caller RESERVES its slot by advancing this
	 *  cursor synchronously before it awaits, so N concurrent callers pace
	 *  into a queue rather than all reading the same "now" and firing
	 *  together.  0 = no request paced yet. */
	nextAllowedAt: number;
}

/** Cooldown ladder in milliseconds.  Same shape the two existing
 *  clients used; promoted here as the single source of truth. */
export const DEFAULT_COOLDOWN_LADDER_MS: readonly number[] = [
	2_000,
	10_000,
	60_000,
	300_000
] as const;

/** Cooldown ladder for endpoints that returned HTTP 429 (rate
 *  limited).  A 429 is a per-window quota signal, not a momentary
 *  blip — re-probing 2 s later (the generic ladder's first step)
 *  just burns another request and earns another 429.  So park a
 *  rate-limited endpoint much longer on the FIRST hit (30 s) and
 *  escalate from there.  This does NOT add user-facing latency: the
 *  pool serves traffic from the OTHER endpoints while one is parked
 *  (this is why >=3 endpoints matters), and what it removes is the
 *  stream of repeated 429 round-trips that was the actual problem. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_LADDER_MS: readonly number[] = [
	30_000,
	60_000,
	120_000,
	300_000
] as const;

/** cp474 — Jitter fraction applied to every cooldown ladder step.
 *  0.25 means an endpoint's cooldown lands uniformly in
 *  [0.75×step, 1.25×step].
 *
 *  WHY: the ladder steps are fixed constants, so without jitter every
 *  Morphit instance that hit the same node at roughly the same moment
 *  re-probes it at roughly the same moment — and Morphit is FEDERATED, so
 *  "every instance" is the normal case, not a hypothetical.  A node that
 *  rate-limits N instances hands them all the same 30 s ladder step and
 *  therefore gets all N back simultaneously 30 s later, re-triggering the
 *  limit and re-synchronising the herd.  Jitter is what breaks that lockstep,
 *  and it's the fourth of the four things the rpc.blurt.blog operator asked
 *  us for (lower RPS, batch, exponential backoff, add jitter).
 *
 *  Applied to BOTH ladders: the generic one matters for a node that
 *  restarts (every client sees the same transport failure at the same
 *  instant), and the 429 one matters for exactly the case above.
 *
 *  This is spread, not delay: the mean cooldown is unchanged, so nothing
 *  gets slower on average and the pool keeps serving from other endpoints
 *  while one is parked. */
export const DEFAULT_COOLDOWN_JITTER_FRACTION = 0.25;

/** cp474 — Default per-endpoint request ceiling, in requests per second.
 *
 *  This is the rpc.blurt.blog operator's FIRST ask ("lower the RPS or
 *  introduce a delay between requests"), and the pool is the only place
 *  that can honour it for every caller at once.
 *
 *  WHY IT WAS NEEDED: steady-state Morphit is nowhere near this — the
 *  poller asks for the global properties plus a block roughly once per
 *  `blockIntervalMs`, well under 1 req/s.  But the poller's CATCH-UP loop
 *  (`for (n = from; n <= irreversible; n++) await getBlock(n)`) is a tight
 *  unthrottled loop: after any downtime it fires `get_block` back-to-back
 *  as fast as the node will answer, against a SINGLE endpoint (the pool
 *  sends traffic to the fastest healthy endpoint, it does not round-robin).
 *  That burst is indistinguishable from abuse from the node's side, and
 *  it's the shape that earns an HTTP 429.
 *
 *  WHY 10: steady-state is <1 req/s, so this is a no-op for normal
 *  operation and costs nothing on the fast-notification path.  It bounds a
 *  catch-up to 10 blocks/s — still ~30× faster than Blurt produces them
 *  (one per 3 s), so a node that fell a full day behind (~28.8k blocks)
 *  still recovers in under an hour, while never presenting a burst a
 *  volunteer node operator would notice.
 *
 *  Set to 0 to disable pacing entirely. */
export const DEFAULT_MAX_REQUESTS_PER_SECOND = 10;

/** EWMA smoothing factor.  0.25 means a single observation moves
 *  the average ~25% of the way toward it — fast enough to react to
 *  degradation within a handful of calls, slow enough to ignore
 *  one-off spikes. */
export const DEFAULT_EWMA_ALPHA = 0.25;

/** Latency above which we consider the fastest endpoint "degraded"
 *  and worth hedging against.  500 ms is a generous floor for a
 *  Blurt RPC node — healthy ones typically respond in 50–200 ms. */
export const DEFAULT_HEDGE_THRESHOLD_MS = 500;

/** Minimum hedge stagger.  If the primary's EWMA-P50 is faster
 *  than this, we still wait this long before firing the hedge so
 *  the fast happy-path doesn't double-spend a request. */
export const DEFAULT_HEDGE_STAGGER_FLOOR_MS = 150;

/** Per-call timeout for user-facing calls.  Lower than the
 *  background indexer's 10s — when a user is waiting, sitting on a
 *  single slow endpoint for 10s is unacceptable. */
export const DEFAULT_USER_FACING_TIMEOUT_MS = 4_000;

/** Per-call timeout for background calls (poller, drainer).
 *  Matches the previous BlurtClient's 10s — these have no
 *  user-perceived latency budget. */
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 10_000;

/** Heuristic — is this error a transport failure (worth rotating
 *  off + cooling down) or an application-level error from the
 *  upstream RPC (pass through to caller, keep endpoint warm)?
 *  Match the same substrings both pre-existing clients used. */
export function isTransportError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const m = err.message.toLowerCase();
	if (m.includes('fetch failed')) return true;
	if (m.includes('timeout')) return true;
	if (m.includes('econnrefused')) return true;
	if (m.includes('econnreset')) return true;
	if (m.includes('enotfound')) return true;
	if (m.includes('etimedout')) return true;
	if (m.includes('socket hang up')) return true;
	if (m.includes('network')) return true;
	if (m.includes('aborted')) return true;
	// beta5 item E: HTTP statuses that mean "this endpoint is rate-
	// limited / overloaded / having a server-side moment right now" —
	// treat them like a transport failure so the pool ROTATES to another
	// endpoint and applies the cooldown ladder (backoff). This is the
	// fix for the firefight's relay 429/502: previously these surfaced
	// as application errors, so the pool propagated them WITHOUT trying
	// another endpoint. @beblurt/dblurt formats them as
	// `HTTP <status>: <statusText>` (utils.js). We deliberately do NOT
	// match 4xx CLIENT errors (400/401/403/404 etc.) — those would fail
	// identically on every endpoint, so rotating is pointless and would
	// just mask the real cause. The matched set is the standard
	// retryable list (408, 429, 500, 502, 503, 504) PLUS the 520-527
	// family (cp328). These are non-standard 5xx codes that an UPSTREAM
	// edge/proxy sitting in front of a Blurt RPC node returns when it
	// can't get a valid response from that node's origin — e.g. 521
	// "origin down", 522/524 timeout, 523 "unreachable". For us they
	// describe an unreachable upstream endpoint, i.e. a transport
	// failure → rotate off it. (These come from whatever proxy a given
	// Blurt node operator runs upstream; Morphit's own stack is
	// BunkerWeb with no CDN.) Without this the pool gave up on the
	// first 521 instead of hopping to a healthy node — the relay's ACT
	// auto-mint surfaced `HTTP 521: <none>` and minted 0.
	if (/\bhttp (?:408|429|500|502|503|504|52[0-7])\b/.test(m)) return true;
	return false;
}

/** Heuristic — did this endpoint reject us specifically for RATE
 *  LIMITING (HTTP 429 / "too many requests")?  A subset of
 *  isTransportError(): every rate-limit error is also worth rotating
 *  off, but it additionally warrants a LONGER cooldown than a generic
 *  blip so the pool stops re-probing a quota'd node every couple of
 *  seconds.  @beblurt/dblurt formats HTTP errors as
 *  `HTTP <status>: <statusText>`. */
export function isRateLimitError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const m = err.message.toLowerCase();
	if (/\bhttp 429\b/.test(m)) return true;
	if (m.includes('too many requests')) return true;
	if (m.includes('rate limit')) return true;
	return false;
}

/** Options for constructing an EndpointPool. */
export interface EndpointPoolOptions {
	readonly endpoints: readonly string[];
	/** Override the default cooldown ladder.  Length determines max
	 *  ladder depth; consecutive failures beyond the length stay at
	 *  the deepest cooldown. */
	readonly cooldownLadderMs?: readonly number[];
	/** Override the cooldown ladder used specifically for HTTP-429
	 *  (rate-limit) failures.  Defaults to
	 *  DEFAULT_RATE_LIMIT_COOLDOWN_LADDER_MS — longer than the generic
	 *  ladder so a quota'd endpoint is parked, not re-probed every
	 *  couple of seconds. */
	readonly rateLimitCooldownLadderMs?: readonly number[];
	/** cp474 — override the jitter fraction applied to cooldown ladder steps.
	 *  Must be in [0, 1).  0 disables jitter (deterministic cooldowns — only
	 *  appropriate in tests that assert exact timings). */
	readonly cooldownJitterFraction?: number;
	/** cp474 — per-endpoint request ceiling in requests/second.  Defaults to
	 *  DEFAULT_MAX_REQUESTS_PER_SECOND.  0 disables pacing.  This is a
	 *  per-ENDPOINT cap, not a pool-wide one: the pool's aggregate ceiling is
	 *  this times the number of healthy endpoints. */
	readonly maxRequestsPerSecond?: number;
	/** cp474 — injectable RNG, for tests that need deterministic jitter.
	 *  Defaults to Math.random.  Jitter is a thundering-herd defence, not a
	 *  secret, so Math.random is the right tool: no crypto entropy needed. */
	readonly random?: () => number;
	/** Override the EWMA smoothing factor.  Must be in (0, 1]. */
	readonly ewmaAlpha?: number;
	/** Latency above which a hedge is fired when hedging is enabled
	 *  for a call.  Below this, no hedge — the primary is fast
	 *  enough. */
	readonly hedgeThresholdMs?: number;
	/** Minimum stagger between primary and hedge dispatch. */
	readonly hedgeStaggerFloorMs?: number;
}

/** Options for a single call. */
export interface CallOptions {
	/** Per-call timeout.  Defaults to DEFAULT_USER_FACING_TIMEOUT_MS
	 *  when `hedge: true`, DEFAULT_BACKGROUND_TIMEOUT_MS otherwise. */
	readonly timeoutMs?: number;
	/** When true, hedge against the second-best endpoint if the
	 *  primary's EWMA is above the pool's degradation threshold.
	 *  Background callers should leave this false. */
	readonly hedge?: boolean;
	/** Rotate the fastest-first PRIMARY order by this many positions before
	 *  trying endpoints.  Default 0 = unchanged (fastest-first).  Used by the
	 *  indexer's concurrent backfill so that N windows fired at once each START
	 *  on a DIFFERENT endpoint (spreading load across all nodes instead of
	 *  dogpiling the single fastest), while STILL falling back through every
	 *  endpoint on failure + recording health exactly as a normal call does.
	 *  Ignored (no-op) for single- or zero-endpoint pools. */
	readonly startOffset?: number;
}

/**
 * Latency-aware endpoint pool.  Generic over the return type of a
 * caller-supplied `call(url, signal)` function — keeping the pool
 * RPC-protocol-agnostic so both the Blurt JSON-RPC clients and
 * future explorer/HTTP fanouts can reuse it.
 *
 * The pool tracks health per endpoint and does NOT itself know how
 * to talk JSON-RPC, HTTP, or anything else.  Callers pass a `call`
 * function; the pool decides which URL to call first, optionally
 * fires a hedge, and tracks success/failure/latency.
 */
export class EndpointPool {
	private readonly endpoints: EndpointState[];
	private readonly cooldownLadder: readonly number[];
	private readonly rateLimitLadder: readonly number[];
	private readonly jitterFraction: number;
	private readonly random: () => number;
	private readonly minRequestIntervalMs: number;
	private readonly alpha: number;
	private readonly hedgeThresholdMs: number;
	private readonly hedgeStaggerFloorMs: number;

	constructor(options: EndpointPoolOptions) {
		if (options.endpoints.length === 0) {
			throw new Error('EndpointPool: at least one endpoint required');
		}
		this.endpoints = options.endpoints.map((url) => ({
			url,
			ewmaLatencyMs: null,
			consecutiveFailures: 0,
			cooldownUntil: 0,
			lastSuccessAt: 0,
			nextAllowedAt: 0
		}));
		this.cooldownLadder = options.cooldownLadderMs ?? DEFAULT_COOLDOWN_LADDER_MS;
		if (this.cooldownLadder.length === 0) {
			throw new Error('EndpointPool: cooldown ladder must be non-empty');
		}
		this.rateLimitLadder =
			options.rateLimitCooldownLadderMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_LADDER_MS;
		this.jitterFraction = options.cooldownJitterFraction ?? DEFAULT_COOLDOWN_JITTER_FRACTION;
		if (this.jitterFraction < 0 || this.jitterFraction >= 1) {
			throw new Error('EndpointPool: cooldownJitterFraction must be in [0, 1)');
		}
		this.random = options.random ?? Math.random;
		const rps = options.maxRequestsPerSecond ?? DEFAULT_MAX_REQUESTS_PER_SECOND;
		if (rps < 0) {
			throw new Error('EndpointPool: maxRequestsPerSecond must be >= 0 (0 disables pacing)');
		}
		// Store the derived spacing, not the rate: it's what every dispatch needs,
		// and computing it once keeps the hot path free of a division.
		this.minRequestIntervalMs = rps === 0 ? 0 : 1_000 / rps;
		if (this.rateLimitLadder.length === 0) {
			throw new Error('EndpointPool: rate-limit cooldown ladder must be non-empty');
		}
		const alpha = options.ewmaAlpha ?? DEFAULT_EWMA_ALPHA;
		if (!(alpha > 0 && alpha <= 1)) {
			throw new Error('EndpointPool: ewmaAlpha must be in (0, 1]');
		}
		this.alpha = alpha;
		this.hedgeThresholdMs = options.hedgeThresholdMs ?? DEFAULT_HEDGE_THRESHOLD_MS;
		this.hedgeStaggerFloorMs =
			options.hedgeStaggerFloorMs ?? DEFAULT_HEDGE_STAGGER_FLOOR_MS;
	}

	/** Add endpoints to the pool at runtime (idempotent — a URL already present
	 *  is skipped, so existing health/latency state is preserved). Returns the
	 *  URLs that were newly added. Used to self-populate from the on-chain RPC
	 *  directory (`morphit_rpc_v1`) without a restart. */
	mergeEndpoints(urls: readonly string[]): string[] {
		const have = new Set(this.endpoints.map((ep) => ep.url));
		const added: string[] = [];
		for (const url of urls) {
			if (have.has(url)) continue;
			have.add(url);
			added.push(url);
			this.endpoints.push({
				url,
				ewmaLatencyMs: null,
				consecutiveFailures: 0,
				cooldownUntil: 0,
				lastSuccessAt: 0,
				nextAllowedAt: 0
			});
		}
		return added;
	}

	/** Read-only snapshot of every endpoint's health.  Returned by
	 *  value (callers can serialize for diagnostics; mutations don't
	 *  affect the pool). */
	snapshot(): readonly EndpointState[] {
		return this.endpoints.map((ep) => ({ ...ep }));
	}

	/** Execute a call against the pool.  Tries endpoints in
	 *  fastest-known-first order (by EWMA latency), skipping
	 *  cooled-down endpoints on the primary pass; does a last-ditch
	 *  pass over every endpoint ignoring cooldowns so the caller
	 *  gets a fresh error rather than a stale one if everything is
	 *  simultaneously cooling.
	 *
	 *  When `hedge: true` and the primary's EWMA is above the
	 *  degradation threshold, dispatches a parallel call to the
	 *  second-best endpoint after the stagger interval.  Returns
	 *  whichever response arrives first; aborts the loser.
	 *
	 *  Each per-endpoint attempt is wrapped in an AbortController +
	 *  timeoutMs so a hung node can't pin the call beyond its
	 *  budget.
	 *
	 *  Transport errors trigger rotation + cooldown.  Application-
	 *  level errors (the upstream returned an RPC error) propagate
	 *  to the caller and DO NOT rotate.
	 */
	async call<T>(
		fn: (url: string, signal: AbortSignal) => Promise<T>,
		options: CallOptions = {}
	): Promise<T> {
		const hedge = options.hedge === true;
		const timeoutMs =
			options.timeoutMs ??
			(hedge ? DEFAULT_USER_FACING_TIMEOUT_MS : DEFAULT_BACKGROUND_TIMEOUT_MS);

		// First-pass order: healthy endpoints, fastest EWMA first.
		const eligible = this.eligibleOrder();
		// Rotate the primary order by startOffset so concurrent backfill windows
		// each start on a different endpoint (spread, no dogpile).  0 = unchanged.
		// The rotation touches ONLY the primary pass order; the last-ditch pass,
		// health recording, and hedge logic are all identical.
		const primaryOrder =
			eligible.length > 1 && (options.startOffset ?? 0) % eligible.length !== 0
				? (() => {
						const off = ((options.startOffset ?? 0) % eligible.length + eligible.length) % eligible.length;
						return [...eligible.slice(off), ...eligible.slice(0, off)];
					})()
				: eligible;
		// Track which endpoints we've TRIED in this call so the
		// last-ditch pass doesn't re-attempt them (which would re-
		// fail, double-record the failure on the cooldown ladder,
		// and double the user-visible wait).  The previous round-
		// robin clients had this latent double-failure bug; the
		// rpc-pool smoke caught it on the single-endpoint case
		// where the same endpoint was attempted on both passes.
		const triedUrls = new Set<string>();
		let lastError: unknown = null;

		for (let i = 0; i < primaryOrder.length; i++) {
			const ep = primaryOrder[i]!;
			triedUrls.add(ep.url);
			const next = primaryOrder[i + 1];
			try {
				const result = await this.attempt(ep, next, fn, timeoutMs, hedge);
				return result;
			} catch (err) {
				if (isTransportError(err)) {
					// recordFailure was called inside attempt()
					lastError = err;
					continue;
				}
				// Application-level RPC error — keep endpoint warm,
				// propagate to caller.
				throw err;
			}
		}

		// Last-ditch: cooled-down endpoints we SKIPPED on the
		// primary pass, in fastest-known order.  Endpoints we
		// already tried in this call are excluded — re-trying them
		// would just hit the same error path twice.
		const lastDitchOrder = this.allOrderedByLatency().filter(
			(ep) => !triedUrls.has(ep.url)
		);
		for (let i = 0; i < lastDitchOrder.length; i++) {
			const ep = lastDitchOrder[i]!;
			try {
				const result = await this.attemptSingle(ep, fn, timeoutMs);
				return result;
			} catch (err) {
				if (isTransportError(err)) {
					lastError = err;
					continue;
				}
				throw err;
			}
		}

		throw new Error(
			`all RPC endpoints unavailable: ${
				lastError instanceof Error ? lastError.message : String(lastError)
			}`
		);
	}

	/** One attempt at a specific endpoint, optionally hedged against
	 *  `hedgeAgainst` if hedging is enabled + primary is degraded. */
	private async attempt<T>(
		primary: EndpointState,
		hedgeAgainst: EndpointState | undefined,
		fn: (url: string, signal: AbortSignal) => Promise<T>,
		timeoutMs: number,
		hedge: boolean
	): Promise<T> {
		const primaryEwma = primary.ewmaLatencyMs;
		const shouldHedge =
			hedge &&
			hedgeAgainst !== undefined &&
			primaryEwma !== null &&
			primaryEwma > this.hedgeThresholdMs;

		if (!shouldHedge) {
			return this.attemptSingle(primary, fn, timeoutMs);
		}

		// Hedged path: fire primary, schedule hedge after stagger,
		// return whichever finishes first.
		const stagger = Math.max(
			this.hedgeStaggerFloorMs,
			primaryEwma ?? this.hedgeStaggerFloorMs
		);

		const primaryCtl = new AbortController();
		const hedgeCtl = new AbortController();
		const timeoutCtl = new AbortController();
		const timeoutHandle = setTimeout(() => timeoutCtl.abort(), timeoutMs);

		const linkSignal = (parent: AbortSignal, child: AbortController) => {
			if (parent.aborted) {
				child.abort();
				return;
			}
			parent.addEventListener('abort', () => child.abort(), { once: true });
		};
		linkSignal(timeoutCtl.signal, primaryCtl);
		linkSignal(timeoutCtl.signal, hedgeCtl);

		const wrappedFn = async (
			ep: EndpointState,
			ctl: AbortController
		): Promise<{ ep: EndpointState; result: T }> => {
			const startedAt = Date.now();
			try {
				const result = await fn(ep.url, ctl.signal);
				const latency = Date.now() - startedAt;
				this.recordSuccess(ep, latency);
				return { ep, result };
			} catch (err) {
				if (isTransportError(err)) {
					this.recordFailure(ep, isRateLimitError(err));
				}
				throw err;
			}
		};

		const primaryPromise = wrappedFn(primary, primaryCtl);

		let hedgeStarted = false;
		const hedgePromise = new Promise<{ ep: EndpointState; result: T }>(
			(resolve, reject) => {
				const handle = setTimeout(() => {
					hedgeStarted = true;
					wrappedFn(hedgeAgainst, hedgeCtl).then(resolve, reject);
				}, stagger);
				// If the timeout signal fires before we even dispatch the
				// hedge, cancel the dispatch.
				timeoutCtl.signal.addEventListener(
					'abort',
					() => {
						clearTimeout(handle);
						if (!hedgeStarted) {
							reject(new Error('timeout (hedge not dispatched)'));
						}
					},
					{ once: true }
				);
			}
		);

		try {
			const winner = await Promise.any([primaryPromise, hedgePromise]);
			// Cancel the loser.
			if (winner.ep.url === primary.url) {
				hedgeCtl.abort();
			} else {
				primaryCtl.abort();
			}
			return winner.result;
		} catch (err) {
			// Promise.any throws AggregateError when ALL inputs reject.
			// In that case, both primary and hedge failed.  Bubble up
			// the first error so the caller sees a single message.
			if (err instanceof AggregateError && err.errors.length > 0) {
				throw err.errors[0];
			}
			throw err;
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	/** cp474 — hold the caller until this endpoint's RPS budget allows the
	 *  next dispatch, and reserve that slot.
	 *
	 *  The reservation is the important part.  Reading `now`, sleeping, and
	 *  THEN advancing the cursor would let N concurrent callers all observe the
	 *  same free slot and fire together — the exact burst this exists to stop.
	 *  Instead each caller advances `nextAllowedAt` SYNCHRONOUSLY (before any
	 *  await), so callers form an orderly queue: the k-th concurrent caller
	 *  waits k×interval.
	 *
	 *  The wait is NOT counted as latency: EWMA is measured around `fn` in
	 *  attemptSingle, so pacing can't make an endpoint look slow and demote
	 *  itself out of the rotation.
	 *
	 *  The abort signal is honoured while waiting — a paced-but-not-yet-fired
	 *  request must still cancel on timeout rather than sit in the queue. */
	private async pace(ep: EndpointState, signal: AbortSignal): Promise<void> {
		if (this.minRequestIntervalMs === 0) return;
		const now = Date.now();
		const slot = Math.max(now, ep.nextAllowedAt);
		ep.nextAllowedAt = slot + this.minRequestIntervalMs;
		const waitMs = slot - now;
		if (waitMs <= 0) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal.removeEventListener('abort', onAbort);
				resolve();
			}, waitMs);
			const onAbort = (): void => {
				clearTimeout(timer);
				reject(new Error('paced request aborted before dispatch'));
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private async attemptSingle<T>(
		ep: EndpointState,
		fn: (url: string, signal: AbortSignal) => Promise<T>,
		timeoutMs: number
	): Promise<T> {
		const ctl = new AbortController();
		const handle = setTimeout(() => ctl.abort(), timeoutMs);
		try {
			await this.pace(ep, ctl.signal);
			// Start the latency clock AFTER pacing — see pace()'s note on EWMA.
			const startedAt = Date.now();
			try {
				const result = await fn(ep.url, ctl.signal);
				const latency = Date.now() - startedAt;
				this.recordSuccess(ep, latency);
				return result;
			} catch (err) {
				if (isTransportError(err)) {
					this.recordFailure(ep, isRateLimitError(err));
				}
				throw err;
			}
		} finally {
			clearTimeout(handle);
		}
	}

	/** Healthy (out of cooldown) endpoints in fastest-EWMA order. */
	private eligibleOrder(): EndpointState[] {
		const now = Date.now();
		const healthy = this.endpoints.filter((ep) => ep.cooldownUntil <= now);
		return this.sortByLatency(healthy);
	}

	/** Every endpoint in fastest-EWMA order, ignoring cooldown. */
	private allOrderedByLatency(): EndpointState[] {
		return this.sortByLatency([...this.endpoints]);
	}

	/** Stable sort: bootstrap unknown-EWMA endpoints first so every
	 *  endpoint earns a real latency measurement; then sort known
	 *  endpoints by EWMA ascending (fastest first).
	 *
	 *  cp165 design note: an earlier version sorted unknown-EWMA to
	 *  INFINITY (i.e. last), which meant a brand-new endpoint never
	 *  got picked while another endpoint stayed healthy.  In
	 *  production the indexer's poller exercised every endpoint
	 *  implicitly because it loops constantly, but in test setups
	 *  and on services with sparse RPC calls (e.g. ops-cli, the
	 *  relay's signup-time call) the first endpoint declared would
	 *  carry 100% of traffic until it failed.  Bootstrapping
	 *  unknowns first is a strict improvement: each endpoint gets
	 *  one measurement, then fastest-EWMA-first kicks in. */
	private sortByLatency(eps: EndpointState[]): EndpointState[] {
		return eps.sort((a, b) => {
			// Both unknown → preserve declaration order (stable).
			if (a.ewmaLatencyMs === null && b.ewmaLatencyMs === null) return 0;
			// One unknown → unknown wins (bootstrap it).
			if (a.ewmaLatencyMs === null) return -1;
			if (b.ewmaLatencyMs === null) return 1;
			// Both known → fastest EWMA first.
			return a.ewmaLatencyMs - b.ewmaLatencyMs;
		});
	}

	private recordSuccess(ep: EndpointState, latencyMs: number): void {
		ep.consecutiveFailures = 0;
		ep.cooldownUntil = 0;
		ep.lastSuccessAt = Date.now();
		if (ep.ewmaLatencyMs === null) {
			ep.ewmaLatencyMs = latencyMs;
		} else {
			ep.ewmaLatencyMs = this.alpha * latencyMs + (1 - this.alpha) * ep.ewmaLatencyMs;
		}
	}

	private recordFailure(ep: EndpointState, rateLimited = false): void {
		ep.consecutiveFailures++;
		// A 429 parks the endpoint on the longer rate-limit ladder; any
		// other transport failure uses the generic ladder.  Both are
		// indexed by the shared consecutive-failure count.
		const ladder = rateLimited ? this.rateLimitLadder : this.cooldownLadder;
		const idx = Math.min(ep.consecutiveFailures - 1, ladder.length - 1);
		ep.cooldownUntil = Date.now() + this.jitter(ladder[idx]!);
		// Wipe EWMA on failure so a recovered endpoint must re-prove
		// its latency before climbing back to the front.  Otherwise
		// a once-fast endpoint that has since become slow would stay
		// preferred until 4+ slow successes drag the EWMA up.
		ep.ewmaLatencyMs = null;
	}

	/** cp474 — spread a ladder step uniformly over
	 *  [(1-f)×step, (1+f)×step] so federated instances that were
	 *  rate-limited together don't come back together.  Mean is unchanged;
	 *  the result is clamped at 0 for safety and rounded to whole ms so
	 *  `cooldownUntil` stays an integer timestamp. */
	private jitter(stepMs: number): number {
		if (this.jitterFraction === 0) return stepMs;
		const spread = stepMs * this.jitterFraction;
		// random() ∈ [0,1) → offset ∈ [-spread, +spread)
		const offset = (this.random() * 2 - 1) * spread;
		return Math.max(0, Math.round(stepMs + offset));
	}

	/**
	 * Quorum-with-early-return call across multiple endpoints.
	 *
	 * Used for cross-source verification where the trust model
	 * requires N endpoints to AGREE before accepting an answer
	 * (the BTC and XMR fee verifiers — multiple block explorers
	 * must agree on a payment's existence and shape before the
	 * indexer marks a release verified).
	 *
	 * Pattern: fires to all healthy endpoints in parallel (latency-
	 * ordered so the fastest dispatches microseconds earlier),
	 * groups successful responses by an equivalence-key function the
	 * caller provides, and returns the moment any group reaches
	 * `minAgree` responses.  Slow / down endpoints don't gate
	 * completion — the call returns as soon as quorum is met
	 * regardless of how many endpoints haven't responded yet.
	 *
	 * Response classification by the `fn`:
	 *   - return T          → success; contributes to quorum
	 *   - return null       → endpoint healthy, but data doesn't
	 *                         contribute (404, malformed body, etc.).
	 *                         Endpoint cooldown NOT applied; quorum
	 *                         credit NOT given.
	 *   - throw             → transport failure; cooldown applied.
	 *
	 * The four-state classification used by the existing fee verifiers
	 * (`ok` / `transport_failure` / `data_not_found` / `data_malformed`)
	 * maps cleanly onto this: `ok` → T, `data_*` → null, transport
	 * failure → throw.
	 *
	 * cp166 — addresses the choke point in the BTC/XMR verifiers
	 * where Promise.allSettled forced the indexer to wait for every
	 * candidate explorer (or its 5s timeout) before checking quorum.
	 * Now quorum check is incremental and returns early.
	 */
	async quorumCall<T>(
		fn: (url: string, signal: AbortSignal) => Promise<T | null>,
		options: {
			/** Caller-provided equivalence-key extractor.  Responses
			 *  with the same key are considered to agree.  Cheap to
			 *  compute — invoked once per successful response. */
			equivalenceKey: (response: T) => string;
			/** Minimum number of agreeing responses required.
			 *  Defaults to 1 (any single success satisfies). */
			minAgree?: number;
			/** Per-call timeout in ms.  If the deadline passes before
			 *  quorum is met, returns whatever responses are in.
			 *  Defaults to {@link DEFAULT_BACKGROUND_TIMEOUT_MS}. */
			timeoutMs?: number;
		}
	): Promise<QuorumCallResult<T>> {
		const minAgree = options.minAgree ?? 1;
		if (minAgree < 1) {
			throw new Error('quorumCall: minAgree must be >= 1');
		}
		const timeoutMs = options.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS;
		const allEndpoints = this.endpoints;
		const candidates = this.sortByLatency(
			allEndpoints.filter((e) => Date.now() >= e.cooldownUntil)
		);
		const cooledDown = allEndpoints.length - candidates.length;

		if (candidates.length === 0) {
			return {
				kind: 'no_endpoints',
				responses: [],
				contacted: 0,
				cooledDown,
				agreedKey: undefined
			};
		}

		// Buckets by equivalence-key, plus running count of total
		// successful responses + total finished (success/null/error).
		const buckets = new Map<string, T[]>();
		const allResponses: T[] = [];
		let finished = 0;
		let agreedKey: string | undefined;

		// One AbortController per endpoint — when quorum is reached we
		// cancel the rest so we don't keep hammering them and so the
		// fn implementation can abort in-flight fetches.
		const controllers = candidates.map(() => new AbortController());

		// Outer controller for the overall timeout.
		const timeoutController = new AbortController();
		const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);

		// Wrap fn in a one-per-endpoint promise that updates state when
		// it settles.  We deliberately await Promise.allSettled at the
		// bottom — the early-return is via a separate awaitable that
		// resolves the instant quorum is met (or all responses are in).
		const quorumReached = new Promise<void>((resolveQuorum) => {
			const allDoneCheck = (): void => {
				if (finished === candidates.length) {
					resolveQuorum();
				}
			};

			candidates.forEach((ep, i) => {
				const t0 = Date.now();
				const c = controllers[i]!;
				// Link the per-endpoint controller to the timeout so the
				// fn sees an abort signal in both cases.
				const onTimeout = (): void => c.abort();
				timeoutController.signal.addEventListener('abort', onTimeout);

				fn(ep.url, c.signal).then(
					(result) => {
						timeoutController.signal.removeEventListener('abort', onTimeout);
						const elapsed = Date.now() - t0;
						if (result === null) {
							// Healthy but non-contributing.  Reset the
							// cooldown ladder (treat as success for
							// breaker purposes) but don't bucket.
							this.recordSuccess(ep, elapsed);
							finished++;
							allDoneCheck();
							return;
						}
						// Success that contributes to quorum.
						this.recordSuccess(ep, elapsed);
						allResponses.push(result);
						const key = options.equivalenceKey(result);
						const bucket = buckets.get(key) ?? [];
						bucket.push(result);
						buckets.set(key, bucket);
						if (bucket.length >= minAgree && agreedKey === undefined) {
							agreedKey = key;
							// Quorum reached — cancel everyone still in flight.
							for (let j = 0; j < controllers.length; j++) {
								if (j !== i) controllers[j]!.abort();
							}
							resolveQuorum();
						}
						finished++;
						allDoneCheck();
					},
					(err) => {
						timeoutController.signal.removeEventListener('abort', onTimeout);
						// If we got here because WE aborted this branch
						// (quorum already reached or overall timeout),
						// don't count it as a transport failure — that
						// would unfairly penalize a healthy endpoint
						// that just hadn't responded yet.
						if (c.signal.aborted && agreedKey !== undefined) {
							finished++;
							allDoneCheck();
							return;
						}
						// Genuine transport / network failure — penalize.
						if (isTransportError(err)) {
							this.recordFailure(ep, isRateLimitError(err));
						}
						finished++;
						allDoneCheck();
					}
				);
			});
		});

		try {
			await quorumReached;
		} finally {
			clearTimeout(timeoutHandle);
		}

		if (agreedKey !== undefined) {
			return {
				kind: 'quorum_met',
				responses: allResponses,
				agreedKey,
				contacted: candidates.length,
				cooledDown
			};
		}
		return {
			kind: 'all_responses_in',
			responses: allResponses,
			agreedKey: undefined,
			contacted: candidates.length,
			cooledDown
		};
	}
}

/** Result shape from {@link EndpointPool.quorumCall}.
 *
 * - `quorum_met` — at least minAgree responses agreed on a single
 *   equivalence key; the call returned as soon as that threshold
 *   was reached, even if other endpoints are still in flight.
 * - `all_responses_in` — every contacted endpoint either responded
 *   or transport-failed; no equivalence group reached minAgree.
 *   The caller decides what to do (pending state, retry later, etc.).
 * - `no_endpoints` — every configured endpoint was in cooldown when
 *   the call started. */
export interface QuorumCallResult<T> {
	readonly kind: 'quorum_met' | 'all_responses_in' | 'no_endpoints';
	readonly responses: readonly T[];
	readonly agreedKey: string | undefined;
	readonly contacted: number;
	readonly cooledDown: number;
}

// ─── @beblurt/dblurt console-noise suppression ──────────────────────
//
// @beblurt/dblurt logs its own internal round-robin chatter through
// raw console.* with no option to disable it:
//   - console.error("Didn't failover for error code: [ENOTFOUND]")
//   - console.log("Switched Blurt RPC: <url> (previous: <url>)")
//
// Because we drive failover with EndpointPool over SINGLE-URL dblurt
// clients, dblurt's own multi-node failover never applies — so on every
// transport error it prints "Didn't failover", which is pure noise: the
// real failover happens one level up in EndpointPool, and the real
// operator signal is on /v1/health -> rpc_endpoints. In the beta5
// firefight this spam made a stalled sync look like an unhandled crash.
//
// suppressDblurtConsoleNoise() installs a one-time console filter that
// drops ONLY those two exact patterns; every other console line passes
// through untouched. Apps call it once at startup.

const DBLURT_NOISE_PATTERNS: readonly RegExp[] = [
	/Didn't failover for error (?:code|message): \[/,
	/^Switched Blurt RPC: /
];

/** True if `line` is one of dblurt's redundant internal log lines.
 *  Exported so it can be unit-tested without patching console. */
export function isDblurtConsoleNoise(line: unknown): boolean {
	return typeof line === 'string' && DBLURT_NOISE_PATTERNS.some((re) => re.test(line));
}

let dblurtNoiseSuppressed = false;

/** Install a one-time console filter dropping @beblurt/dblurt's
 *  redundant internal failover chatter. Idempotent; safe to call from
 *  multiple entry points. Only the two known dblurt patterns are
 *  dropped — all other console output is preserved. */
export function suppressDblurtConsoleNoise(): void {
	if (dblurtNoiseSuppressed) return;
	dblurtNoiseSuppressed = true;
	for (const method of ['error', 'log'] as const) {
		const original = console[method].bind(console);
		console[method] = (...args: unknown[]): void => {
			if (isDblurtConsoleNoise(args[0])) return;
			original(...(args as Parameters<typeof original>));
		};
	}
}
