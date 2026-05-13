/**
 * Tests for CircuitBreaker. Uses an injected fake clock for
 * deterministic cooldown-expiry assertions.
 */

import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '$indexer/fee/circuitBreaker';

/** Mutable fake clock. Tests call tick(ms) to advance. */
function makeFakeClock(startEpoch = 1_700_000_000_000) {
	let now = startEpoch;
	return {
		now: () => now,
		tick: (ms: number) => {
			now += ms;
		},
		set: (ms: number) => {
			now = ms;
		}
	};
}

describe('CircuitBreaker — default state', () => {
	it('fresh key is closed', () => {
		const cb = new CircuitBreaker();
		expect(cb.shouldAttempt('https://x')).toBe(true);
		expect(cb.stateOf('https://x')).toBe('closed');
	});

	it('recordSuccess on fresh key is a no-op', () => {
		const cb = new CircuitBreaker();
		cb.recordSuccess('https://x'); // should not throw or allocate
		expect(cb.stateOf('https://x')).toBe('closed');
	});
});

describe('CircuitBreaker — failure accumulation', () => {
	it('below threshold stays closed', () => {
		const cb = new CircuitBreaker({ failureThreshold: 3 });
		cb.recordFailure('https://x');
		cb.recordFailure('https://x');
		expect(cb.stateOf('https://x')).toBe('closed');
		expect(cb.shouldAttempt('https://x')).toBe(true);
	});

	it('success before threshold resets count', () => {
		const cb = new CircuitBreaker({ failureThreshold: 3 });
		cb.recordFailure('https://x');
		cb.recordFailure('https://x');
		cb.recordSuccess('https://x');
		cb.recordFailure('https://x'); // now 1 failure, not 3
		expect(cb.stateOf('https://x')).toBe('closed');
	});

	it('crossing threshold opens the circuit', () => {
		const clock = makeFakeClock();
		const cb = new CircuitBreaker({
			failureThreshold: 3,
			baseCooldownMs: 30_000,
			now: clock.now
		});
		cb.recordFailure('https://x');
		cb.recordFailure('https://x');
		cb.recordFailure('https://x');
		expect(cb.stateOf('https://x')).toBe('open');
		expect(cb.shouldAttempt('https://x')).toBe(false);
	});
});

