/**
 * @morphit/rpc-pool — latency-aware RPC endpoint pool.
 *
 * Lifted from the rotation/cooldown logic duplicated in
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
 * Failure semantics:
 *   - transport failure (unreachable, timeout, 429/5xx) → rotate to the
 *     next endpoint, exponential cooldown ladder;
 *   - endpoint fault (the node does not serve the API or method, or its
 *     reply is not a JSON-RPC answer — see isEndpointFaultError) → the
 *     same: rotate and cool down. The node never answered the question,
 *     so asking another one cannot repeat a request it processed;
 *   - any other application error on a READ (`call(fn, { read: true })`)
 *     → ask the next operator; the erroring node is parked only once
 *     another one answers, and an error that several operators return
 *     alike is the request's own fault and is returned to the caller;
 *   - any other application error on anything else (a broadcast) → thrown
 *     to the caller from the first endpoint, no rotation, no cooldown;
 *   - last-ditch retry of every endpoint ignoring cooldowns.
 */

/** Per-endpoint health + latency state. */
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync
} from 'node:fs';

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
	/** Unix-ms timestamp before which the next request to this
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

/** Jitter fraction applied to every cooldown ladder step.
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

/** Default per-endpoint request ceiling, in requests per second.
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

/** Per-call timeout for an endpoint reached over Tor/I2P/Lokinet.
 *
 *  A hidden service is NOT a slow clearnet host — a fresh connection must build
 *  circuits or tunnels before a single byte moves, and 30-60s is ordinary. The
 *  flat 10s background timeout therefore aborted EVERY attempt on a zero-clearnet
 *  node, on healthy and dead endpoints alike, which read as "all RPC endpoints
 *  unavailable" while each endpoint answered a direct request in seconds. The
 *  long-lived indexer service survived on warm tunnels and continuous retries;
 *  any short-lived process could never succeed at all.
 *
 *  Applied PER ENDPOINT, not per call: a pool may hold both kinds, and a
 *  clearnet endpoint must keep its short budget. */
export const DEFAULT_HIDDEN_TIMEOUT_MS = 60_000;

/** How long persisted endpoint health stays useful. Beyond this the file says
 *  nothing about which node is fastest NOW, so it is ignored rather than acted
 *  on — nodes come and go constantly. */
export const HEALTH_STATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Debounce for automatic health persistence — a busy poller must not write on
 *  every single call. */
export const HEALTH_STATE_SAVE_INTERVAL_MS = 30_000;

/** Is this URL reached over a hidden network? Deliberately a local suffix test:
 *  the pool has no dependency on the transport package and should not grow one
 *  for a hostname check. */
