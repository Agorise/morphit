/**
 * flow-backfill — the out-of-order reorder-buffer catch-up path (v1.15.x).
 *
 * WHY: the FIFO drain (`consumeInOrderWithPrefetch`) awaits the OLDEST in-flight
 * window before the next can apply. When that window is on a slow endpoint
 * (a Tor/i2p RPC at ~2s vs clearnet ~130ms), the whole pipeline stalls even
 * though newer windows already arrived — head-of-line blocking. On a full
 * genesis replay that caps throughput far below what the DB could apply.
 *
 * WHAT: fetch many windows concurrently, accept them in ANY arrival order into a
 * resource-bounded reorder buffer, and drain the CONTIGUOUS PREFIX into the DB
 * as fast as it fills. A slow endpoint only delays its OWN blocks landing in the
 * buffer; it no longer freezes everyone else's fetch. To stop the apply cursor
 * from waiting on a straggler, near-cursor windows are dispatched fastest-first
 * and the single cursor-gating window is HEDGED (re-issued to the fast pool) if
 * it misses a latency-derived deadline.
 *
 * INVARIANTS (pinned by flow-backfill-smoke, no chain/DB needed):
 *   - strictly ascending, gap-free, exactly-once apply regardless of arrival order
 *   - buffered + in-flight bytes never exceed the governor's high-water (memory)
 *   - only the cursor window is ever hedged; at most one extra copy
 *   - a failed range is re-queued (bounded retries) — never silently skipped
 *   - abort mid-run: clean return, no unhandled rejection
 *
 * This module is 100% dependency-injected (fetch, apply, clock, timer, memory
 * probe) so its correctness + resource-safety are unit-testable. The real wiring
 * lives in poller.ts; the real memory probe in memoryBudget.ts.
 */

/** A fetched window: the block payloads for [lo, lo+blocks.length-1]. Blocks are
 *  opaque here (a `null` entry = a hole the apply step handles); the orchestrator
 *  only cares about ordering, count, and byte size. */
export interface FetchedWindow<B> {
	readonly lo: number;
	readonly blocks: ReadonlyArray<B | null>;
	readonly bytes: number;
}

/** Governor: the adaptive resource controller. Decides how much the backfill may
 *  buffer + keep in flight, and adapts it to real memory. Injected so tests can
 *  drive memory pressure deterministically. */
export interface Governor {
	/** Max bytes that may be buffered + estimated-in-flight at once. */
	highWaterBytes(): number;
	/** Resume-launching threshold (hysteresis); < highWaterBytes. */
	lowWaterBytes(): number;
	/** Ceiling on concurrent in-flight fetch operations. */
	maxInflight(): number;
	/** Hard backstop: RSS is near the budget → pause launching + shrink. */
	underPressure(): boolean;
	/** Record a fetched window so the bytes⇔blocks estimate tracks real block size. */
	recordWindow(bytes: number, blockCount: number): void;
	/** Current EWMA estimate of bytes per block (for in-flight byte estimation). */
	avgBlockBytes(): number;
}

export interface FlowDeps<B> {
	/** First and last block to apply (inclusive). */
	readonly from: number;
	readonly target: number;
	/** Blocks per window (BLOCK_FETCH_BATCH). */
	readonly windowBlocks: number;

	/** Fetch [lo, hi]. `preferFastest` → dispatch fastest-first (cursor-adjacent /
	 *  hedge); otherwise spread across the pool (speculative far-ahead). Rejects
	 *  when the pool exhausts every endpoint for the range. */
	fetchRange(lo: number, hi: number, preferFastest: boolean): Promise<ReadonlyArray<B | null>>;
	/** Byte size of a fetched window (for the governor). */
	windowBytes(blocks: ReadonlyArray<B | null>): number;
	/** Apply one window's blocks in strict order (one bounded tx). Returns FALSE to
	 *  STOP the pipeline (a hole to re-fetch next tick, or abort) — the prefix it
	 *  applied is committed. Returns TRUE to continue. */
	applyWindow(w: { lo: number; blocks: ReadonlyArray<B | null> }): Promise<boolean>;

	readonly governor: Governor;
	now(): number;
	/** Schedule `cb` after `ms`; returns a cancel fn. Injected for tests. */
	setTimer(ms: number, cb: () => void): () => void;

	/** Multiplier on the fastest endpoint's latency → the cursor window's hedge
	 *  deadline. 0 disables hedging. */
	readonly hedgeFactor: number;
	/** Fastest healthy endpoint EWMA latency (ms) — the hedge deadline basis. */
	fastestLatencyMs(): number;
	/** How many windows above the cursor count as "near-cursor" → preferFastest. */
	readonly fastBand: number;
	/** Max fetch attempts for a single range before giving up (throws). */
	readonly maxRetriesPerRange: number;
	/** When launching is blocked ONLY by the buffer cap / memory pressure and
	 *  nothing is in flight, re-check after this many ms (there's no fetch event
	 *  to wake on). Real wiring ~100ms; tests drive it on the virtual clock. */
	readonly backpressurePollMs: number;

	aborted(): boolean;
}

