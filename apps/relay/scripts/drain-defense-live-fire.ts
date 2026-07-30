/**
 * Morphit relay — drain-defense live-fire simulation.
 *
 * Not a vitest suite. A standalone scenario runner that
 * exercises the six drain-defense modules in concert and
 * asserts expected behavior under attack-shaped traffic
 * patterns. Useful as:
 *
 *   - A sanity check after refactors ("does the defense still
 *     work end-to-end?")
 *   - A reference implementation showing how the pieces
 *     compose (ceiling + limiter + invite + altcha)
 *   - A dry-run before deploying to production: run this,
 *     read the output, confirm the behavior matches your
 *     expectations
 *
 * Usage (from apps/relay directory):
 *   tsx scripts/drain-defense-live-fire.ts
 *
 * Exits 0 on all-pass, 1 on any scenario failure.
 *
 * The scenarios use direct module imports and the wall-clock
 * (`Date.now()` in `GlobalDailyCeiling.maybeRollover()`).  They
 * do NOT hit a real relay or database — this is about
 * validating the module-level logic, not I/O paths.
 *
 * KNOWN TIMING RACE (Audit Part 25, RESOLVED Part 26): the
 * composition scenario originally constructed a fresh
 * `GlobalDailyCeiling` with no clock injection and ran 10
 * `recordSuccess()` calls in sequence.  When the run straddled
 * UTC midnight, `maybeRollover()` reset the count to zero
 * mid-loop and the assertion `currentCount() === 10` failed
 * (the chain of timestamps in the Part 24 failure log
 * pinpointed this — the alert fired at exactly
 * `2026-05-04T00:00:00.000Z`, a midnight rollover).
 *
 * Part 25 worked around this by skipping the composition
 * scenario when within ±90 seconds of UTC midnight.  Part 26
 * adds a real fix: `GlobalDailyCeiling` and `Limiter` both
 * accept an optional `Clock` parameter, and the smoke now
 * passes a `ManualClock` pinned to a known mid-day UTC time.
 * The race is gone; the test runs deterministically every
 * time, regardless of CI scheduling or developer wall clock.
 */

import { GlobalDailyCeiling, type CeilingReachedAlert } from '../src/policy/globalDailyCeiling.ts';
import { Limiter } from '../src/middleware/ratelimit.ts';
import { InviteTokenService } from '../src/policy/inviteToken.ts';
import { AltchaService } from '../src/policy/altcha.ts';
import { ManualClock } from '../src/policy/clock.ts';
import { judgeAnomaly } from '../../indexer/src/indexer/signupAnomalyProbe.ts';
import { createHash } from 'node:crypto';

// ─── harness ──────────────────────────────────────────────────

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => {
				console.log(`  ✓ ${name}`);
			},
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

function section(title: string): void {
	console.log(`\n── ${title} `.padEnd(60, '─'));
}

// ─── layer 2: global daily ceiling ────────────────────────────

section('Layer 2 — global daily ceiling');

await scenario('canAccept: fresh bucket, count=0 → true', () => {
	const c = new GlobalDailyCeiling(50);
	assert(c.canAccept() === true, `expected true, got ${c.canAccept()}`);
	assert(c.currentCount() === 0, 'fresh count should be 0');
	assert(c.remainingToday() === 50, 'fresh remaining should be 50');
});

await scenario('recordSuccess increments count and hour', () => {
	const c = new GlobalDailyCeiling(50);
	c.recordSuccess();
	c.recordSuccess();
	assert(c.currentCount() === 2, `expected 2, got ${c.currentCount()}`);
	assert(c.currentHourCount() === 2, 'current hour should be 2');
	assert(c.remainingToday() === 48, 'remaining should be 48');
});

await scenario('canAccept returns false once ceiling hit', () => {
	const c = new GlobalDailyCeiling(3);
	c.recordSuccess();
	c.recordSuccess();
	c.recordSuccess();
	assert(c.canAccept() === false, 'at-ceiling should reject');
	assert(c.remainingToday() === 0, 'remaining should be 0 at ceiling');
});

await scenario('CEILING_REACHED alert fires exactly once', () => {
	const alerts: CeilingReachedAlert[] = [];
	const c = new GlobalDailyCeiling(2, (a) => alerts.push(a));
	c.recordSuccess(); // count=1
	c.recordSuccess(); // count=2 → ceiling hit → alert
	c.recordSuccess(); // count=3 → over, no second alert
	assert(alerts.length === 1, `expected 1 alert, got ${alerts.length}`);
	assert(alerts[0]!.kind === 'CEILING_REACHED', 'wrong alert kind');
	assert(alerts[0]!.ceiling === 2, 'ceiling recorded wrong');
});