export function isHiddenEndpointUrl(url: string): boolean {
	try {
		return /\.(onion|i2p|loki)$/i.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

/** Floor for a USER-FACING call over a hidden network.
 *
 *  A human is waiting, so the background floor is far too long — but the 4s
 *  clearnet budget is unreachable over Tor/I2P, so a hidden-only relay would
 *  fail every availability check during signup. This is the compromise: long
 *  enough for a tunnel to build, short enough that a stuck call still gives up
 *  while the person is plausibly still there. */
export const DEFAULT_HIDDEN_USER_FACING_TIMEOUT_MS = 25_000;

/** The budget this endpoint actually needs. Never SHORTENS an explicit caller
 *  timeout — only raises the floor for a hidden endpoint that cannot meet it.
 *
 *  `userFacing` picks WHICH floor: a background job may wait a full minute, a
 *  person may not. Without this split the relay's user-facing calls — which
 *  deliberately run on a 4s budget — would have inherited the 60s background
 *  floor, turning a snappy failure into a minute-long hang on a hidden-only
 *  relay. */
export function effectiveTimeoutMs(url: string, timeoutMs: number, userFacing = false): number {
	if (!isHiddenEndpointUrl(url)) return timeoutMs;
	const floor = userFacing ? DEFAULT_HIDDEN_USER_FACING_TIMEOUT_MS : DEFAULT_HIDDEN_TIMEOUT_MS;
	return Math.max(timeoutMs, floor);
}

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
	// family. These are non-standard 5xx codes that an UPSTREAM
	// edge/proxy sitting in front of a Blurt RPC node returns when it
	// can't get a valid response from that node's origin — e.g. 521
	// "origin down", 522/524 timeout, 523 "unreachable". For us they
	// describe an unreachable upstream endpoint, i.e. a transport
	// failure → rotate off it. (These come from whatever proxy a given
	// Blurt node operator runs upstream; Morphit's own stack is
	// BunkerWeb with no CDN.) Without this the pool gave up on the
	// first 521 instead of hopping to a healthy node: a relay broadcast
	// failed with `HTTP 521: <none>` while other nodes were healthy.
	if (/\bhttp (?:408|429|500|502|503|504|52[0-7])\b/.test(m)) return true;
	return false;
}

/**
 * Is this error about the ENDPOINT rather than about the request?
 *
 * Two kinds, both of which mean the node gave no usable answer to a question
 * other nodes can answer:
 *   - it does not serve the API or method asked for ("Could not find API
 *     condenser_api", "Could not find method …", JSON-RPC -32601). A public
 *     node with a plugin switched off answers EVERY call this way — and so can
 *     a hostile node that wants to stall whoever lists it first;
 *   - its reply is not a JSON-RPC answer (not JSON, no result/error, wrong id).
 *
 * The pool treats these like a transport failure: rotate to the next endpoint
 * and cool this one down. That is also safe for a broadcast — the caller offers
 * the SAME signed bytes (nothing is re-signed in the pool), and a timeout
 * already rotates a broadcast in exactly the same way.
 *
 * The node writes these messages itself, so a hostile node can always make its
 * own error look like a fault. That only gets IT parked, which is the point.
 */
export function isEndpointFaultError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const m = err.message.toLowerCase();
	if (/could not find (?:api|method)\b/.test(m)) return true;
	if (/\bmethod not found\b/.test(m)) return true;
	const meta = (err as { metadata?: { rpc_code?: unknown } }).metadata;
	if (meta !== undefined && meta !== null && meta.rpc_code === -32601) return true;
	if (err.name === 'SyntaxError') return true;
	if (m.includes('malformed json-rpc response')) return true;
	if (m.includes('got invalid response id')) return true;
	return false;
}

/** On a READ, how many distinct operators must return an application error
 *  before it is taken to be the request's own fault and returned. Fewer than
 *  this, and a later operator answering proves the error was node-local. Three
 *  keeps an unknown-id lookup cheap while one or two misbehaving operators can
 *  no longer decide the answer for everyone. */
