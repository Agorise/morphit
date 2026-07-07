#!/usr/bin/env tsx
/**
 * login-pairing-registry-smoke (ADR-0022).
 *
 * Exercises the in-memory PairingRegistry that backs the
 * /v1/login-pairing/:pid/deliver and /:pid/wait endpoints.
 * Validates state-machine semantics:
 *
 *   - Deliver-then-wait round-trip
 *   - Wait-then-deliver round-trip (callback hand-off)
 *   - Race between setWaiter and deliver (fired_immediately)
 *   - Single-shot: deliver-then-deliver same pid → already_delivered
 *   - Single-subscription: wait-then-wait same pid → over_capacity
 *   - Cancellation: cancelWait clears entry without bundle
 *   - Cancellation preserves entry that has bundle parked
 *   - Hard-cap: 10001th entry → over_capacity
 *   - TTL: sweep evicts expired entries
 *   - TTL: sweep notifies waiters with empty bundle
 */

import { PairingRegistry } from '../src/api/loginPairing.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function expect(actual: unknown, expected: unknown, label = ''): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label ? label + ': ' : ''}expected ${e}, got ${a}`);
	}
}

console.log('login-pairing-registry-smoke (ADR-0022):\n');

// ─── Deliver-then-wait (deliver first) ────────────────────

scenario('deliver-then-wait: register returns immediate', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = 'a'.repeat(64);
		expect(r.deliver(pid, '{"hello":"world"}', now), 'ok');
		const reg = r.register(pid, now);
		if (reg.kind !== 'immediate') throw new Error(`expected immediate, got ${reg.kind}`);
		expect(reg.bundleJson, '{"hello":"world"}');
		// Entry should be cleaned up after immediate hand-off.
		expect(r.size(), 0);
	} finally {
		r.close();
	}
});

// ─── Wait-then-deliver (wait first) ───────────────────────

scenario('wait-then-deliver: callback fires; entry cleaned up', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = 'b'.repeat(64);
		const reg = r.register(pid, now);
		if (reg.kind !== 'waiting') throw new Error(`expected waiting, got ${reg.kind}`);
		let received: string | null = null;
		const status = r.setWaiter(pid, (b) => {
			received = b;
		});
		expect(status, 'installed');
		expect(r.size(), 1);
		// Now deliver — callback should fire synchronously.
		expect(r.deliver(pid, '{"signed":"bundle"}', now), 'ok');
		expect(received, '{"signed":"bundle"}');
		expect(r.size(), 0);
	} finally {
		r.close();
	}
});

// ─── Race: deliver lands BETWEEN register and setWaiter ───

scenario('race: deliver between register/setWaiter → fired_immediately', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = 'c'.repeat(64);
		const reg = r.register(pid, now);
		if (reg.kind !== 'waiting') throw new Error(`expected waiting`);
		// Deliver lands here (simulating server-side concurrency).
		expect(r.deliver(pid, '{"raced":"in"}', now), 'ok');
		// Now setWaiter — should fire immediately.
		let received: string | null = null;
		const status = r.setWaiter(pid, (b) => {
			received = b;
		});
		expect(status, 'fired_immediately');
		expect(received, '{"raced":"in"}');
		expect(r.size(), 0);
	} finally {
		r.close();
	}
});

// ─── Single-shot ──────────────────────────────────────────

scenario('deliver-then-deliver-same-pid → already_delivered', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = 'd'.repeat(64);
		expect(r.deliver(pid, '{"first":"bundle"}', now), 'ok');
		expect(r.deliver(pid, '{"second":"bundle"}', now), 'already_delivered');
		// Original bundle still parked.
		const reg = r.register(pid, now);
		if (reg.kind !== 'immediate') throw new Error(`expected immediate`);
		expect(reg.bundleJson, '{"first":"bundle"}');
	} finally {
		r.close();
	}
});

// ─── Single-subscription ──────────────────────────────────