// ─── layer 3: per-IP spacing ──────────────────────────────────

section('Layer 3 — per-IP spacing (daily cap + min-gap)');

await scenario('first allow() on fresh IP succeeds', () => {
	const l = new Limiter(2, 86_400_000); // 2/day
	assert(l.allow('1.2.3.4') === true, 'first allow should succeed');
});

await scenario('allow() rejects after daily cap', () => {
	const l = new Limiter(2, 86_400_000);
	l.allow('1.2.3.4');
	l.allow('1.2.3.4');
	assert(l.allow('1.2.3.4') === false, 'third allow within window should fail');
});

await scenario('allowWithSpacing: spacing blocks within cooldown', () => {
	const l = new Limiter(5, 86_400_000);
	const r1 = l.allowWithSpacing('1.2.3.4', 60 * 60 * 1000); // 60-min gap
	assert(r1.allowed === true, 'first call should allow');
	const r2 = l.allowWithSpacing('1.2.3.4', 60 * 60 * 1000);
	assert(!r2.allowed, 'second call within 60min should reject');
	assert(
		!r2.allowed && r2.reason === 'spacing',
		`expected spacing reason, got ${!r2.allowed ? r2.reason : 'allowed'}`
	);
	assert(
		!r2.allowed && r2.reason === 'spacing' && r2.retryAfterMs > 0,
		'retryAfterMs should be positive'
	);
});

await scenario('allowWithSpacing: daily cap exhaustion reports quota', () => {
	const l = new Limiter(1, 86_400_000); // 1/day
	const r1 = l.allowWithSpacing('1.2.3.4', 0); // no spacing
	assert(r1.allowed === true, 'first should allow');
	const r2 = l.allowWithSpacing('1.2.3.4', 0);
	assert(
		!r2.allowed && r2.reason === 'quota_exhausted',
		`expected quota_exhausted, got ${!r2.allowed ? r2.reason : 'allowed'}`
	);
});

// ─── layer 4: signed invite tokens ────────────────────────────

section('Layer 4 — signed invite tokens');

await scenario('issue → verify happy path', () => {
	const svc = new InviteTokenService({ ttlMs: 60_000 });
	try {
		const ip = '203.0.113.5';
		const { token } = svc.issue(ip);
		const res = svc.verify(token, ip);
		assert(res.ok === true, `verify should succeed: ${res.ok ? 'ok' : res.code}`);
	} finally {
		svc.close();
	}
});

await scenario('IP mismatch rejected', () => {
	const svc = new InviteTokenService({ ttlMs: 60_000 });
	try {
		const { token } = svc.issue('203.0.113.5');
		const res = svc.verify(token, '198.51.100.1');
		assert(
			!res.ok && res.code === 'invite_ip_mismatch',
			`expected invite_ip_mismatch, got ${res.ok ? 'ok' : res.code}`
		);
	} finally {
		svc.close();
	}
});

await scenario('replay after consume rejected', () => {
	const svc = new InviteTokenService({ ttlMs: 60_000 });
	try {
		const ip = '203.0.113.5';
		const { token } = svc.issue(ip);
		const first = svc.verify(token, ip);
		assert(first.ok === true, 'first verify should succeed');
		svc.consume(first.payload);
		const replay = svc.verify(token, ip);
		assert(
			!replay.ok && replay.code === 'invite_already_used',
			`expected invite_already_used, got ${replay.ok ? 'ok' : replay.code}`
		);
	} finally {
		svc.close();
	}
});

await scenario('malformed token rejected', () => {
	const svc = new InviteTokenService({ ttlMs: 60_000 });
	try {
		const res = svc.verify('garbage.notbase64', '1.1.1.1');
		assert(!res.ok, 'malformed should fail');
	} finally {
		svc.close();
	}
});