describe('CircuitBreaker — cooldown expiry', () => {
	it('open circuit becomes half_open after cooldown elapses', () => {
		const clock = makeFakeClock();
		const cb = new CircuitBreaker({
			failureThreshold: 3,
			baseCooldownMs: 30_000,
			now: clock.now
		});
		for (let i = 0; i < 3; i++) cb.recordFailure('https://x');
		expect(cb.stateOf('https://x')).toBe('open');

		// Just before cooldown: still open.
		clock.tick(29_999);
		expect(cb.stateOf('https://x')).toBe('open');
		expect(cb.shouldAttempt('https://x')).toBe(false);

		// At cooldown expiry: half_open, probe allowed.
		clock.tick(2);
		expect(cb.stateOf('https://x')).toBe('half_open');
		expect(cb.shouldAttempt('https://x')).toBe(true);
	});

	it('half_open + success closes the circuit', () => {
		const clock = makeFakeClock();
		const cb = new CircuitBreaker({
			failureThreshold: 3,
			baseCooldownMs: 30_000,
			now: clock.now
		});
		for (let i = 0; i < 3; i++) cb.recordFailure('https://x');
		clock.tick(31_000);
		expect(cb.stateOf('https://x')).toBe('half_open');
		cb.recordSuccess('https://x');
		expect(cb.stateOf('https://x')).toBe('closed');
	});

	it('half_open + failure reopens with exponential cooldown', () => {
		const clock = makeFakeClock();
		const cb = new CircuitBreaker({
			failureThreshold: 3,
			baseCooldownMs: 30_000,
			maxCooldownMs: 900_000,
			now: clock.now
		});
		for (let i = 0; i < 3; i++) cb.recordFailure('https://x');
		clock.tick(31_000); // enter half_open
		cb.recordFailure('https://x'); // 4th failure
		expect(cb.stateOf('https://x')).toBe('open');
		// New cooldown should be 2*base = 60s.
		clock.tick(59_000);
		expect(cb.stateOf('https://x')).toBe('open');
		clock.tick(2_000);
		expect(cb.stateOf('https://x')).toBe('half_open');
	});

	it('backoff doubles each subsequent failure', () => {
		const clock = makeFakeClock();
		const cb = new CircuitBreaker({
			failureThreshold: 3,
			baseCooldownMs: 30_000,
			maxCooldownMs: 1_000_000_000, // effectively no cap
			now: clock.now
		});
		// 3 failures → open with 30s cooldown.
		for (let i = 0; i < 3; i++) cb.recordFailure('https://x');
		// Step through probe → fail cycles.
		// 4th failure → 60s cooldown (base * 2^1).
		clock.tick(31_000);
		cb.recordFailure('https://x');
		clock.tick(59_000);
		expect(cb.stateOf('https://x')).toBe('open');
		clock.tick(2_000);
		expect(cb.stateOf('https://x')).toBe('half_open');
		// 5th failure → 120s cooldown (base * 2^2).
		cb.recordFailure('https://x');
		clock.tick(119_000);
		expect(cb.stateOf('https://x')).toBe('open');
		clock.tick(2_000);
		expect(cb.stateOf('https://x')).toBe('half_open');
	});

	it('cooldown caps at maxCooldownMs', () => {
		const clock = makeFakeClock();
		const cb = new CircuitBreaker({
			failureThreshold: 3,
			baseCooldownMs: 30_000,
			maxCooldownMs: 60_000, // low cap for testable result
			now: clock.now
		});
		for (let i = 0; i < 10; i++) cb.recordFailure('https://x');
		// Even after 10 failures, cooldown shouldn't exceed 60s.
		clock.tick(59_999);
		expect(cb.stateOf('https://x')).toBe('open');
		clock.tick(2);
		expect(cb.stateOf('https://x')).toBe('half_open');
	});
});

describe('CircuitBreaker — key isolation', () => {
	it('opening key A does not affect key B', () => {
		const cb = new CircuitBreaker({ failureThreshold: 3 });
		for (let i = 0; i < 3; i++) cb.recordFailure('https://a');
		expect(cb.stateOf('https://a')).toBe('open');
		expect(cb.stateOf('https://b')).toBe('closed');
		expect(cb.shouldAttempt('https://b')).toBe(true);
	});

	it('independent cooldowns per key', () => {
		const clock = makeFakeClock();
		const cb = new CircuitBreaker({
			failureThreshold: 3,
			baseCooldownMs: 30_000,
			now: clock.now
		});
		for (let i = 0; i < 3; i++) cb.recordFailure('https://a');
		clock.tick(15_000);
		for (let i = 0; i < 3; i++) cb.recordFailure('https://b');
		// A should expire first (started 15s earlier).
		clock.tick(16_000); // total 31s for A, 16s for B
		expect(cb.stateOf('https://a')).toBe('half_open');
		expect(cb.stateOf('https://b')).toBe('open');
	});
});

describe('CircuitBreaker — snapshot', () => {
	it('snapshot reflects current state', () => {
		const cb = new CircuitBreaker({ failureThreshold: 3 });
		cb.recordFailure('https://a');
		cb.recordFailure('https://b');
		cb.recordFailure('https://b');
		cb.recordFailure('https://b');
		const snap = cb.snapshot();
		expect(snap.size).toBe(2);
		expect(snap.get('https://a')?.consecutiveFailures).toBe(1);
		expect(snap.get('https://b')?.consecutiveFailures).toBe(3);
	});

	it('snapshot is a copy — mutating it does not affect breaker', () => {
		const cb = new CircuitBreaker();
		cb.recordFailure('https://x');
		const snap = cb.snapshot() as Map<string, unknown>;
		snap.set('https://fake', {});
		expect(cb.snapshot().has('https://fake')).toBe(false);
	});
});