type Ev<B> =
	| { readonly t: 'ok'; readonly lo: number; readonly blocks: ReadonlyArray<B | null>; readonly bytes: number }
	| { readonly t: 'fail'; readonly lo: number; readonly err: unknown }
	| { readonly t: 'wake' };

/**
 * Run the reorder-buffer backfill for [from, target]. Applies as far as the
 * contiguous prefix allows; returns when caught up, aborted, or an applyWindow
 * asked to stop. Throws only if a range can't be fetched after maxRetriesPerRange.
 */
export async function flowBackfill<B>(deps: FlowDeps<B>): Promise<void> {
	const { from, target, windowBlocks, governor } = deps;
	if (from > target) return;

	const hiOf = (lo: number): number => Math.min(lo + windowBlocks - 1, target);

	let cursor = from; // next block that must be applied
	let nextLo = from; // next range not yet dispatched
	let stopped = false; // applyWindow said stop (hole/abort)

	const buffer = new Map<number, FetchedWindow<B>>(); // lo → fetched, awaiting its turn
	let bufferedBytes = 0;
	// in-flight originals keyed by lo (for hedge/cap bookkeeping). A hedge shares
	// the lo but is tracked only via `pendingOps` + `hedged`.
	const inflight = new Map<number, { dispatchedAt: number; hedged: boolean }>();
	let pendingOps = 0; // originals + hedges currently awaiting (drives the cap)
	const retryQueue: number[] = []; // ranges to re-request on failure, drained before nextLo
	const attempts = new Map<number, number>(); // per-lo fetch attempt count
	let hedgeTimerCancel: (() => void) | null = null;

	// Wake mechanism: fetches + the hedge timer push an event and signal `wake`.
	let events: Array<Ev<B>> = [];
	let wake!: () => void;
	let wakeP = new Promise<void>((r) => (wake = r));
	const signal = (ev: Ev<B>): void => {
		events.push(ev);
		wake();
	};

	const estInflightBytes = (): number => pendingOps * governor.avgBlockBytes() * windowBlocks;
	const canLaunch = (): boolean =>
		!stopped &&
		!deps.aborted() &&
		pendingOps < governor.maxInflight() &&
		!governor.underPressure() &&
		bufferedBytes + estInflightBytes() < governor.highWaterBytes();

	const dispatch = (lo: number, preferFastest: boolean): void => {
		const hi = hiOf(lo);
		attempts.set(lo, (attempts.get(lo) ?? 0) + 1);
		if (!inflight.has(lo)) inflight.set(lo, { dispatchedAt: deps.now(), hedged: false });
		pendingOps++;
		deps
			.fetchRange(lo, hi, preferFastest)
			.then((blocks) => signal({ t: 'ok', lo, blocks, bytes: deps.windowBytes(blocks) }))
			.catch((err) => signal({ t: 'fail', lo, err }));
	};

	// Arm (or re-arm) the hedge timer for the CURRENT cursor window, if it's the
	// one in flight and hedging is on. Only the cursor window is ever hedged.
	const armHedge = (): void => {
		if (hedgeTimerCancel) {
			hedgeTimerCancel();
			hedgeTimerCancel = null;
		}
		if (deps.hedgeFactor <= 0) return;
		const cur = inflight.get(cursor);
		if (!cur || cur.hedged || buffer.has(cursor)) return;
		const base = Math.max(50, deps.fastestLatencyMs());
		const deadline = cur.dispatchedAt + deps.hedgeFactor * base;
		const wait = Math.max(0, deadline - deps.now());
		hedgeTimerCancel = deps.setTimer(wait, () => {
			hedgeTimerCancel = null;
			const c = inflight.get(cursor);
			if (c && !c.hedged && !buffer.has(cursor) && cursor <= target && !stopped) {
				c.hedged = true;
				dispatch(cursor, /* preferFastest */ true); // second copy, fastest-first
			}
			signal({ t: 'wake' });
		});
	};

	const launch = (): void => {
		while (canLaunch()) {
			let lo: number;
			if (retryQueue.length > 0) lo = retryQueue.shift()!;
			else if (nextLo <= target) {
				lo = nextLo;
				nextLo = hiOf(nextLo) + 1;
			} else break;
			// Already satisfied (a hedge/late copy) — don't re-dispatch.
			if (lo < cursor || buffer.has(lo)) continue;
			const preferFastest = lo - cursor < deps.fastBand * windowBlocks;
			dispatch(lo, preferFastest);
		}
	};

	// Drain the contiguous prefix. Returns when the cursor window isn't buffered.
	const drain = async (): Promise<void> => {
		while (!stopped && buffer.has(cursor)) {
			const w = buffer.get(cursor)!;
			buffer.delete(cursor);
			bufferedBytes -= w.bytes;
			const keepGoing = await deps.applyWindow({ lo: w.lo, blocks: w.blocks });
			if (keepGoing === false) {
				stopped = true;
				return;
			}
			cursor = hiOf(w.lo) + 1;
		}
	};

	try {
		launch();
		while (!stopped && cursor <= target) {
			if (deps.aborted()) {
				stopped = true;
				break;
			}
			// Nothing in flight and the cursor isn't buffered. Try to launch; if we
			// still can't, decide: genuinely done, or merely blocked by the buffer
			// cap / memory pressure with work remaining (then poll and retry —
			// there's no fetch event to wake on).
			if (pendingOps === 0 && !buffer.has(cursor)) {
				launch();
				if (pendingOps === 0 && !buffer.has(cursor)) {
					const moreWork = retryQueue.length > 0 || nextLo <= target;
					if (!moreWork) break; // truly caught up
					deps.setTimer(deps.backpressurePollMs, () => signal({ t: 'wake' }));
				}
			}
			armHedge();

			await wakeP;
			wakeP = new Promise<void>((r) => (wake = r)); // re-arm BEFORE processing
			const batch = events;
			events = [];

			for (const ev of batch) {
				if (ev.t === 'wake') continue;
				pendingOps--;
				if (ev.t === 'fail') {
					// Pool exhausted every endpoint for this range. Re-queue unless
					// it's already satisfied by a sibling copy or we're past it.
					if (ev.lo < cursor || buffer.has(ev.lo)) {
						if (inflight.get(ev.lo) && !buffer.has(ev.lo)) inflight.delete(ev.lo);
						continue;
					}
					if ((attempts.get(ev.lo) ?? 0) >= deps.maxRetriesPerRange) {
						throw new Error(
							`flow-backfill: range starting ${ev.lo} unavailable after ${deps.maxRetriesPerRange} attempts: ${String(ev.err)}`
						);
					}
					inflight.delete(ev.lo);
					retryQueue.push(ev.lo); // re-fetch this exact range
					continue;
				}
				// t === 'ok'
				if (ev.lo < cursor || buffer.has(ev.lo)) {
					// A hedge/late duplicate for an already-handled range — discard.
					inflight.delete(ev.lo);
					continue;
				}
				buffer.set(ev.lo, { lo: ev.lo, blocks: ev.blocks, bytes: ev.bytes });
				bufferedBytes += ev.bytes;
				inflight.delete(ev.lo);
				governor.recordWindow(ev.bytes, ev.blocks.length);
			}

			await drain(); // apply the newly-contiguous prefix (may be a burst)
			launch(); // refill now that the buffer/in-flight has room
		}
	} finally {
		if (hedgeTimerCancel) hedgeTimerCancel();
		// Abandon any still-in-flight fetches: their .catch already swallows a late
		// rejection via signal(); nothing here awaits them, so no unhandled rejection.
	}
}