await scenario('tampered signature rejected', () => {
	const svc = new InviteTokenService({ ttlMs: 60_000 });
	try {
		const ip = '203.0.113.5';
		const { token } = svc.issue(ip);
		// Flip a char in the signature portion (the second '.'-separated segment).
		//
		// Tamper FIRST char of the signature, NOT last.  The HMAC-SHA-256
		// signature is 32 bytes = 43 base64url chars; the last char's last
		// 2 bits are unused padding (256 sig bits ÷ 6 bits/char rounded up
		// = 43 chars carrying 258 bits, so the trailing 2 bits decode to
		// nothing).  Changing the last char to a value within its 4-char
		// "padding-equivalent" set yields a tampered string that decodes
		// to the IDENTICAL 32-byte buffer — verify() (correctly) accepts
		// it.  Empirically this hits ~6% of the time on random sigs.
		// First-char tampering changes a meaningful bit and is reliably
		// rejected by HMAC verify on every input.
		const parts = token.split('.');
		assert(parts.length === 2, `expected 2 parts, got ${parts.length}: ${token.slice(0, 40)}…`);
		const sig = parts[1]!;
		const tampered = parts[0] + '.' + (sig.at(0) === 'A' ? 'B' : 'A') + sig.slice(1);
		const res = svc.verify(tampered, ip);
		assert(!res.ok, 'tampered sig should fail');
	} finally {
		svc.close();
	}
});

// ─── layer 5: altcha PoW ──────────────────────────────────────

section('Layer 5 — Altcha PoW challenge/solution');

await scenario('issue + solve + verify round-trip', () => {
	const svc = new AltchaService({ maxnumber: 100_000 });
	try {
		const challenge = svc.issue();
		const n = bruteForce(challenge.salt, challenge.challenge, challenge.maxnumber);
		assert(n !== -1, 'expected to find solution');
		const solution = {
			algorithm: 'SHA-256' as const,
			salt: challenge.salt,
			challenge: challenge.challenge,
			signature: challenge.signature,
			number: n
		};
		const res = svc.verify(solution);
		assert(res.ok === true, `verify should succeed: ${res.ok ? 'ok' : res.code}`);
	} finally {
		svc.close();
	}
});

await scenario('replay rejected (single-use)', () => {
	const svc = new AltchaService({ maxnumber: 100_000 });
	try {
		const challenge = svc.issue();
		const n = bruteForce(challenge.salt, challenge.challenge, challenge.maxnumber);
		const solution = {
			algorithm: 'SHA-256' as const,
			salt: challenge.salt,
			challenge: challenge.challenge,
			signature: challenge.signature,
			number: n
		};
		svc.verify(solution);
		const replay = svc.verify(solution);
		assert(
			!replay.ok && replay.code === 'altcha_replayed',
			`expected altcha_replayed, got ${replay.ok ? 'ok' : replay.code}`
		);
	} finally {
		svc.close();
	}
});

await scenario('wrong number rejected', () => {
	const svc = new AltchaService({ maxnumber: 100_000 });
	try {
		const challenge = svc.issue();
		const n = bruteForce(challenge.salt, challenge.challenge, challenge.maxnumber);
		const wrong = (n + 7) % challenge.maxnumber; // almost certainly wrong
		const solution = {
			algorithm: 'SHA-256' as const,
			salt: challenge.salt,
			challenge: challenge.challenge,
			signature: challenge.signature,
			number: wrong
		};
		const res = svc.verify(solution);
		assert(!res.ok, 'wrong N should fail');
	} finally {
		svc.close();
	}
});

// ─── layer 6: anomaly detector ────────────────────────────────

section('Layer 6 — anomaly heuristic under realistic scenarios');

await scenario('normal busy day: no recommendation', () => {
	const verdict = judgeAnomaly({
		enabled: true,
		daily_ceiling: 50,
		successful_today: 30,
		current_hour_count: 3,
		peak_hour_count: 4
	});
	assert(verdict.recommendKillSwitch === false, 'normal day should not recommend');
	assert(verdict.probed === true, 'probed should be true');
});

await scenario('drain in progress: 1/3-ceiling trigger', () => {
	const verdict = judgeAnomaly({
		enabled: true,
		daily_ceiling: 50,
		successful_today: 17,
		current_hour_count: 17,
		peak_hour_count: 17
	});
	assert(verdict.recommendKillSwitch === true, '17 in hour vs 50/day should recommend');
	assert(verdict.message.includes('ceiling'), 'message should cite ceiling reasoning');
});

await scenario('peak-doubling trigger: quiet day with sudden spike', () => {
	const verdict = judgeAnomaly({
		enabled: true,
		daily_ceiling: 200, // high ceiling, so 1/3 trigger wouldn't fire
		successful_today: 15,
		current_hour_count: 7,
		peak_hour_count: 3
	});
	assert(verdict.recommendKillSwitch === true, '7 vs peak 3 should recommend');
	assert(verdict.message.toLowerCase().includes('peak'), 'message should cite peak reasoning');
});

await scenario('small spike, below 5/hr, no recommendation', () => {
	const verdict = judgeAnomaly({
		enabled: true,
		daily_ceiling: 200,
		successful_today: 10,
		current_hour_count: 4,
		peak_hour_count: 1
	});
	assert(verdict.recommendKillSwitch === false, '4 in hour is below the ≥5 floor');
});