export const READ_ERROR_AGREEMENT_OPERATORS = 3;

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
	/** Where to persist per-endpoint health between processes.
	 *
	 *  Health is otherwise IN-MEMORY ONLY, which is fine for the long-lived
	 *  indexer — it learns within seconds which nodes are fast and which are
	 *  down. But every SHORT-LIVED process (the mirror job, fast-sync, any
	 *  one-shot script) starts blind and tries endpoints in CONFIG ORDER,
	 *  paying a full timeout on whatever happens to be dead or slow first.
	 *  With ~20 endpoints, and a 60s floor on hidden ones, that is a minute
	 *  wasted per run on a node the long-lived process already knew was down.
	 *
	 *  The whole point of running many endpoints is to always use the best one
	 *  available; requiring an operator to hand-prune a node that blipped is
	 *  exactly the manual work this pool exists to remove. Persisting the
	 *  health it already tracks lets a one-shot run start from knowledge
	 *  instead of from nothing.
	 *
	 *  Fail-open: unreadable or corrupt state is ignored and the pool behaves
	 *  exactly as it does today. */
	readonly healthStatePath?: string;
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
	/** override the jitter fraction applied to cooldown ladder steps.
	 *  Must be in [0, 1).  0 disables jitter (deterministic cooldowns — only
	 *  appropriate in tests that assert exact timings). */
	readonly cooldownJitterFraction?: number;
	/** per-endpoint request ceiling in requests/second.  Defaults to
	 *  DEFAULT_MAX_REQUESTS_PER_SECOND.  0 disables pacing.  This is a
	 *  per-ENDPOINT cap, not a pool-wide one: the pool's aggregate ceiling is
	 *  this times the number of healthy endpoints. */
	readonly maxRequestsPerSecond?: number;
	/** injectable RNG, for tests that need deterministic jitter.
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
	/** Who RUNS the node behind a URL.
	 *
	 *  `quorumCall` used to count agreement per URL. Every hidden Blurt node is
	 *  listed twice — once as `.onion`, once as `.b32.i2p` — so ONE operator
	 *  answering on both transports met a two-endpoint quorum alone, and a quorum
	 *  exists precisely so that no single operator decides. Agreement is now
	 *  counted per operator NAME: URLs mapped to the same name count once.
	 *  A name is a label, not proof: two names may be run by one person, and
	 *  nothing here can tell (VT4-6).
	 *
	 *  Return undefined for "unknown", which falls back to the URL itself — the
	 *  old per-URL behaviour, still right for pools whose URLs are independent
	 *  by construction (the BTC/XMR explorer lists). */
	readonly operatorOf?: (url: string) => string | undefined;
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
	/** This call only READS chain state. An application error from one node is
	 *  then not taken as the answer: the next operator is asked, and the node
	 *  that erred is parked once another one answers. Only when
	 *  READ_ERROR_AGREEMENT_OPERATORS operators return an error is it the
	 *  answer. Leave unset for a broadcast: the chain's rejection of a
	 *  transaction is the answer, and it is returned from the first node. */
	readonly read?: boolean;
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
	private readonly healthStatePath: string | undefined;
	private lastHealthSaveAt = 0;
	private readonly cooldownLadder: readonly number[];

	/**
	 * Seed endpoint health from a previous process, so a one-shot run starts
	 * from what is already known instead of trying endpoints in config order.
	 *
	 * Only LATENCY and FAILURE history are restored — never a cooldown, because
	 * a node that was down five minutes ago may be up now and must get a fair
	 * chance immediately. Nodes come and go constantly; this biases ORDER, it
	 * does not exclude anyone.
	 *
	 * Stale state is ignored entirely: knowledge older than the freshness window
	 * says nothing useful about which node is fastest right now.
	 */
	private loadHealthState(): void {
		if (this.healthStatePath === undefined) return;
		try {
			// Never read through a link (review G1): a parse error would quote
			// the first bytes of whatever file it named.
			let text: string;
			const fd = openSync(
				this.healthStatePath,
				fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
			);
			try {
				if (!fstatSync(fd).isFile()) return;
				text = readFileSync(fd, 'utf8');
			} finally {
				closeSync(fd);
			}
			const raw: unknown = JSON.parse(text);
			if (raw === null || typeof raw !== 'object') return;
			const rec = raw as { savedAt?: unknown; endpoints?: unknown };
			const savedAt = typeof rec.savedAt === 'number' ? rec.savedAt : 0;
			if (Date.now() - savedAt > HEALTH_STATE_MAX_AGE_MS) return;
			const eps = rec.endpoints;
			if (eps === null || typeof eps !== 'object') return;
			for (const ep of this.endpoints) {
				const v = (eps as Record<string, unknown>)[ep.url];
				if (v === null || typeof v !== 'object') continue;
				const e = v as { ewmaLatencyMs?: unknown; consecutiveFailures?: unknown };
				if (typeof e.ewmaLatencyMs === 'number' && Number.isFinite(e.ewmaLatencyMs)) {
					ep.ewmaLatencyMs = e.ewmaLatencyMs;
				}
				if (typeof e.consecutiveFailures === 'number' && Number.isFinite(e.consecutiveFailures)) {
					ep.consecutiveFailures = Math.max(0, Math.trunc(e.consecutiveFailures));
				}
			}
		} catch {
			/* fail-open: unreadable state must never break the pool */
		}
	}

	/** Write current health back. Best-effort and atomic-ish; never throws. */
	saveHealthState(): void {
		if (this.healthStatePath === undefined) return;
		try {
			const out: Record<string, { ewmaLatencyMs: number | null; consecutiveFailures: number }> = {};
			for (const ep of this.endpoints) {
				out[ep.url] = {
					ewmaLatencyMs: ep.ewmaLatencyMs,
					consecutiveFailures: ep.consecutiveFailures
				};
			}
			// Root (morphit-ops) saves here too, and the file lives in the
			// morphit account's home: the temporary file is always a NEW one
			// (O_EXCL), never opened through a link planted there (review G1);
			// rename() replaces a link at the final name rather than following it.
			const tmp = `${this.healthStatePath}.tmp`;
			try {
				unlinkSync(tmp);
			} catch {
				/* not there */
			}
			const fd = openSync(
				tmp,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
				0o640
			);
			try {
				writeSync(fd, JSON.stringify({ savedAt: Date.now(), endpoints: out }));
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, this.healthStatePath);
		} catch {
			/* best-effort */
		}
	}
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
		this.healthStatePath = options.healthStatePath;
		this.loadHealthState();
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
		this.operatorOfOption = options.operatorOf;
	}

	private readonly operatorOfOption: ((url: string) => string | undefined) | undefined;
	/** Operator names learned at runtime (the on-chain directory's node names). */
	private readonly operatorByUrl = new Map<string, string>();

	/** The operator identity quorum agreement is counted by: a name
	 *  learned at runtime, else the constructor's `operatorOf`, else the URL.
	 *  Names are labels (the directory's node names), not proven independence. */
	operatorOf(url: string): string {
		return this.operatorByUrl.get(url) ?? this.operatorOfOption?.(url) ?? url;
	}

	/** Distinct operator names in the pool. */
	operatorCount(): number {
		return new Set(this.endpoints.map((ep) => this.operatorOf(ep.url))).size;
	}

	/**
	 * Distinct operators worth counting on for a quorum right now.
	 *
	 * An operator is left out only while EVERY one of its endpoints is failing
	 * (its last attempt was a transport failure and nothing has succeeded
	 * since). Before this, a quorum's size came from the configured pool, so a
	 * box with one working node plus hidden defaults it cannot reach (Tor not
	 * installed, say) asked for two agreeing answers that could never arrive,
	 * forever. A failing operator is still ASKED — it counts again the moment it
	 * answers — it is just not waited for.
	 *
	 * LIVENESS ONLY. One transport blip on the other operators drops this to 1,
	 * so a quorum sized from it collapses to a single operator's word exactly
	 * when the network is flaky. Never size the quorum for an answer that is
	 * written down or trusted afterwards from this number: use a fixed count
	 * (and `operatorCount()` to know whether the pool can meet it at all), and
	 * retry later when it is not met.
	 */
	reachableOperatorCount(): number {
		const ok = new Set<string>();
		for (const ep of this.endpoints) {
			if (ep.consecutiveFailures === 0) ok.add(this.operatorOf(ep.url));
		}
		return ok.size;
	}

	/** Add endpoints to the pool at runtime (idempotent — a URL already present
	 *  is skipped, so existing health/latency state is preserved). Returns the
	 *  URLs that were newly added. Used to self-populate from the on-chain RPC
	 *  directory (`morphit_rpc_v1`) without a restart.
	 *
	 *  `operators` (url → operator name) records who runs each address, so the
	 *  two addresses of one directory node count once in a quorum. */
	mergeEndpoints(urls: readonly string[], operators?: Readonly<Record<string, string>>): string[] {
		if (operators !== undefined) {
			for (const [url, name] of Object.entries(operators)) {
				if (typeof name === 'string' && name !== '') this.operatorByUrl.set(url, name);
			}
		}
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
	 *  Transport errors and endpoint faults (isEndpointFaultError)
	 *  trigger rotation + cooldown.  Other application-level errors
	 *  (the upstream returned an RPC error) propagate to the caller
	 *  without rotating — unless the call is a `read`, see CallOptions.
	 */
	async call<T>(
		fn: (url: string, signal: AbortSignal) => Promise<T>,
		options: CallOptions = {}
	): Promise<T> {
		const hedge = options.hedge === true;
		const read = options.read === true;
		// Read errors whose blame is deferred: the endpoint is parked only if a
		// later endpoint answers (then the error was that node's alone).
		const readErrors: Array<{ ep: EndpointState; err: unknown }> = [];
		const readErrorOperators = new Set<string>();
		/** 'next' = try the next endpoint; otherwise the error to throw now. */
		const classify = (ep: EndpointState, err: unknown): 'next' | { throw: unknown } => {
			if (isTransportError(err) || isEndpointFaultError(err)) {
				// recordFailure was called inside attempt()
				lastError = err;
				return 'next';
			}
			if (!read) return { throw: err };
			readErrors.push({ ep, err });
			readErrorOperators.add(this.operatorOf(ep.url));
			// Several operators give the same kind of answer: it is the
			// request's fault (an unknown id, say). Nobody is parked for it.
			if (readErrorOperators.size >= READ_ERROR_AGREEMENT_OPERATORS) {
				return { throw: readErrors[0]!.err };
			}
			return 'next';
		};
		const answered = (result: T): T => {
			for (const r of readErrors) this.recordFailure(r.ep);
			return result;
		};
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
			// Already asked in this call — as the hedge of the previous attempt
			// (v1.20.0, D9). Asking it again doubles the wait on a failing node.
			if (triedUrls.has(ep.url)) continue;
			triedUrls.add(ep.url);
			const next = primaryOrder.slice(i + 1).find((e) => !triedUrls.has(e.url));
			try {
				const result = await this.attempt(ep, next, fn, timeoutMs, hedge, (url) =>
					triedUrls.add(url)
				);
				return answered(result);
			} catch (err) {
				const verdict = classify(ep, err);
				if (verdict === 'next') continue;
				throw verdict.throw;
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
				const result = await this.attemptSingle(ep, fn, timeoutMs, hedge);
				return answered(result);
			} catch (err) {
				const verdict = classify(ep, err);
				if (verdict === 'next') continue;
				throw verdict.throw;
			}
		}

		// No endpoint answered. A read that met application errors returns the
		// first of them (what the caller would have seen before), and nobody is
		// parked for it — nothing proved it node-local.
		if (readErrors.length > 0) throw readErrors[0]!.err;
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
		hedge: boolean,
		onHedgeDispatched: (url: string) => void = () => {}
	): Promise<T> {
		const primaryEwma = primary.ewmaLatencyMs;
		const shouldHedge =
			hedge &&
			hedgeAgainst !== undefined &&
			primaryEwma !== null &&
			primaryEwma > this.hedgeThresholdMs;

		if (!shouldHedge) {
			// `hedge` doubles as "a person is waiting": it picks the hidden-network
			// floor (25 s user-facing, 60 s background). This used to pass `true`
			// unconditionally, so every background call — the poller, backfills,
			// one-shot scripts, signed-write proxying — was cut off at 25 s on a
			// .onion/.i2p endpoint, and MORPHIT_HIDDEN_RPC_TIMEOUT_MS could not raise
			// it.
			return this.attemptSingle(primary, fn, timeoutMs, hedge);
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
		// Hedged path: the budget must cover BOTH endpoints in play, so take the
		// larger floor. Hedging a hidden endpoint against a clearnet one must not
		// inherit the clearnet budget and abort the hidden leg before it connects.
		const hedgeTimeoutMs = Math.max(
			effectiveTimeoutMs(primary.url, timeoutMs, true),
			hedgeAgainst === undefined ? 0 : effectiveTimeoutMs(hedgeAgainst.url, timeoutMs, true)
		);
		const timeoutHandle = setTimeout(() => timeoutCtl.abort(), hedgeTimeoutMs);

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
				// The loser of the race is aborted BY US once the other leg wins.
				// That says nothing about its health, so it must not be recorded
				// as a failure (cooldown + wiped EWMA would push a healthy node out
				// of rotation). Only the shared deadline is a real timeout
				// (quorumCall already made this distinction).
				const abortedByUs = ctl.signal.aborted && !timeoutCtl.signal.aborted;
				if (!abortedByUs && (isTransportError(err) || isEndpointFaultError(err))) {
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
					onHedgeDispatched(hedgeAgainst.url);
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

	/** hold the caller until this endpoint's RPS budget allows the
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
		timeoutMs: number,
		userFacing = false
	): Promise<T> {
		const ctl = new AbortController();
		const handle = setTimeout(() => ctl.abort(), effectiveTimeoutMs(ep.url, timeoutMs, userFacing));
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
				if (isTransportError(err) || isEndpointFaultError(err)) {
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
	 *  design note: an earlier version sorted unknown-EWMA to
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
		// "Unknown EWMA" means two very different things, and conflating them is
		// what made a DEAD endpoint get tried first on every run: an endpoint that
		// has never SUCCEEDED has a null EWMA, so the bootstrap rule treated a node
		// that keeps failing exactly like a brand-new one. With a 60s hidden-service
		// timeout that cost a full minute per run on a node already known to be bad.
		//
		// Split them by failure history. Never EXCLUDE anyone — nodes come and go
		// constantly and one that was down a minute ago may be up now — this only
		// decides who is asked FIRST:
		//   1. never-tried (null EWMA, no failures) — bootstrap, unchanged
		//   2. known-good — fastest EWMA first
		//   3. failing-with-no-successful-measurement — last, but still tried
		const rank = (e: EndpointState): number =>
			e.ewmaLatencyMs === null ? (e.consecutiveFailures > 0 ? 2 : 0) : 1;
		return eps.sort((a, b) => {
			const ra = rank(a);
			const rb = rank(b);
			if (ra !== rb) return ra - rb;
			// Same rank and both unknown → preserve declaration order (stable);
			// among failing ones, fewer recent failures first.
			if (a.ewmaLatencyMs === null || b.ewmaLatencyMs === null) {
				return a.consecutiveFailures - b.consecutiveFailures;
			}
			// Both known → fastest EWMA first.
			return a.ewmaLatencyMs - b.ewmaLatencyMs;
		});
	}

	/** Persist health automatically, at most once every few seconds.
	 *
	 *  Deliberately NOT left to callers: an earlier version required an explicit
	 *  saveHealthState() call, which nothing made — a capability nobody can reach
	 *  is not a feature. Debounced so a busy poller does not write on every call,
	 *  and best-effort so a read-only filesystem changes nothing. */
	private maybeSaveHealthState(): void {
		if (this.healthStatePath === undefined) return;
		const now = Date.now();
		if (now - this.lastHealthSaveAt < HEALTH_STATE_SAVE_INTERVAL_MS) return;
		this.lastHealthSaveAt = now;
		this.saveHealthState();
	}

	private recordSuccess(ep: EndpointState, latencyMs: number): void {
		ep.consecutiveFailures = 0;
		ep.cooldownUntil = 0;
		ep.lastSuccessAt = Date.now();
		this.maybeSaveHealthState();
		if (ep.ewmaLatencyMs === null) {
			ep.ewmaLatencyMs = latencyMs;
		} else {
			ep.ewmaLatencyMs = this.alpha * latencyMs + (1 - this.alpha) * ep.ewmaLatencyMs;
		}
	}

	private recordFailure(ep: EndpointState, rateLimited = false): void {
		ep.consecutiveFailures++;
		// Persist failures too, not just successes — knowing which node is DOWN is
		// exactly what saves a one-shot run from paying a full timeout on it.
		this.maybeSaveHealthState();
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

	/** spread a ladder step uniformly over
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
	 * addresses the choke point in the BTC/XMR verifiers
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
			/** Minimum number of agreeing OPERATORS required (see
			 *  {@link EndpointPoolOptions.operatorOf}).  Defaults to 1. */
			minAgree?: number;
			/** Per-endpoint timeout in ms, raised to the hidden-network floor
			 *  for .onion/.i2p endpoints exactly as `call` does.  Defaults to
			 *  {@link DEFAULT_BACKGROUND_TIMEOUT_MS}. */
			timeoutMs?: number;
			/** How many operators are asked at once.  When one of them
			 *  fails, disagrees or has no answer, the next operator is asked,
			 *  so a cap never lowers what can be learned — it only stops every
			 *  endpoint being hit for every call.  Default: all at once. */
			maxOperators?: number;
		}
	): Promise<QuorumCallResult<T>> {
		const minAgree = options.minAgree ?? 1;
		if (minAgree < 1) {
			throw new Error('quorumCall: minAgree must be >= 1');
		}
		const timeoutMs = options.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS;
		const maxOperators = Math.max(1, options.maxOperators ?? Number.POSITIVE_INFINITY);
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

		// group endpoints by OPERATOR, fastest
		// operator first. One operator contributes at most one answer, however
		// many addresses it has, so its .onion and .b32.i2p can no longer
		// out-vote an honest pair. An operator's other addresses are its
		// fallbacks when the first fails at transport level.
		//
		// Ordered PROVEN-first, unlike `call`'s bootstrap-unknowns-first rule:
		// with a capped window, asking three never-tried hidden nodes before two
		// that just answered would make every quorum wait out their full
		// hidden-network timeouts. Known-good by latency, then never tried, then
		// failing — nobody is excluded, only ordered.
		const quorumRank = (e: EndpointState): number =>
			e.ewmaLatencyMs !== null ? 0 : e.consecutiveFailures > 0 ? 2 : 1;
		candidates.sort((a, b) => {
			const d = quorumRank(a) - quorumRank(b);
			if (d !== 0) return d;
			return (a.ewmaLatencyMs ?? 0) - (b.ewmaLatencyMs ?? 0);
		});
		const byOperator = new Map<string, EndpointState[]>();
		for (const ep of candidates) {
			const op = this.operatorOf(ep.url);
			const list = byOperator.get(op);
			if (list === undefined) byOperator.set(op, [ep]);
			else list.push(ep);
		}
		const operators = [...byOperator.values()];

		// Buckets by equivalence-key → the operators that returned it.
		const buckets = new Map<string, number>();
		const allResponses: T[] = [];
		let agreedKey: string | undefined;
		let contacted = 0;
		const inFlight = new Set<AbortController>();

		/** Ask one operator: its endpoints in latency order until one answers
		 *  (a value or a null) or all fail. Resolves with the answer, or
		 *  undefined when none came. Never rejects. */
		const askOperator = async (eps: EndpointState[]): Promise<{ value: T | null } | undefined> => {
			for (const ep of eps) {
				if (agreedKey !== undefined) return undefined;
				const c = new AbortController();
				inFlight.add(c);
				// rv2-9: the hidden-network floor, per endpoint. The flat 10 s
				// budget cut every .onion/.i2p answer off mid-tunnel on a cold
				// hidden-only node, so its quorum never formed.
				let timedOut = false;
				const handle = setTimeout(() => {
					timedOut = true;
					c.abort();
				}, effectiveTimeoutMs(ep.url, timeoutMs));
				const t0 = Date.now();
				contacted++;
				try {
					const value = await fn(ep.url, c.signal);
					this.recordSuccess(ep, Date.now() - t0);
					return { value };
				} catch (err) {
					// rv2-9: an abort WE caused because quorum was already met
					// says nothing about this endpoint — never a failure. A
					// timeout at the endpoint's full budget is a real one.
					if (c.signal.aborted && !timedOut) return undefined;
					if (timedOut || isTransportError(err)) {
						this.recordFailure(ep, isRateLimitError(err));
					}
				} finally {
					clearTimeout(handle);
					inFlight.delete(c);
				}
			}
			return undefined;
		};

		await new Promise<void>((resolveDone) => {
			let next = 0;
			let running = 0;
			const launch = (): void => {
				while (agreedKey === undefined && running < maxOperators && next < operators.length) {
					const eps = operators[next++]!;
					running++;
					void askOperator(eps).then((answer) => {
						running--;
						if (agreedKey === undefined && answer !== undefined && answer.value !== null) {
							const result = answer.value;
							allResponses.push(result);
							const key = options.equivalenceKey(result);
							const n = (buckets.get(key) ?? 0) + 1;
							buckets.set(key, n);
							if (n >= minAgree) {
								agreedKey = key;
								// Quorum reached — cancel everyone still in flight.
								for (const c of inFlight) c.abort();
								resolveDone();
								return;
							}
						}
						if (agreedKey !== undefined) return;
						// Replace an operator that gave nothing usable at once. One
						// that answered is waited on with the others still out; only
						// when every asked operator is in without agreement are more
						// asked — so an honest, agreeing set costs `maxOperators`
						// requests at most.
						const gaveNothing = answer === undefined || answer.value === null;
						if (gaveNothing || running === 0) launch();
						if (running === 0 && next >= operators.length) resolveDone();
					});
				}
			};
			launch();
		});

		if (agreedKey !== undefined) {
			return {
				kind: 'quorum_met',
				responses: allResponses,
				agreedKey,
				contacted,
				cooledDown
			};
		}
		return {
			kind: 'all_responses_in',
			responses: allResponses,
			agreedKey: undefined,
			contacted,
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