export interface GovernorConfig {
	/** Hard cap on buffer bytes (0 = auto from budget × memFraction). */
	readonly maxBufferBytes: number;
	/** Fraction of the memory budget the buffer may use when auto-sizing. */
	readonly memFraction: number;
	/** Absolute auto-cap so a huge-RAM box still can't be told to buffer GBs. */
	readonly autoCapBytes: number;
	/** Ceiling on concurrent in-flight windows (0 = auto from healthy endpoints). */
	readonly maxInflight: number;
	/** Fallback in-flight ceiling when maxInflight is auto. */
	readonly autoInflight: number;
	/** RSS ≥ budget × this → under pressure (pause + shrink). */
	readonly pressureFraction: number;
	/** Probe: current memory budget + RSS (injected for tests). */
	budget(): number;
	rss(): number;
}

/** Build the adaptive resource governor. Pure given its injected probes. */
export function makeGovernor(cfg: GovernorConfig): Governor {
	let ewmaBlockBytes = 2048; // seeded; converges to real block size as windows land
	let shrunk = false; // latched once RSS crossed the pressure line, until it recovers

	const baseHighWater = (): number => {
		const auto = Math.min(cfg.budget() * cfg.memFraction, cfg.autoCapBytes);
		const hw = cfg.maxBufferBytes > 0 ? Math.min(cfg.maxBufferBytes, cfg.budget()) : auto;
		return Math.max(1, Math.floor(hw));
	};

	return {
		highWaterBytes(): number {
			const hw = baseHighWater();
			return shrunk ? Math.max(1, Math.floor(hw / 2)) : hw;
		},
		lowWaterBytes(): number {
			return Math.max(1, Math.floor(this.highWaterBytes() / 2));
		},
		maxInflight(): number {
			return cfg.maxInflight > 0 ? cfg.maxInflight : Math.max(1, cfg.autoInflight);
		},
		underPressure(): boolean {
			const over = cfg.rss() >= cfg.budget() * cfg.pressureFraction;
			if (over) shrunk = true;
			else if (cfg.rss() < cfg.budget() * cfg.pressureFraction * 0.8) shrunk = false; // recovered
			return over;
		},
		recordWindow(bytes: number, blockCount: number): void {
			if (blockCount <= 0 || bytes <= 0) return;
			const perBlock = bytes / blockCount;
			ewmaBlockBytes = ewmaBlockBytes * 0.9 + perBlock * 0.1;
		},
		avgBlockBytes(): number {
			return Math.max(1, ewmaBlockBytes);
		}
	};
}