await scenario('already-disabled relay: no recommendation', () => {
	const verdict = judgeAnomaly({
		enabled: false,
		daily_ceiling: 50,
		successful_today: 100, // way over, but off already
		current_hour_count: 50,
		peak_hour_count: 50
	});
	assert(verdict.recommendKillSwitch === false, 'already-off should not recommend');
	assert(verdict.message.toLowerCase().includes('already'), 'should note already off');
});

await scenario('tiny-ceiling edge case: 1/3 floor at 5 signups', () => {
	// Ceiling=6, naive 1/3 = 2. But the floor of 5 means
	// anomaly doesn't fire until 5/hour. Otherwise every low-
	// traffic hour on a tiny-ceiling instance would nag.
	const v1 = judgeAnomaly({
		enabled: true,
		daily_ceiling: 6,
		successful_today: 3,
		current_hour_count: 3,
		peak_hour_count: 3
	});
	assert(v1.recommendKillSwitch === false, '3 signups should not alert even on small ceiling');

	const v2 = judgeAnomaly({
		enabled: true,
		daily_ceiling: 6,
		successful_today: 5,
		current_hour_count: 5,
		peak_hour_count: 5
	});
	assert(v2.recommendKillSwitch === true, '5 signups against 6-ceiling should alert');
});

// ─── composition: simulated attack end-to-end ─────────────────

section('Composition — realistic attack pattern');

// Midnight-rollover guard: skip the composition scenario when the
// run is within 90 seconds of UTC midnight on either side.
// `GlobalDailyCeiling.maybeRollover()` consults `Date.now()` and
// resets the count to zero on a rollover; if that fires
// mid-scenario, the assertions below all fail.  The race is
// rare (1 in ~960 UTC minutes), the underlying behavior is
// correct (production rollovers ARE meant to reset the count),
// and refactoring the module to accept an injected clock would
// be a wider change than this audit warrants.  We skip
// deterministically instead.
// Item 6 (Audit Part 26) — the composition scenario is now
// deterministic via injected clocks.  GlobalDailyCeiling and
// Limiter both accept an optional `Clock`; we pass a
// `ManualClock` pinned to a known mid-day UTC time so the
// ceiling's `maybeRollover()` can never fire mid-loop
// regardless of when this smoke runs (CI runner schedule,
// developer's local clock, etc.).
//
// This replaces the 90-second-each-side midnight skip from
// Part 25, which was a workaround for the clock dependency
// that we've now actually fixed.  The skip code is gone; the
// scenario runs every time, deterministically.
await scenario('drain attempt: limiter + ceiling compose', () => {
	const clock = new ManualClock('2026-05-15T12:00:00Z');
	const ceiling = new GlobalDailyCeiling(10, undefined, null, clock);
	const limiter = new Limiter(2, 86_400_000, clock); // 2/day per IP
	const attackerIps = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'];
	let successes = 0;
	let rateLimited = 0;
	let atCeiling = 0;
	// Attacker cycles through 5 IPs trying to signup until
	// something fails.
	for (let attempt = 0; attempt < 30; attempt++) {
		const ip = attackerIps[attempt % attackerIps.length]!;
		if (!ceiling.canAccept()) {
			atCeiling++;
			continue;
		}
		if (!limiter.allow(ip)) {
			rateLimited++;
			continue;
		}
		ceiling.recordSuccess();
		successes++;
	}
	// 5 IPs × 2/day = 10 signups before rate-limiting. Ceiling
	// is also 10, so limiter gates this attack first. After
	// successes=10, every remaining attempt hits either the
	// rate limit (IP already at 2) OR the ceiling. The exact
	// split depends on ordering, but both layers should fire.
	assert(successes === 10, `expected 10 successes (5 IPs × 2/day), got ${successes}`);
	assert(rateLimited + atCeiling === 20, `rest should be blocked, got ${rateLimited + atCeiling}`);
	// Demonstrate compounding: ceiling caps the damage even if
	// the limiter is somehow bypassed.
	assert(
		ceiling.currentCount() === 10,
		`ceiling should cap successful drain at 10, got ${ceiling.currentCount()}`
	);
});

// ─── summary ──────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}

// ─── helpers ──────────────────────────────────────────────────

function bruteForce(salt: string, target: string, maxnumber: number): number {
	for (let n = 0; n <= maxnumber; n++) {
		const h = createHash('sha256')
			.update(salt + n.toString())
			.digest('hex');
		if (h === target) return n;
	}
	return -1;
}
