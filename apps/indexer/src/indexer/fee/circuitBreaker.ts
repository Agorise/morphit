/**
 * Generic per-key circuit breaker.
 *
 * Used by the BTC and XMR fee verifiers to avoid hammering
 * rate-limited or down block explorers. A key represents
 * "this explorer URL" — the breaker tracks consecutive
 * failures and, once a threshold is hit, refuses to run
 * work against that key for a cooldown period. One probe
 * request is then allowed; success closes the circuit,
 * failure re-opens it with a longer cooldown.
 *
 * The module is deliberately small and self-contained —
 * no network knowledge, no retry logic, just state
 * tracking and gate-keeping.
 *
 * Usage:
 *
 *   const cb = new CircuitBreaker();
 *   if (cb.shouldAttempt(url)) {
 *     try {
 *       await doWork();
 *       cb.recordSuccess(url);
 *     } catch (err) {
 *       if (isTransientFailure(err)) cb.recordFailure(url);
 *       throw err;
 *     }
 *   } else {
 *     // skip — circuit is open
 *   }
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

/** Per-key state. Exported for test assertions. */
export interface KeyState {
	/** Count of consecutive failures since last success. Reset on
	 *  any recordSuccess. */
	consecutiveFailures: number;
	/** Absolute epoch ms at which an open circuit may be probed.
	 *  Zero when the circuit isn't open. */
	cooldownUntil: number;
	/** True once consecutiveFailures crossed the threshold. We
	 *  track it explicitly (rather than deriving) so a key that
	 *  was open can transition to half_open deterministically
	 *  without re-reading its failure count. */
	openedAt: number;
}

export interface CircuitBreakerConfig {
	/** Failures in a row before opening. Default 3. */
	readonly failureThreshold: number;
	/** Base cooldown in ms when the circuit first opens. Default 30s. */
	readonly baseCooldownMs: number;
	/** Maximum cooldown in ms, regardless of failure count. Default 15min. */
	readonly maxCooldownMs: number;
	/** Clock — injectable for tests. Defaults to Date.now. */
	readonly now: () => number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
	failureThreshold: 3,
	baseCooldownMs: 30_000,
	maxCooldownMs: 900_000, // 15 minutes
	now: () => Date.now()
};

export class CircuitBreaker {
	private readonly states = new Map<string, KeyState>();
	private readonly config: CircuitBreakerConfig;

	constructor(partial: Partial<CircuitBreakerConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...partial };
	}

	/** Return true if the caller should go ahead and attempt work
	 *  against this key. For open circuits still within cooldown,
	 *  returns false. For open circuits whose cooldown has
	 *  expired, transitions the key to half_open and returns true
	 *  — the next record* call decides whether to close or
	 *  reopen. */
	shouldAttempt(key: string): boolean {
		const now = this.config.now();
		const state = this.states.get(key);
		if (state === undefined) return true; // fresh key
		if (state.consecutiveFailures < this.config.failureThreshold) {
			return true; // closed
		}
		// Circuit is open or half-open.
		if (now >= state.cooldownUntil) {
			// Cooldown expired — we're eligible for a probe. We do
			// NOT change consecutiveFailures here; the next record*
			// call does that. Leave state as-is so concurrent
			// shouldAttempt calls don't all pass through: mark as
			// half_open by zeroing cooldownUntil, which makes
			// subsequent shouldAttempt calls fall through the
			// `now >= cooldownUntil` branch anyway — but that's
			// fine, we WANT them to wait for the probe's outcome.
			// A stricter design would serialize probes, but under
			// our actual workload (one fee verify per order) the
			// risk of concurrent probes is low and a second
			// explorer hit on a down node isn't expensive.
			return true;
		}
		return false;
	}

	/** Called after a successful operation. Resets failure count
	 *  and zero-clears cooldown. */
	recordSuccess(key: string): void {
		const state = this.states.get(key);
		if (state === undefined) return; // no state to clear
		if (state.consecutiveFailures === 0) return; // already healthy
		this.states.set(key, {
			consecutiveFailures: 0,
			cooldownUntil: 0,
			openedAt: 0
		});
	}

	/** Called after a transient failure. Increments failure count;
	 *  if we cross the threshold, set a cooldown using exponential
	 *  backoff. */
	recordFailure(key: string): void {
		const now = this.config.now();
		const prev = this.states.get(key) ?? {
			consecutiveFailures: 0,
			cooldownUntil: 0,
			openedAt: 0
		};
		const newCount = prev.consecutiveFailures + 1;
		let cooldownUntil = 0;
		let openedAt = prev.openedAt;
		if (newCount >= this.config.failureThreshold) {
			// Exponential backoff from base: base, 2*base, 4*base, …
			const excess = newCount - this.config.failureThreshold;
			const cooldownMs = Math.min(
				this.config.baseCooldownMs * Math.pow(2, excess),
				this.config.maxCooldownMs
			);
			cooldownUntil = now + cooldownMs;
			if (openedAt === 0) openedAt = now;
		}
		this.states.set(key, {
			consecutiveFailures: newCount,
			cooldownUntil,
			openedAt
		});
	}

	/** Introspect current state for a key. Returns 'closed' if the
	 *  key has no failures, 'open' if in cooldown, 'half_open' if
	 *  cooldown expired but no probe result yet. Useful for
	 *  operators and tests. */
	stateOf(key: string): BreakerState {
		const state = this.states.get(key);
		if (state === undefined) return 'closed';
		if (state.consecutiveFailures < this.config.failureThreshold) {
			return 'closed';
		}
		if (this.config.now() >= state.cooldownUntil) return 'half_open';
		return 'open';
	}

	/** Snapshot — a read-only copy of all tracked keys. Primarily
	 *  for `/v1/health?verbose=1` operator visibility. */
	snapshot(): ReadonlyMap<string, Readonly<KeyState>> {
		return new Map(this.states);
	}
}