scenario('wait-then-wait-same-pid → over_capacity', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = 'e'.repeat(64);
		const reg1 = r.register(pid, now);
		expect(reg1.kind, 'waiting');
		// Don't install a waiter — but a SECOND register attempt
		// should still be rejected.
		const reg2 = r.register(pid, now);
		expect(reg2.kind, 'over_capacity');
	} finally {
		r.close();
	}
});

// ─── Cancellation ─────────────────────────────────────────

scenario('cancelWait removes a no-bundle entry', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = 'f'.repeat(64);
		r.register(pid, now);
		expect(r.size(), 1);
		r.cancelWait(pid);
		expect(r.size(), 0);
	} finally {
		r.close();
	}
});

scenario('cancelWait preserves an entry with parked bundle', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = '0'.repeat(64);
		expect(r.deliver(pid, '{"parked":"bundle"}', now), 'ok');
		r.cancelWait(pid); // No effect when bundle is parked.
		expect(r.size(), 1);
		// Bundle still retrievable.
		const reg = r.register(pid, now);
		if (reg.kind !== 'immediate') throw new Error('bundle was lost');
	} finally {
		r.close();
	}
});

// ─── Hard cap ─────────────────────────────────────────────

scenario('over-capacity: 10001st entry → over_capacity', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		// Fill to capacity (10000).
		for (let i = 0; i < 10000; i++) {
			const pid = i.toString(16).padStart(64, '0');
			expect(r.deliver(pid, '{"i":' + i + '}', now), 'ok');
		}
		expect(r.size(), 10000);
		// 10001st must reject.
		expect(r.deliver('f'.repeat(64), '{}', now), 'over_capacity');
		expect(r.register('e'.repeat(64), now).kind, 'over_capacity');
	} finally {
		r.close();
	}
});

// ─── TTL / sweep ──────────────────────────────────────────

scenario('sweep evicts expired entries', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = '1'.repeat(64);
		r.deliver(pid, '{}', now);
		expect(r.size(), 1);
		// Advance time past TTL (5 min).
		r.sweep(now + 5 * 60_000 + 1);
		expect(r.size(), 0);
	} finally {
		r.close();
	}
});

scenario('sweep notifies waiter with empty string when expiring', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = '2'.repeat(64);
		r.register(pid, now);
		let got: string | null = null;
		r.setWaiter(pid, (b) => {
			got = b;
		});
		r.sweep(now + 5 * 60_000 + 1);
		expect(got, '');
		expect(r.size(), 0);
	} finally {
		r.close();
	}
});

// ─── Multiple pids, independent state ─────────────────────

scenario('independent pids: deliver one, register another', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pidA = '3'.repeat(64);
		const pidB = '4'.repeat(64);
		r.deliver(pidA, '{"for":"A"}', now);
		const regB = r.register(pidB, now);
		expect(regB.kind, 'waiting');
		// Pid A still parked, pid B waiting.
		expect(r.size(), 2);
		// Deliver B; only B fires.
		let bGot: string | null = null;
		r.setWaiter(pidB, (b) => {
			bGot = b;
		});
		r.deliver(pidB, '{"for":"B"}', now);
		expect(bGot, '{"for":"B"}');
		// Pid A still has parked bundle.
		expect(r.size(), 1);
		const regA = r.register(pidA, now);
		if (regA.kind !== 'immediate') throw new Error('A bundle missing');
		expect(regA.bundleJson, '{"for":"A"}');
	} finally {
		r.close();
	}
});

// ─── setWaiter on missing pid (post-eviction) ────────────

scenario('setWaiter on swept pid → gone', () => {
	const r = new PairingRegistry();
	try {
		const now = 1_000_000;
		const pid = '5'.repeat(64);
		r.register(pid, now);
		// Sweep evicts before waiter installs.
		r.sweep(now + 5 * 60_000 + 1);
		const status = r.setWaiter(pid, () => {});
		expect(status, 'gone');
	} finally {
		r.close();
	}
});

console.log(
	`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
);
process.exit(failures === 0 ? 0 : 1);
