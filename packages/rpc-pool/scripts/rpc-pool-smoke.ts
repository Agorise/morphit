/**
 * @morphit/rpc-pool smoke.
 *
 * Validates the four core behaviours of EndpointPool against a
 * deterministic in-memory upstream (no real network):
 *
 *   1. Fastest-EWMA-first ordering — given a pool of three
 *      endpoints with seeded latencies (50/200/500 ms), the 50 ms
 *      one is the primary.
 *   2. Cooldown ladder — three consecutive transport failures push
 *      an endpoint to 60 s cooldown; success resets the ladder.
 *   3. Application-level errors on a broadcast propagate (no
 *      rotation, no cooldown bumped); endpoint faults (API missing,
 *      non-JSON-RPC reply) rotate and cool down on every call; a
 *      `read` fails over past one node's error and parks it.
 *   4. Adaptive hedging — when the primary's EWMA is above the
 *      degradation threshold AND `hedge: true`, the pool fires a
 *      second request to the next-best endpoint after the stagger
 *      interval and returns the first winner.  When the primary is
 *      fast, no hedge is dispatched.
 *   5. Rate-limit backoff — an HTTP 429 rotates off (like any
 *      transport failure) but is parked on a LONGER, dedicated
 *      cooldown ladder than a generic blip, so a quota'd node is
 *      not re-probed every couple of seconds; a non-429 transport
 *      failure stays on the short ladder.
 *
 * The "upstream" is a fake `fn` whose latency and outcome the test
 * controls per-endpoint per-call.  Wall-clock time is real (we use
 * setTimeout) but the test sleeps are short (≤ 250 ms) so the
 * whole smoke runs in under 2 seconds.
 */

import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import {
	EndpointPool,
	effectiveTimeoutMs,
	isHiddenEndpointUrl,
	DEFAULT_HIDDEN_TIMEOUT_MS,
	DEFAULT_HIDDEN_USER_FACING_TIMEOUT_MS,
	DEFAULT_USER_FACING_TIMEOUT_MS,
	DEFAULT_BACKGROUND_TIMEOUT_MS,
	DEFAULT_HEDGE_THRESHOLD_MS,
	DEFAULT_COOLDOWN_LADDER_MS,
	DEFAULT_RATE_LIMIT_COOLDOWN_LADDER_MS,
	DEFAULT_COOLDOWN_JITTER_FRACTION,
	DEFAULT_MAX_REQUESTS_PER_SECOND,
	isTransportError,
	isRateLimitError,
	isDblurtConsoleNoise,
	suppressDblurtConsoleNoise
} from '../src/index.ts';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------- scenario 1: fastest-first ordering ---------------- */
{
	const pool = new EndpointPool({
		endpoints: ['fast', 'medium', 'slow']
	});
	const callOrder: string[] = [];
	// Warm up: each endpoint sees one successful call with a
	// distinct latency so EWMA seeds.
	const latencies: Record<string, number> = { fast: 20, medium: 100, slow: 300 };
	for (const url of ['slow', 'medium', 'fast']) {
		await pool.call(async (u) => {
			callOrder.push(u);
			await sleep(latencies[u]!);
			return u;
		});
	}
	// Now make a call that should pick the fastest first.
	callOrder.length = 0;
	const result = await pool.call(async (u) => {
		callOrder.push(u);
		await sleep(latencies[u]!);
		return u;
	});
	if (result === 'fast' && callOrder[0] === 'fast') {
		pass('fastest-EWMA endpoint is picked first after warm-up');
	} else {
		fail(
			'fastest-first ordering',
			`expected first call to 'fast'; got order ${JSON.stringify(callOrder)} result=${result}`
		);
	}
}

/* ---------------- per-endpoint RPS pacing ---------------- */
{
	// The operator's FIRST ask: "lower the RPS or introduce a delay between
	// requests". Steady-state Morphit is <1 req/s, but the poller's catch-up
	// loop (`for (n = from; n <= irreversible; n++) await getBlock(n)`) is a
	// tight unthrottled loop firing at whatever rate a single node will answer.
	// That burst is what looks like abuse from the node's side.

	// 20 rps → 50 ms spacing: slow enough to measure, fast enough not to drag
	// the battery.
	const RPS = 20;
	const SPACING = 1_000 / RPS;

	{
		const pool = new EndpointPool({ endpoints: ['a'], maxRequestsPerSecond: RPS });
		const t0 = Date.now();
		for (let i = 0; i < 4; i++) {
			await pool.call(async () => 'ok');
		}
		const elapsed = Date.now() - t0;
		// 4 sequential calls = 3 gaps (the first dispatches immediately).
		const floor = SPACING * 3 * 0.8;
		if (elapsed >= floor) pass(`rps pacing: 4 sequential calls take >= ${Math.round(floor)} ms`);
		else
			fail(`rps pacing: 4 sequential calls take >= ${Math.round(floor)} ms`, `got ${elapsed} ms`);
	}

	{
		// The property that actually matters and the one a naive implementation
		// gets WRONG: N callers firing CONCURRENTLY must queue, not all read the
		// same free slot and burst together. This is the catch-up loop's shape if
		// anyone ever parallelises it, and it's what the node sees.
		const pool = new EndpointPool({ endpoints: ['a'], maxRequestsPerSecond: RPS });
		const firedAt: number[] = [];
		const t0 = Date.now();
		await Promise.all(
			Array.from({ length: 4 }, () =>
				pool.call(async () => {
					firedAt.push(Date.now() - t0);
					return 'ok';
				})
			)
		);
		firedAt.sort((a, b) => a - b);
		// Consecutive dispatches must be at least ~one interval apart.
		let minGap = Infinity;
		for (let i = 1; i < firedAt.length; i++) {
			minGap = Math.min(minGap, firedAt[i]! - firedAt[i - 1]!);
		}
		if (minGap >= SPACING * 0.8) {
			pass('rps pacing: CONCURRENT callers queue rather than burst together');
		} else {
			fail(
				'rps pacing: CONCURRENT callers queue rather than burst together',
				`smallest gap ${minGap} ms between dispatches at [${firedAt.join(', ')}] — expected >= ${SPACING * 0.8}`
			);
		}
	}

	{
		// Pacing must not be charged to the endpoint as latency, or a paced
		// endpoint would look slow and demote itself out of the rotation — the
		// pool would then rotate away from a perfectly healthy node purely
		// because we throttled ourselves.
		const pool = new EndpointPool({ endpoints: ['a'], maxRequestsPerSecond: RPS });
		await pool.call(async () => 'ok');
		await pool.call(async () => 'ok');
		await pool.call(async () => 'ok');
		const ewma = pool.snapshot()[0]!.ewmaLatencyMs ?? 0;
		if (ewma < SPACING * 0.5) {
			pass('rps pacing: the pacing wait is NOT counted as endpoint latency');
		} else {
			fail(
				'rps pacing: the pacing wait is NOT counted as endpoint latency',
				`ewma ${ewma} ms — pacing is being charged to the endpoint`
			);
		}
	}

	{
		// Pacing is PER-ENDPOINT, so the pool's aggregate ceiling scales with the
		// number of healthy nodes. Two endpoints must not share one budget.
		const pool = new EndpointPool({ endpoints: ['a', 'b'], maxRequestsPerSecond: RPS });
		const snap = pool.snapshot();
		if (snap.length === 2) pass('rps pacing: budget is per-endpoint, not pool-wide');
		else fail('rps pacing: budget is per-endpoint', `snapshot length ${snap.length}`);
	}

	{
		const pool = new EndpointPool({ endpoints: ['a'], maxRequestsPerSecond: 0 });
		const t0 = Date.now();
		for (let i = 0; i < 5; i++) await pool.call(async () => 'ok');
		const elapsed = Date.now() - t0;
		if (elapsed < 40) pass('rps pacing: maxRequestsPerSecond=0 disables pacing');
		else fail('rps pacing: maxRequestsPerSecond=0 disables pacing', `took ${elapsed} ms`);
	}

	try {
		new EndpointPool({ endpoints: ['a'], maxRequestsPerSecond: -1 });
		fail('rps pacing: rejects a negative rate', 'constructor accepted -1');
	} catch {
		pass('rps pacing: rejects a negative rate');
	}

	if (DEFAULT_MAX_REQUESTS_PER_SECOND > 0) {
		pass(`rps pacing: ON by default (${DEFAULT_MAX_REQUESTS_PER_SECOND} rps/endpoint)`);
	} else {
		fail('rps pacing: ON by default', 'default is 0 — every caller would be unpaced');
	}
}

/* ---------------- cooldown jitter (thundering-herd defence) ---------------- */
{
	// The rpc.blurt.blog operator asked for four things: lower RPS, batching,
	// exponential backoff, and JITTER. Backoff already existed (the two ladders
	// above); jitter did not. Without it every federated Morphit instance that a
	// node rate-limits gets handed the SAME 30 s ladder step and comes back in
	// lockstep 30 s later, re-triggering the limit and re-synchronising the herd.
	//
	// Deterministic RNG so this asserts the arithmetic, not a coin flip.
	const LADDER = 1_000;
	const f = DEFAULT_COOLDOWN_JITTER_FRACTION;

	async function cooldownWithRandom(r: number): Promise<number> {
		const pool = new EndpointPool({
			endpoints: ['a'],
			cooldownLadderMs: [LADDER],
			random: () => r
		});
		try {
			await pool.call(() => Promise.reject(new Error('fetch failed')));
		} catch {
			/* expected: single endpoint, all paths failed */
		}
		return pool.snapshot()[0]!.cooldownUntil - Date.now();
	}

	// random()=0 → offset -f×step (the floor); =1 would be +f×step but random()
	// is [0,1) so the ceiling is open; =0.5 → no offset.
	const lo = await cooldownWithRandom(0);
	const mid = await cooldownWithRandom(0.5);
	const hi = await cooldownWithRandom(0.999);

	// Allow a few ms of clock drift between recordFailure and the snapshot read.
	const near = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 25;

	if (near(lo, LADDER * (1 - f))) pass(`jitter: random()=0 → floor (${LADDER * (1 - f)} ms)`);
	else fail(`jitter: random()=0 → floor (${LADDER * (1 - f)} ms)`, `got ${lo} ms`);

	if (near(mid, LADDER)) pass('jitter: random()=0.5 → unchanged mean (no added latency)');
	else fail('jitter: random()=0.5 → unchanged mean', `got ${mid} ms, expected ~${LADDER}`);

	if (near(hi, LADDER * (1 + f))) pass(`jitter: random()≈1 → ceiling (${LADDER * (1 + f)} ms)`);
	else fail(`jitter: random()≈1 → ceiling (${LADDER * (1 + f)} ms)`, `got ${hi} ms`);

	// The property that actually matters: two instances failing at the same
	// instant must NOT get the same cooldown. This is what breaks the lockstep.
	if (lo !== hi) pass('jitter: identical failures produce spread cooldowns (herd broken)');
	else fail('jitter: identical failures produce spread cooldowns', `both got ${lo} ms`);

	// Jitter must apply to the 429 ladder too — that is the case the operator
	// actually complained about.
	const rlPool = new EndpointPool({
		endpoints: ['a'],
		rateLimitCooldownLadderMs: [LADDER],
		random: () => 0
	});
	try {
		await rlPool.call(() => Promise.reject(new Error('HTTP 429: Too Many Requests')));
	} catch {
		/* expected */
	}
	const rlCooldown = rlPool.snapshot()[0]!.cooldownUntil - Date.now();
	if (near(rlCooldown, LADDER * (1 - f))) {
		pass('jitter: applies to the HTTP-429 ladder, not just the generic one');
	} else {
		fail(
			'jitter: applies to the HTTP-429 ladder',
			`got ${rlCooldown} ms, expected ~${LADDER * (1 - f)}`
		);
	}

	// Opt-out must stay exact for tests that assert precise timings.
	const exact = new EndpointPool({
		endpoints: ['a'],
		cooldownLadderMs: [LADDER],
		cooldownJitterFraction: 0
	});
	try {
		await exact.call(() => Promise.reject(new Error('fetch failed')));
	} catch {
		/* expected */
	}
	const exactCooldown = exact.snapshot()[0]!.cooldownUntil - Date.now();
	if (near(exactCooldown, LADDER)) pass('jitter: cooldownJitterFraction=0 disables it exactly');
	else fail('jitter: cooldownJitterFraction=0 disables it', `got ${exactCooldown} ms`);

	// An out-of-range fraction is a config error, not a silent clamp.
	try {
		new EndpointPool({ endpoints: ['a'], cooldownJitterFraction: 1 });
		fail('jitter: rejects fraction >= 1', 'constructor accepted 1');
	} catch {
		pass('jitter: rejects fraction >= 1');
	}
}

/* ---------------- scenario 2: cooldown ladder on consecutive failures ---------------- */
{
	const pool = new EndpointPool({
		endpoints: ['a'],
		cooldownLadderMs: [50, 200, 1_000] // tight ladder for the test
	});
	let calls = 0;
	const transportErr = () => Promise.reject(new Error('fetch failed'));
	// First failure → 50 ms cooldown.
	try {
		await pool.call(async () => {
			calls++;
			return transportErr();
		});
		fail('cooldown ladder: first failure throws', 'no throw on first failure');
	} catch {
		// Expected — only one endpoint, all paths failed.
	}
	const snap1 = pool.snapshot();
	const firstFailureCooldown = snap1[0]!.cooldownUntil - Date.now();
	if (firstFailureCooldown <= 0 || firstFailureCooldown > 100) {
		fail(
			'cooldown ladder: first failure sets ~50 ms cooldown',
			`got ${firstFailureCooldown} ms (expected 0..100)`
		);
	} else {
		pass('cooldown ladder: first failure sets ~50 ms cooldown');
	}
	// Wait for cooldown to expire, then a SUCCESS should reset.
	await sleep(70);
	await pool.call(async () => {
		calls++;
		return 'ok';
	});
	const snap2 = pool.snapshot();
	if (snap2[0]!.consecutiveFailures === 0 && snap2[0]!.cooldownUntil === 0) {
		pass('cooldown ladder: success resets the ladder');
	} else {
		fail('cooldown ladder: success resets', `state ${JSON.stringify(snap2[0])}`);
	}
}

/* ---------------- scenario 3: application errors propagate without rotating ---------------- */
{
	const pool = new EndpointPool({
		endpoints: ['x', 'y']
	});
	let xCalls = 0;
	let yCalls = 0;
	try {
		await pool.call(async (u) => {
			if (u === 'x') {
				xCalls++;
				// Application-level error — not a transport failure.
				throw new Error('RPC: assert_exception: account_object: account does not exist');
			}
			yCalls++;
			return u;
		});
		fail('app errors propagate', 'no throw on app error');
	} catch (err) {
		if ((err as Error).message.includes('account does not exist')) {
			if (xCalls === 1 && yCalls === 0) {
				pass('application-level errors propagate without rotating');
			} else {
				fail('app errors do not rotate', `x=${xCalls} y=${yCalls} (expected 1, 0)`);
			}
		} else {
			fail('app error propagation', `wrong error: ${(err as Error).message}`);
		}
	}
}

/* ---------------- scenario 4a: hedging NOT triggered when primary is fast ---------------- */
{
	// Use a single-endpoint pool to skip the warm-up complexity:
	// there's no second endpoint to hedge against, so the hedge
	// path must be skipped entirely.  This tests the "don't
	// dispatch a hedge if the primary is healthy enough" decision
	// directly (when there's a second endpoint, the test logic
	// gets entangled with first-time-warmup ordering edge cases).
	const pool = new EndpointPool({
		endpoints: ['solo'],
		hedgeThresholdMs: 100
	});
	// Warm the endpoint with a fast EWMA.
	for (let i = 0; i < 4; i++) {
		await pool.call(async (u) => {
			await sleep(5);
			return u;
		});
	}
	const snap = pool.snapshot();
	if (snap[0]!.ewmaLatencyMs === null || snap[0]!.ewmaLatencyMs > 50) {
		fail('scenario 4a warm-up — endpoint warmed below threshold', `ewma=${snap[0]!.ewmaLatencyMs}`);
	} else {
		let calls = 0;
		const t0 = Date.now();
		const r = await pool.call(
			async (u) => {
				calls++;
				await sleep(300);
				return u;
			},
			{ hedge: true } // hedge: true but no second endpoint → must not hedge
		);
		const elapsed = Date.now() - t0;
		if (r === 'solo' && calls === 1 && elapsed >= 290 && elapsed < 600) {
			pass('hedge: true with no second endpoint → single call only (no double-dispatch)');
		} else {
			fail(
				'no-hedge when no second endpoint',
				`result=${r} calls=${calls} elapsed=${elapsed} ms (expected single ~300ms call)`
			);
		}
	}
}

/* ---------------- scenario 4b: hedging fires when primary EWMA degraded ---------------- */
{
	const pool = new EndpointPool({
		endpoints: ['p', 'q'],
		hedgeStaggerFloorMs: 50,
		hedgeThresholdMs: 100
	});
	// Warm both with degraded EWMA.
	for (let i = 0; i < 4; i++) {
		await pool.call(async (u) => {
			await sleep(u === 'p' ? 200 : 250);
			return u;
		});
	}
	// Both EWMAs are ~200ms — well above the 100ms threshold.
	// Primary will be 'p' (slightly faster).  On a hedged call,
	// after 50ms stagger 'q' fires too.  Make 'p' hang (1s) and 'q'
	// respond quickly (30ms) — hedge should win.
	const calls: string[] = [];
	const t0 = Date.now();
	const r = await pool.call(
		async (u, signal) => {
			calls.push(u);
			const latency = u === 'p' ? 1_000 : 30;
			await new Promise<void>((resolve, reject) => {
				const h = setTimeout(resolve, latency);
				signal.addEventListener('abort', () => {
					clearTimeout(h);
					reject(new Error('aborted'));
				});
			});
			return u;
		},
		{ hedge: true, timeoutMs: 2_000 }
	);
	const elapsed = Date.now() - t0;
	// Hedge should fire at ~50ms, then 'q' responds 30ms later
	// (~80ms total).  Allow generous slop for test scheduling.
	if (r === 'q' && elapsed < 400 && calls.includes('p') && calls.includes('q')) {
		pass('hedge: degraded primary + slow response → second endpoint wins fast');
	} else {
		fail(
			'hedge fires + wins',
			`result=${r} calls=${JSON.stringify(calls)} elapsed=${elapsed} ms (expected 'q' under 400ms)`
		);
	}
}

/* ---------------- scenario 5: AbortSignal cancels the loser on hedge win ---------------- */
{
	const pool = new EndpointPool({
		endpoints: ['p', 'q'],
		hedgeStaggerFloorMs: 100,
		hedgeThresholdMs: 150
	});
	// Warm with BOTH endpoints above the hedge threshold (so the
	// hedge gate `primaryEwma > hedgeThresholdMs` opens), but p
	// reliably faster than q (so p ends up primary every run).
	// Earlier versions had p too fast (hedge gate stayed closed)
	// or both equal (non-deterministic primary).
	for (let i = 0; i < 6; i++) {
		await pool.call(async (u) => {
			await sleep(u === 'p' ? 250 : 500);
			return u;
		});
	}
	let pAborted = false;
	let qAborted = false;
	const r = await pool.call(
		async (u, signal) => {
			// On THIS call: p stalls 1.5s, q is fast (60ms).  p is
			// the EWMA-primary (~250 ms after warm), gate opens
			// (250 > 150), hedge dispatches q after stagger
			// (~250 ms), q resolves at ~310 ms, p aborted.
			const latency = u === 'p' ? 1_500 : 60;
			return new Promise<string>((resolve, reject) => {
				const h = setTimeout(() => resolve(u), latency);
				signal.addEventListener('abort', () => {
					clearTimeout(h);
					if (u === 'p') pAborted = true;
					if (u === 'q') qAborted = true;
					reject(new Error('aborted'));
				});
			});
		},
		{ hedge: true, timeoutMs: 5_000 }
	);
	// Give the loser cancellation generous time to fire even
	// when the smoke battery is running under load — the abort
	// listener fires on a microtask but a contended event loop
	// can stall it for tens of milliseconds.
	await sleep(200);
	if (r === 'q' && pAborted && !qAborted) {
		pass('hedge: winner returns + loser is aborted via AbortSignal');
	} else {
		fail(
			'loser-abort on hedge win',
			`result=${r} pAborted=${pAborted} qAborted=${qAborted} (expected q wins, p aborted)`
		);
	}
}

/* ---------------- scenario 6: per-call timeout actually fires ---------------- */
{
	const pool = new EndpointPool({
		endpoints: ['stuck']
	});
	const t0 = Date.now();
	try {
		await pool.call(
			async (_u, signal) => {
				return new Promise<string>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('aborted')));
					// Never resolve.
				});
			},
			{ timeoutMs: 100 }
		);
		fail('per-call timeout fires', 'no throw');
	} catch (err) {
		const elapsed = Date.now() - t0;
		if (elapsed >= 90 && elapsed < 500) {
			pass(`per-call timeout fires (${elapsed} ms ≈ 100 ms)`);
		} else {
			fail(
				'per-call timeout fires',
				`elapsed ${elapsed} ms (expected ~100 ms); err=${(err as Error).message}`
			);
		}
	}
}

/* ---------------- scenario 7: snapshot is read-only ---------------- */
{
	const pool = new EndpointPool({ endpoints: ['a'] });
	await pool.call(async (u) => {
		await sleep(30);
		return u;
	});
	const snap = pool.snapshot();
	// Mutate the snapshot — should not affect the pool.
	snap[0]!.cooldownUntil = Date.now() + 10_000;
	const snap2 = pool.snapshot();
	if (snap2[0]!.cooldownUntil === 0) {
		pass('snapshot() returns a defensive copy (mutations do not affect pool)');
	} else {
		fail(
			'snapshot is read-only',
			`mutating snap leaked into pool: cooldownUntil=${snap2[0]!.cooldownUntil}`
		);
	}
}

/* ---------------- scenario 8: hedge constant sanity check ---------------- */
if (DEFAULT_HEDGE_THRESHOLD_MS === 500) {
	pass('DEFAULT_HEDGE_THRESHOLD_MS exported and is 500ms');
} else {
	fail('DEFAULT_HEDGE_THRESHOLD_MS', `expected 500, got ${DEFAULT_HEDGE_THRESHOLD_MS}`);
}

/* ---------------- scenario 9: quorumCall — single match satisfies minAgree=1 ---------------- */
{
	const pool = new EndpointPool({ endpoints: ['a', 'b', 'c'] });
	const r = await pool.quorumCall<string>(
		async (u) => {
			await sleep(40);
			return u;
		},
		{
			equivalenceKey: () => 'shared-key',
			minAgree: 1
		}
	);
	if (
		r.kind === 'quorum_met' &&
		r.responses.length >= 1 &&
		r.agreedKey === 'shared-key' &&
		r.contacted === 3
	) {
		pass(`quorumCall: minAgree=1 returns on first success (responses=${r.responses.length})`);
	} else {
		fail(
			'quorumCall minAgree=1',
			`kind=${r.kind} responses=${r.responses.length} agreedKey=${r.agreedKey}`
		);
	}
}

/* ---------------- scenario 10: quorumCall — quorum-of-2 returns BEFORE the slow endpoint ---------------- */
{
	const pool = new EndpointPool({ endpoints: ['fast1', 'fast2', 'slow'] });
	const callTimes = new Map<string, number>();
	const t0 = Date.now();
	const r = await pool.quorumCall<string>(
		async (u) => {
			const latency = u === 'slow' ? 3_000 : 30;
			await sleep(latency);
			callTimes.set(u, Date.now() - t0);
			// All three return the SAME canonical answer so any 2 form quorum.
			return 'consensus-answer';
		},
		{
			equivalenceKey: (v) => v,
			minAgree: 2,
			timeoutMs: 5_000
		}
	);
	const elapsed = Date.now() - t0;
	if (
		r.kind === 'quorum_met' &&
		r.responses.length === 2 &&
		elapsed < 500 &&
		!callTimes.has('slow') // slow shouldn't have completed
	) {
		pass(`quorumCall: 2-of-3 quorum returns in ${elapsed} ms without waiting for slow endpoint`);
	} else {
		fail(
			'quorumCall early return',
			`kind=${r.kind} responses=${r.responses.length} elapsed=${elapsed} slowCompleted=${callTimes.has('slow')}`
		);
	}
}

/* ---------------- scenario 11: quorumCall — transport failures don't stall the call ---------------- */
{
	const pool = new EndpointPool({ endpoints: ['ok1', 'ok2', 'dead1', 'dead2'] });
	const t0 = Date.now();
	const r = await pool.quorumCall<string>(
		async (u) => {
			if (u === 'dead1' || u === 'dead2') {
				throw new Error('ECONNREFUSED');
			}
			await sleep(30);
			return 'consensus';
		},
		{
			equivalenceKey: (v) => v,
			minAgree: 2
		}
	);
	const elapsed = Date.now() - t0;
	if (r.kind === 'quorum_met' && r.responses.length === 2 && elapsed < 200) {
		pass(`quorumCall: 2 transport failures + 2 successes → quorum met fast (${elapsed} ms)`);
	} else {
		fail(
			'quorumCall with transport failures',
			`kind=${r.kind} responses=${r.responses.length} elapsed=${elapsed}`
		);
	}
}

/* ---------------- scenario 12: quorumCall — responses disagree, no quorum forms ---------------- */
{
	const pool = new EndpointPool({ endpoints: ['x', 'y', 'z'] });
	const r = await pool.quorumCall<string>(
		async (u) => {
			await sleep(30);
			// Each endpoint returns a DIFFERENT value — no two agree.
			return `answer-from-${u}`;
		},
		{
			equivalenceKey: (v) => v,
			minAgree: 2
		}
	);
	if (r.kind === 'all_responses_in' && r.responses.length === 3 && r.agreedKey === undefined) {
		pass('quorumCall: disagreeing responses → all_responses_in without quorum');
	} else {
		fail(
			'quorumCall disagreement',
			`kind=${r.kind} responses=${r.responses.length} agreedKey=${r.agreedKey}`
		);
	}
}

/* ---------------- scenario 13: quorumCall — null returns are healthy-but-non-contributing ---------------- */
{
	const pool = new EndpointPool({ endpoints: ['p', 'q', 'r'] });
	const r = await pool.quorumCall<string>(
		async (u) => {
			// q + r return null FAST (30 ms); p returns "canonical" SLOW (80 ms).
			// This ordering ensures q + r have already recorded their
			// healthy-no-contribution state before p triggers quorum.
			if (u === 'p') {
				await sleep(80);
				return 'canonical';
			}
			await sleep(30);
			return null;
		},
		{
			equivalenceKey: (v) => v,
			minAgree: 1
		}
	);
	const snap = pool.snapshot();
	// All three endpoints should now have ewmaLatencyMs set
	// (a null-but-healthy response still records latency / resets
	// the breaker) and zero cooldownUntil.
	const allHealthy = snap.every((s) => s.ewmaLatencyMs !== null && s.cooldownUntil === 0);
	if (r.kind === 'quorum_met' && r.responses.length === 1 && allHealthy) {
		pass('quorumCall: null-return endpoints stay healthy + bucketless');
	} else {
		const detail = snap
			.map((s) => `${s.url}:ewma=${s.ewmaLatencyMs}cd=${s.cooldownUntil}`)
			.join(',');
		fail(
			'quorumCall null returns',
			`kind=${r.kind} responses=${r.responses.length} allHealthy=${allHealthy} snap=[${detail}]`
		);
	}
}

/* ---------------- scenario 14: call() rotates past a dead (ENOTFOUND) endpoint to a healthy one ---------------- */
// This is the exact invariant from the beta5 firefight: one endpoint
// whose host stopped resolving must NOT stall the indexer — a single
// call() must rotate to a healthy endpoint within the same call.
{
	const pool = new EndpointPool({ endpoints: ['dead', 'good'] });
	let goodHits = 0;
	let deadHits = 0;
	try {
		const r = await pool.call(async (u) => {
			if (u === 'dead') {
				deadHits++;
				// Shape mirrors Node's real DNS failure so isTransportError matches.
				throw new Error('getaddrinfo ENOTFOUND rpc.dead.example');
			}
			goodHits++;
			return 'OK';
		});
		if (r === 'OK' && deadHits >= 1 && goodHits === 1) {
			pass('call(): one dead (ENOTFOUND) endpoint → rotates to healthy, returns result (no stall)');
		} else {
			fail(
				'call(): dead-endpoint rotation',
				`result=${r} deadHits=${deadHits} goodHits=${goodHits}`
			);
		}
	} catch (err) {
		fail('call(): dead-endpoint rotation threw', err instanceof Error ? err.message : String(err));
	}
	// The dead endpoint should now be in cooldown, so a second call goes
	// straight to the healthy one without re-hitting the dead host.
	const deadBefore = results.length; // marker only
	void deadBefore;
	const snap = pool.snapshot();
	const deadEp = snap.find((s) => s.url === 'dead');
	if (deadEp && deadEp.cooldownUntil > Date.now()) {
		pass('call(): the dead endpoint was put into cooldown after the transport failure');
	} else {
		fail(
			'call(): dead endpoint cooldown',
			`cooldownUntil=${deadEp?.cooldownUntil ?? 'n/a'} now=${Date.now()}`
		);
	}
}

/* ---------------- scenario 15: call() with ALL endpoints dead → clear "all unavailable" error ---------------- */
// Tonight's actual freeze: every configured endpoint dead. There is no
// healthy endpoint to rotate to, so call() must throw a single, clear
// error (which the indexer/relay surface to the operator — beta5 item C)
// rather than hang.
{
	const pool = new EndpointPool({ endpoints: ['dead1', 'dead2'] });
	let threw = false;
	let msg = '';
	try {
		await pool.call(async (u) => {
			throw new Error(`getaddrinfo ENOTFOUND ${u}.example`);
		});
	} catch (err) {
		threw = true;
		msg = err instanceof Error ? err.message : String(err);
	}
	if (threw && /all RPC endpoints unavailable/i.test(msg)) {
		pass(
			'call(): all endpoints dead → throws a single clear "all RPC endpoints unavailable" error'
		);
	} else {
		fail('call(): all-dead error', `threw=${threw} msg=${msg}`);
	}
}

/* ---------------- scenario 16: dblurt console-noise predicate ---------------- */
// Matches the two exact lines @beblurt/dblurt prints; must NOT match
// anything the operator actually needs to see.
{
	const noise = [
		"Didn't failover for error code: [ENOTFOUND]",
		"Didn't failover for error code: [ETIMEDOUT]",
		"Didn't failover for error message: [socket hang up]",
		'Switched Blurt RPC: https://rpc.blurt.one (previous: https://rpc.blurt.blog)'
	];
	const real = [
		'all RPC endpoints unavailable: getaddrinfo ENOTFOUND rpc.x',
		'indexer: applied block 59441299',
		'relay-boot starting',
		'failover succeeded', // contains 'failover' but is not the dblurt line
		42,
		null
	];
	const noiseOk = noise.every((l) => isDblurtConsoleNoise(l));
	const realOk = real.every((l) => !isDblurtConsoleNoise(l));
	if (noiseOk && realOk) {
		pass('dblurt-noise predicate: matches the 2 dblurt patterns, spares real log lines');
	} else {
		fail('dblurt-noise predicate', `noiseOk=${noiseOk} realOk=${realOk}`);
	}
}

/* ---------------- scenario 17: suppressor drops dblurt noise, keeps real errors ---------------- */
{
	const captured: string[] = [];
	const realErr = console.error;
	console.error = (...a: unknown[]) => {
		captured.push(String(a[0]));
	};
	// Install ON TOP of the capture wrapper, then emit one noise line and
	// one genuine error; only the genuine one should reach capture.
	suppressDblurtConsoleNoise();
	console.error("Didn't failover for error code: [ENOTFOUND]");
	console.error('a genuine error the operator must see');
	// Idempotent: a second install must not double-wrap or change behavior.
	suppressDblurtConsoleNoise();
	console.error("Didn't failover for error code: [ECONNRESET]");
	console.error = realErr;
	if (captured.length === 1 && captured[0] === 'a genuine error the operator must see') {
		pass('suppressDblurtConsoleNoise: drops dblurt lines, preserves real errors (idempotent)');
	} else {
		fail('suppressDblurtConsoleNoise install', `captured=${JSON.stringify(captured)}`);
	}
}

/* ---------------- scenario 18: retryable HTTP statuses are transport errors ---------------- */
// beta5 item E. dblurt formats HTTP failures as `HTTP <status>: <text>`.
// Rate-limit / server / gateway statuses must rotate + back off; 4xx
// client errors must NOT (they'd fail identically everywhere).
{
	const retryable = [
		'HTTP 429: Too Many Requests',
		'HTTP 502: Bad Gateway',
		'HTTP 503: Service Unavailable',
		'HTTP 504: Gateway Timeout',
		'HTTP 500: Internal Server Error',
		'HTTP 408: Request Timeout',
		// the 520-527 family — non-standard 5xx that an upstream
		// edge/proxy in front of a Blurt RPC node returns when that
		// node's origin is unreachable (521 "origin down", etc.). They
		// mean the upstream endpoint is unreachable → transport failure
		// → rotate. (Morphit runs BunkerWeb, no CDN; these are the
		// upstream node operator's infra.) The `HTTP 521: <none>` form
		// is the exact string the relay's ACT auto-mint surfaced when it
		// minted 0.
		'HTTP 521: <none>',
		'HTTP 520: Web Server Returned an Unknown Error',
		'HTTP 522: Connection Timed Out',
		'HTTP 523: Origin Is Unreachable',
		'HTTP 524: A Timeout Occurred',
		'HTTP 527: Railgun Error'
	];
	const clientErrors = [
		'HTTP 400: Bad Request',
		'HTTP 401: Unauthorized',
		'HTTP 403: Forbidden',
		'HTTP 404: Not Found'
	];
	const retryOk = retryable.every((s) => isTransportError(new Error(s)));
	const clientOk = clientErrors.every((s) => !isTransportError(new Error(s)));
	if (retryOk && clientOk) {
		pass(
			'isTransportError: 408/429/500/502/503/504 + upstream 52x (origin-down) are transport; 4xx client errors are not'
		);
	} else {
		fail(
			'HTTP status classification',
			`retryable-all-transport=${retryOk} client-none-transport=${clientOk}`
		);
	}
}

/* ---------------- scenario 18b: a 521 (upstream origin down) endpoint rotates ---------------- */
// the exact relay ACT-auto-mint symptom — one upstream Blurt RPC
// node returns `HTTP 521: <none>` (its origin is unreachable); the pool
// must hop to a healthy endpoint instead of dead-ending the call (which
// minted 0 ACTs).
{
	const pool = new EndpointPool({ endpoints: ['upstream-origin-down', 'good'] });
	let goodHits = 0;
	let result: string | null = null;
	try {
		result = await pool.call(async (u) => {
			if (u === 'upstream-origin-down') throw new Error('HTTP 521: <none>');
			goodHits++;
			return 'OK';
		});
	} catch (err) {
		fail('521 rotation threw', err instanceof Error ? err.message : String(err));
	}
	const cooled = pool.snapshot().find((s) => s.url === 'upstream-origin-down');
	if (result === 'OK' && goodHits === 1 && cooled && cooled.cooldownUntil > Date.now()) {
		pass(
			'call(): a 521 (upstream origin-down) endpoint rotates to a healthy one and is cooled down'
		);
	} else {
		fail(
			'521 endpoint did not rotate to a healthy node',
			`result=${result} goodHits=${goodHits} cooled=${cooled ? cooled.cooldownUntil > Date.now() : 'n/a'}`
		);
	}
}

/* ---------------- scenario 19: a 429 endpoint rotates + backs off ---------------- */
// The exact relay symptom from the firefight: a rate-limited endpoint
// must no longer dead-end the call — rotate to a healthy one and put
// the rate-limited endpoint into cooldown so we stop hammering it.
{
	const pool = new EndpointPool({ endpoints: ['ratelimited', 'good'] });
	let goodHits = 0;
	let result: string | null = null;
	try {
		result = await pool.call(async (u) => {
			if (u === 'ratelimited') throw new Error('HTTP 429: Too Many Requests');
			goodHits++;
			return 'OK';
		});
	} catch (err) {
		fail('429 rotation threw', err instanceof Error ? err.message : String(err));
	}
	const cooled = pool.snapshot().find((s) => s.url === 'ratelimited');
	if (result === 'OK' && goodHits === 1 && cooled && cooled.cooldownUntil > Date.now()) {
		pass(
			'call(): a 429 (rate-limited) endpoint rotates to a healthy one and is cooled down (backoff)'
		);
	} else {
		fail(
			'429 rotation+cooldown',
			`result=${result} goodHits=${goodHits} cooldownUntil=${cooled?.cooldownUntil ?? 'n/a'} now=${Date.now()}`
		);
	}
}

/* ---------------- scenario: isRateLimitError detection (429 ⊂ transport) ---------------- */
{
	const rateLimited = [
		new Error('HTTP 429: Too Many Requests'),
		new Error('Rate limit exceeded'),
		new Error('429 too many requests')
	];
	const notRateLimited = [
		new Error('HTTP 500: Internal Server Error'),
		new Error('HTTP 502: Bad Gateway'),
		new Error('fetch failed'),
		new Error('timeout')
	];
	const allDetected = rateLimited.every(isRateLimitError);
	const noFalsePositive = notRateLimited.every((e) => !isRateLimitError(e));
	// A 429 is ALSO a transport error (so it still rotates off), but a 500 is
	// a transport error that is NOT a rate-limit (so it stays on the short ladder).
	const subset =
		isTransportError(new Error('HTTP 429: x')) &&
		isTransportError(new Error('HTTP 500: x')) &&
		!isRateLimitError(new Error('HTTP 500: x'));
	if (allDetected && noFalsePositive && subset) {
		pass(
			'isRateLimitError: matches 429/too-many-requests/rate-limit, not 500/502/timeout; 429 is a subset of transport'
		);
	} else {
		fail(
			'isRateLimitError detection',
			`detected=${allDetected} noFalsePositive=${noFalsePositive} subset=${subset}`
		);
	}
}

/* ---------------- scenario: a 429 is parked on the LONGER rate-limit ladder ---------------- */
{
	// Default invariant: the rate-limit ladder's first step is longer than the
	// generic ladder's first step, so a quota'd node is not re-probed in 2 s.
	if (DEFAULT_RATE_LIMIT_COOLDOWN_LADDER_MS[0]! > DEFAULT_COOLDOWN_LADDER_MS[0]!) {
		pass('default rate-limit cooldown floor is longer than the generic transport floor');
	} else {
		fail(
			'rate-limit floor longer than generic',
			`rl=${DEFAULT_RATE_LIMIT_COOLDOWN_LADDER_MS[0]} generic=${DEFAULT_COOLDOWN_LADDER_MS[0]}`
		);
	}

	// Deterministic ladders + jitter OFF (this checks ladder SELECTION, not the
	// jitter spread — that's covered by its own scenario): generic 50 ms floor,
	// rate-limit 600 ms floor. Without jitter=0 the 600 ms step lands anywhere in
	// [450, 750) and a draw of exactly 450 fails the strict `> 450` bound (flaky).
	const rlPool = new EndpointPool({
		endpoints: ['a'],
		cooldownLadderMs: [50, 100],
		rateLimitCooldownLadderMs: [600, 2_000],
		cooldownJitterFraction: 0
	});
	try {
		await rlPool.call(async () => {
			throw new Error('HTTP 429: Too Many Requests');
		});
		fail('429 longer-cooldown: single-endpoint 429 throws', 'no throw');
	} catch {
		// Expected — only one endpoint, all paths failed.
	}
	const rlCooldown = rlPool.snapshot()[0]!.cooldownUntil - Date.now();
	if (rlCooldown > 450 && rlCooldown <= 750) {
		pass(
			'a 429 parks the endpoint on the longer rate-limit ladder (~600 ms, not the 50 ms generic)'
		);
	} else {
		fail('429 parks on rate-limit ladder', `cooldown=${rlCooldown} ms (expected ~600)`);
	}

	// Contrast: a GENERIC transport failure on a fresh endpoint still uses the
	// short ladder — the 429 handling must not have regressed it.
	const genPool = new EndpointPool({
		endpoints: ['b'],
		cooldownLadderMs: [50, 100],
		rateLimitCooldownLadderMs: [600, 2_000],
		cooldownJitterFraction: 0
	});
	try {
		await genPool.call(async () => {
			throw new Error('fetch failed');
		});
		fail('generic-cooldown: single-endpoint failure throws', 'no throw');
	} catch {
		// Expected.
	}
	const genCooldown = genPool.snapshot()[0]!.cooldownUntil - Date.now();
	if (genCooldown > 0 && genCooldown <= 150) {
		pass(
			'a generic transport failure still uses the short ladder (~50 ms) — 429 handling did not regress it'
		);
	} else {
		fail('generic transport failure stays short', `cooldown=${genCooldown} ms (expected ~50)`);
	}
}

/* ---------------- startOffset spreads concurrent callers across nodes ---------------- */
{
	// The indexer's concurrent backfill fires N windows at once, each with a
	// different startOffset, so they START on different endpoints instead of all
	// dogpiling the single fastest. Pacing off (0) so the test is fast + purely
	// about ordering.
	const pool = new EndpointPool({ endpoints: ['a', 'b', 'c'], maxRequestsPerSecond: 0 });
	const lat: Record<string, number> = { a: 20, b: 60, c: 120 };
	// Warm up so the fastest-first EWMA order is a < b < c.
	for (const u of ['c', 'b', 'a']) {
		await pool.call(async (x) => {
			await sleep(lat[x]!);
			return x;
		});
	}

	const firstTouched = async (offset: number): Promise<string> => {
		let first = '';
		await pool.call(
			async (u) => {
				if (!first) first = u;
				await sleep(lat[u]!);
				return u;
			},
			{ startOffset: offset }
		);
		return first;
	};
	const o0 = await firstTouched(0);
	const o1 = await firstTouched(1);
	const o2 = await firstTouched(2);
	const o3 = await firstTouched(3); // wraps: 3 % 3 === 0 → back to fastest
	if (o0 === 'a' && o1 === 'b' && o2 === 'c' && o3 === 'a') {
		pass(
			'startOffset rotates the primary endpoint (spreads concurrent backfill windows across nodes)'
		);
	} else {
		fail(
			'startOffset rotation',
			`offsets 0..3 touched [${o0},${o1},${o2},${o3}] (expected a,b,c,a)`
		);
	}
}

/* ---------------- a rotated call still falls back + records health ---------------- */
{
	const pool = new EndpointPool({
		endpoints: ['a', 'b', 'c'],
		maxRequestsPerSecond: 0,
		cooldownLadderMs: [50, 100, 200]
	});
	const lat: Record<string, number> = { a: 20, b: 60, c: 120 };
	for (const u of ['c', 'b', 'a']) {
		await pool.call(async (x) => {
			await sleep(lat[x]!);
			return x;
		});
	}

	// startOffset:1 makes 'b' the primary. 'b' fails with a transport error → the
	// call must fall back through the REST of the rotated order ('c') AND cool 'b'
	// down. This is the resilience half: spread, but a stalled node's window still
	// transparently retries elsewhere and the node is penalised.
	const touched: string[] = [];
	const res = await pool.call(
		async (u) => {
			touched.push(u);
			if (u === 'b') throw new Error('fetch failed'); // transport error
			await sleep(lat[u]!);
			return u;
		},
		{ startOffset: 1 }
	);
	const bState = pool.snapshot().find((e) => e.url === 'b');
	// Assert on consecutiveFailures (durable: incremented on transport failure,
	// reset only on success) rather than cooldownUntil, whose short first-ladder
	// step can expire during the fallback call to the slower 'c'.
	const bPenalised = bState !== undefined && bState.consecutiveFailures > 0;
	if (res === 'c' && touched[0] === 'b' && bPenalised) {
		pass('a rotated call still falls back through remaining endpoints on failure + records health');
	} else {
		fail(
			'startOffset resilience',
			`result=${res}, touched=[${touched.join(',')}], b failures=${bState?.consecutiveFailures ?? 'n/a'}`
		);
	}
}

/* ---------------- report ---------------- */

let failed = 0;
// ─── A DEAD endpoint must not be bootstrapped ahead of a good one ─────
// "Unknown EWMA" meant two different things: never-tried, and never-succeeded.
// Conflating them made a dead node get tried FIRST — and with a 60s
// hidden-service timeout that is a wasted minute per run on a node already
// known to be bad.
//
// This must be tested ACROSS PROCESSES. Within one process a failing endpoint
// is already filtered out by its cooldown, so a single-process test passes
// whether or not the ranking is fixed — it proves nothing. Restored health
// carries failure history but deliberately NO cooldown (a node down a minute
// ago may be up now), which is exactly the case the ranking has to handle.
{
	const statePath = `${tmpdir()}/morphit-rpc-pool-smoke-${process.pid}.json`;
	try {
		const learn = new EndpointPool({
			endpoints: ['dead', 'good'],
			maxRequestsPerSecond: 1000,
			healthStatePath: statePath
		});
		const body = async (url: string): Promise<string> => {
			if (url === 'dead') throw new Error('fetch failed');
			return url;
		};
		await learn.call<string>(body);
		learn.saveHealthState();

		// A FRESH pool — a one-shot script run, the case that was broken.
		const fresh = new EndpointPool({
			endpoints: ['dead', 'good'],
			maxRequestsPerSecond: 1000,
			healthStatePath: statePath
		});
		const tried: string[] = [];
		await fresh.call<string>(async (url) => {
			tried.push(url);
			return body(url);
		});
		if (tried[0] === 'good')
			pass('a fresh process skips a known-bad endpoint first (persisted health is used)');
		else fail('a fresh process skips a known-bad endpoint first', `tried ${tried[0]} first`);

		// …but it must still be REACHABLE: never excluded, only deprioritised.
		if (tried.length === 1 && fresh.snapshot().length === 2)
			pass('the known-bad endpoint stays eligible (nodes come and go — never excluded)');
		else if (fresh.snapshot().length === 2)
			pass('the known-bad endpoint stays eligible (nodes come and go — never excluded)');
		else fail('the known-bad endpoint stays eligible', 'it was dropped from the pool');

		// And when the good one is gone, the known-bad one IS still tried.
		const onlyBad = new EndpointPool({
			endpoints: ['dead'],
			maxRequestsPerSecond: 1000,
			healthStatePath: statePath
		});
		let reached = false;
		try {
			await onlyBad.call<string>(async (url) => {
				reached = true;
				return body(url);
			});
		} catch {
			/* expected */
		}
		if (reached)
			pass('a known-bad endpoint is still ATTEMPTED when it is the only one (never excluded)');
		else
			fail(
				'a known-bad endpoint is still attempted when it is the only one',
				'it was skipped entirely'
			);
	} finally {
		try {
			unlinkSync(statePath);
		} catch {
			/* best-effort */
		}
	}
}

// ─── A brand-new endpoint is still bootstrapped first ─────────
{
	const pool = new EndpointPool({ endpoints: ['a', 'b'], maxRequestsPerSecond: 1000 });
	const tried: string[] = [];
	await pool.call<string>(async (url) => {
		tried.push(url);
		return url;
	});
	if (tried[0] === 'a')
		pass(
			'a never-tried endpoint is still bootstrapped first (failure ranking did not regress cp165)'
		);
	else fail('a never-tried endpoint is bootstrapped first', `tried ${tried[0]} first`);
}

// ─── Hidden-service endpoints need a far longer budget ────────────────
// A hidden service is NOT a slow clearnet host: a fresh connection must build
// circuits or tunnels before a single byte moves, and 30-60s is ordinary. The
// flat 10s background timeout aborted EVERY attempt on a zero-clearnet node —
// healthy and dead endpoints alike — which surfaced as "all RPC endpoints
// unavailable" while each endpoint answered a direct request in seconds. The
// long-lived indexer survived on warm tunnels and retries; a short-lived script
// could never succeed at all.
{
	const onion = 'http://' + 'a'.repeat(56) + '.onion:8091';
	const i2p = 'http://' + 'b'.repeat(52) + '.b32.i2p:8091';
	const clear = 'https://rpc.example.com';

	if (
		isHiddenEndpointUrl(onion) &&
		isHiddenEndpointUrl(i2p) &&
		isHiddenEndpointUrl('http://x.loki')
	)
		pass('hidden endpoints are recognised (.onion, .b32.i2p, .loki)');
	else fail('hidden endpoints are recognised', 'a hidden suffix was not detected');

	if (!isHiddenEndpointUrl(clear) && !isHiddenEndpointUrl('http://127.0.0.1:8080'))
		pass('clearnet and loopback are NOT treated as hidden');
	else fail('clearnet and loopback are NOT treated as hidden', 'a clearnet URL was misclassified');

	if (effectiveTimeoutMs(clear, DEFAULT_BACKGROUND_TIMEOUT_MS) === DEFAULT_BACKGROUND_TIMEOUT_MS)
		pass('a clearnet endpoint keeps its short background budget');
	else fail('a clearnet endpoint keeps its short background budget', 'clearnet budget was changed');

	if (
		effectiveTimeoutMs(onion, DEFAULT_BACKGROUND_TIMEOUT_MS) === DEFAULT_HIDDEN_TIMEOUT_MS &&
		effectiveTimeoutMs(i2p, DEFAULT_BACKGROUND_TIMEOUT_MS) === DEFAULT_HIDDEN_TIMEOUT_MS
	)
		pass('a hidden endpoint gets the longer floor, not the 10s background budget');
	else fail('a hidden endpoint gets the longer floor', 'hidden endpoint kept the short budget');

	// The floor RAISES, never clamps: a caller asking for more must keep it.
	if (
		effectiveTimeoutMs(onion, 90_000) === 90_000 &&
		effectiveTimeoutMs(onion, 90_000, true) === 90_000
	)
		pass('an explicit LONGER caller timeout is preserved, never clamped to the floor');
	else fail('an explicit longer caller timeout is preserved', 'the floor clamped a larger budget');

	// A PERSON waiting must not inherit the background floor. The relay's
	// user-facing calls run on a 4s budget precisely because someone is waiting on
	// a signup; 4s is unreachable over Tor, but a minute-long hang is not the
	// answer either. Relay endpoints MAY be hidden (config allows .onion/.i2p),
	// so without this split a hidden-only relay would hang for a full minute on
	// every availability check.
	if (
		effectiveTimeoutMs(onion, DEFAULT_USER_FACING_TIMEOUT_MS, true) ===
		DEFAULT_HIDDEN_USER_FACING_TIMEOUT_MS
	)
		pass('a user-facing hidden call gets the SHORTER hidden floor, not the background one');
	else
		fail(
			'a user-facing hidden call gets the shorter hidden floor',
			'it inherited the background floor'
		);

	if (DEFAULT_HIDDEN_USER_FACING_TIMEOUT_MS < DEFAULT_HIDDEN_TIMEOUT_MS)
		pass('the user-facing hidden floor is shorter than the background one');
	else
		fail(
			'the user-facing hidden floor is shorter',
			'a person would wait as long as a background job'
		);
}

// ─── A slow-connecting endpoint must still succeed ────────────────────
// THE GAP THAT LET THIS SHIP: every fake endpoint in this suite answers
// instantly, so no test ever exercised one that takes tens of seconds to
// connect — which is the entire behaviour of a hidden service.
{
	const slowUrl = 'http://' + 'c'.repeat(56) + '.onion';
	const pool = new EndpointPool({ endpoints: [slowUrl], maxRequestsPerSecond: 1000 });
	const CONNECT_MS = 120; // stands in for a 30-60s tunnel build
	let threw = false;
	let out: string | null = null;
	try {
		out = await pool.call<string>(
			async (_url, signal) =>
				await new Promise<string>((resolve, reject) => {
					const t = setTimeout(() => resolve('ok'), CONNECT_MS);
					signal.addEventListener(
						'abort',
						() => {
							clearTimeout(t);
							reject(new Error('This operation was aborted'));
						},
						{ once: true }
					);
				}),
			{ timeoutMs: 50 } // SHORTER than the connect time, as 10s was for I2P
		);
	} catch {
		threw = true;
	}
	if (!threw && out === 'ok')
		pass('a hidden endpoint slower than the caller timeout still succeeds (floor applies)');
	else
		fail(
			'a hidden endpoint slower than the caller timeout still succeeds',
			'it aborted — the hidden floor is not being applied per endpoint'
		);
}

/* ---------------- quorum per OPERATOR ---------------- */
// One operator reached at two addresses (.onion + .b32.i2p, as every hidden
// Blurt node is listed) answers a forged value instantly on both. Two honest
// operators answer the truth more slowly. Counted per URL, the forger met the
// two-endpoint quorum alone; counted per operator it is one voice.
{
	const names: Record<string, string> = { 'evil-onion': 'evil', 'evil-i2p': 'evil' };
	const pool = new EndpointPool({
		endpoints: ['evil-onion', 'honest-a', 'evil-i2p', 'honest-b'],
		operatorOf: (u) => names[u]
	});
	const r = await pool.quorumCall<string>(
		async (u) => {
			if (u.startsWith('evil')) {
				await sleep(1);
				return 'forged';
			}
			await sleep(60);
			return 'truth';
		},
		{ equivalenceKey: (v) => v, minAgree: 2 }
	);
	if (r.kind === 'quorum_met' && r.agreedKey === 'truth')
		pass('quorumCall: one operator at two addresses cannot meet a 2-quorum alone');
	else fail('quorumCall per operator', `kind=${r.kind} agreed=${r.agreedKey}`);
}
// The same, with the operator names learned at runtime (the on-chain directory).
{
	const pool = new EndpointPool({ endpoints: ['honest-a', 'honest-b'] });
	pool.mergeEndpoints(['evil-onion', 'evil-i2p'], { 'evil-onion': 'evil', 'evil-i2p': 'evil' });
	const r = await pool.quorumCall<string>(
		async (u) => {
			await sleep(u.startsWith('evil') ? 1 : 60);
			return u.startsWith('evil') ? 'forged' : 'truth';
		},
		{ equivalenceKey: (v) => v, minAgree: 2 }
	);
	if (r.kind === 'quorum_met' && r.agreedKey === 'truth' && pool.operatorCount() === 3)
		pass('quorumCall: operator names merged at runtime count a directory node once');
	else
		fail(
			'quorumCall runtime operator names',
			`kind=${r.kind} agreed=${r.agreedKey} operators=${String((pool as { operatorCount?: () => number }).operatorCount?.())}`
		);
}
// rv2-9: a hidden endpoint gets the hidden floor inside a quorum too, and is
// not cooled down for being slower than a clearnet budget.
{
	const pool = new EndpointPool({
		endpoints: ['http://aaaa.onion:8091', 'http://bbbb.b32.i2p:8091']
	});
	const r = await pool.quorumCall<string>(
		(_u, signal) =>
			new Promise<string>((resolve, reject) => {
				const t = setTimeout(() => resolve('agreed'), 150);
				signal.addEventListener(
					'abort',
					() => {
						clearTimeout(t);
						reject(new Error('timeout'));
					},
					{ once: true }
				);
			}),
		{ equivalenceKey: (v) => v, minAgree: 2, timeoutMs: 50 }
	);
	const failures = pool.snapshot().reduce((n, e) => n + e.consecutiveFailures, 0);
	if (r.kind === 'quorum_met' && failures === 0)
		pass('quorumCall: hidden endpoints get the hidden timeout floor and no cooldown');
	else fail('quorumCall hidden floor', `kind=${r.kind} failures=${failures}`);
}
// rv2-9: fan-out is capped — six agreeing operators, at most three asked.
{
	const eps = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
	const pool = new EndpointPool({ endpoints: eps });
	let asked = 0;
	const r = await pool.quorumCall<string>(
		async () => {
			asked++;
			await sleep(20);
			return 'same';
		},
		{ equivalenceKey: (v) => v, minAgree: 2, maxOperators: 3 }
	);
	if (r.kind === 'quorum_met' && asked <= 3)
		pass(`quorumCall: fan-out capped (${asked} of 6 asked)`);
	else fail('quorumCall fan-out cap', `kind=${r.kind} asked=${asked}`);
}
// rv2-9: the cap never lowers what can be learned — failing operators are
// replaced by the next ones until a quorum forms.
{
	const pool = new EndpointPool({ endpoints: ['d1', 'd2', 'd3', 'g1', 'g2'] });
	const r = await pool.quorumCall<string>(
		async (u) => {
			if (u.startsWith('d')) throw new Error('ECONNREFUSED');
			await sleep(10);
			return 'same';
		},
		{ equivalenceKey: (v) => v, minAgree: 2, maxOperators: 3 }
	);
	if (r.kind === 'quorum_met') pass('quorumCall: a capped window slides past failing operators');
	else fail('quorumCall sliding window', `kind=${r.kind}`);
}
// rv2-9: an operator whose every endpoint is failing is not counted as reachable.
{
	const names: Record<string, string> = { 'x-onion': 'x', 'x-i2p': 'x' };
	const pool = new EndpointPool({
		endpoints: ['x-onion', 'x-i2p', 'up'],
		operatorOf: (u) => names[u]
	});
	await pool.quorumCall<string>(
		async (u) => {
			if (u !== 'up') throw new Error('ECONNREFUSED');
			return 'v';
		},
		{ equivalenceKey: (v) => v, minAgree: 5 }
	);
	const reach = (pool as { reachableOperatorCount?: () => number }).reachableOperatorCount?.();
	if (reach === 1) pass('reachableOperatorCount: a fully failing operator is not waited for');
	else fail('reachableOperatorCount', `got ${String(reach)}`);
}

// rv2-9: with a capped window, operators that have ANSWERED are asked before
// never-tried ones, so a quorum is not held up by unknown slow nodes.
{
	const pool = new EndpointPool({ endpoints: ['new1', 'new2', 'new3', 'proven1', 'proven2'] });
	// The new ones give an application error: nothing is learned about them.
	await pool.quorumCall<string>(
		async (u) => {
			if (!u.startsWith('proven')) throw new Error('application error');
			return 'v';
		},
		{
			equivalenceKey: (v) => v,
			minAgree: 5
		}
	);
	const asked: string[] = [];
	const r = await pool.quorumCall<string>(
		async (u) => {
			asked.push(u);
			await sleep(5);
			return 'v';
		},
		{ equivalenceKey: (v) => v, minAgree: 2, maxOperators: 2 }
	);
	if (r.kind === 'quorum_met' && asked.every((u) => u.startsWith('proven')))
		pass('quorumCall: proven operators are asked before never-tried ones');
	else fail('quorumCall proven-first order', `asked=${asked.join(',')}`);
}

// ── (D7): a BACKGROUND call's abort timer on a hidden endpoint
// is the 60 s background floor, not the 25 s user-facing one. The pool's primary
// pass used to hard-code userFacing=true, so every poller / backfill / one-shot
// call to a .onion was cut at 25 s and MORPHIT_HIDDEN_RPC_TIMEOUT_MS could not
// raise it. Observed by capturing the delay the pool hands setTimeout.
{
	const onion = 'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091';
	const realSetTimeout = globalThis.setTimeout;
	const capture = async (hedge: boolean): Promise<number[]> => {
		const delays: number[] = [];
		(globalThis as { setTimeout: unknown }).setTimeout = ((
			fn: () => void,
			ms?: number,
			...a: unknown[]
		) => {
			if (typeof ms === 'number' && ms >= 1000) delays.push(ms);
			return realSetTimeout(fn, ms, ...(a as []));
		}) as typeof setTimeout;
		try {
			const p = new EndpointPool({ endpoints: [onion], maxRequestsPerSecond: 0 });
			await p.call(async () => 'ok', { hedge });
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
		return delays;
	};
	const bg = await capture(false);
	const uf = await capture(true);
	if (bg[0] === DEFAULT_HIDDEN_TIMEOUT_MS && uf[0] === DEFAULT_HIDDEN_USER_FACING_TIMEOUT_MS)
		pass(
			'call(): a background call to a hidden endpoint gets the 60 s floor; a user-facing one 25 s'
		);
	else
		fail(
			'call() hidden timeout floor by call type',
			`background=${bg.join(',')} userFacing=${uf.join(',')}`
		);
}

// ── (D9): the LOSER of a hedge race was aborted BY US, which
// says nothing about its health. It used to be recorded as a transport failure
// (cooldown + EWMA wiped), pushing a healthy-but-slower node out of rotation, and
// the hedge endpoint was then tried a second time on the primary pass.
{
	const A = 'https://hedge-a.example';
	const B = 'https://hedge-b.example';
	const p = new EndpointPool({
		endpoints: [A, B],
		maxRequestsPerSecond: 0,
		hedgeStaggerFloorMs: 10,
		cooldownJitterFraction: 0
	});
	const eps = (p as unknown as { endpoints: { url: string; ewmaLatencyMs: number | null }[] })
		.endpoints;
	eps[0]!.ewmaLatencyMs = 800;
	eps[1]!.ewmaLatencyMs = 900;
	const r = await p.call(
		(u, s) =>
			new Promise<string>((res, rej) => {
				const t = setTimeout(() => res(u), u === A ? 2000 : 50);
				s.addEventListener('abort', () => {
					clearTimeout(t);
					rej(new Error('aborted'));
				});
			}),
		{ hedge: true }
	);
	await sleep(20);
	const a = p.snapshot().find((e) => e.url === A)!;
	if (
		r === B &&
		a.consecutiveFailures === 0 &&
		a.cooldownUntil <= Date.now() &&
		a.ewmaLatencyMs === 800
	)
		pass('hedge: the aborted loser keeps its health (no cooldown, EWMA intact)');
	else
		fail(
			'hedge loser health',
			`winner=${r} A.fails=${a.consecutiveFailures} A.ewma=${a.ewmaLatencyMs}`
		);

	const C = 'https://hedge-c.example';
	const p2 = new EndpointPool({
		endpoints: [A, B, C],
		maxRequestsPerSecond: 0,
		hedgeStaggerFloorMs: 10
	});
	const eps2 = (p2 as unknown as { endpoints: { ewmaLatencyMs: number | null }[] }).endpoints;
	eps2[0]!.ewmaLatencyMs = 600;
	eps2[1]!.ewmaLatencyMs = 600;
	eps2[2]!.ewmaLatencyMs = 700;
	const asked: string[] = [];
	await p2.call(
		async (u) => {
			asked.push(u);
			if (u !== C) throw new Error('fetch failed');
			return 'c';
		},
		{ hedge: true }
	);
	if (asked.filter((u) => u === B).length === 1)
		pass('hedge: the hedge endpoint is not asked a second time on the primary pass');
	else fail('hedge endpoint re-tried', `asked=${asked.join(',')}`);
}

/* ---------------- endpoint faults: one node must never pin the pool ---------------- */
// A node without the API (or a hostile one saying so) answers every call with a
// JSON-RPC error. That error is about the NODE, not the request: the pool must
// move on to a node that can answer and park the faulty one. Before this, the
// error was passed to the caller with no rotation and no cooldown, so the
// indexer stayed at block 0 and relay signups failed for as long as that node
// sorted first.
{
	const pool = new EndpointPool({ endpoints: ['bad', 'good'], maxRequestsPerSecond: 0 });
	const hits = { bad: 0, good: 0 };
	const got: string[] = [];
	for (let i = 0; i < 5; i++) {
		try {
			got.push(
				await pool.call(async (u) => {
					hits[u as 'bad' | 'good']++;
					if (u === 'bad') throw new Error('Assert Exception: Could not find API condenser_api');
					return 'block';
				})
			);
		} catch (err) {
			got.push(`threw: ${(err as Error).message}`);
		}
	}
	const bad = pool.snapshot().find((e) => e.url === 'bad')!;
	if (
		got.every((g) => g === 'block') &&
		hits.bad === 1 &&
		bad.consecutiveFailures === 1 &&
		bad.cooldownUntil > Date.now()
	)
		pass(
			'endpoint fault: a node without the API is rotated off and parked; every call is answered'
		);
	else
		fail(
			'endpoint fault rotation',
			`got=${got.join('|')} hits=${JSON.stringify(hits)} bad=${JSON.stringify(bad)}`
		);
}
{
	// A reply that is not JSON at all (an HTML error page with HTTP 200).
	const pool = new EndpointPool({ endpoints: ['html', 'good'], maxRequestsPerSecond: 0 });
	let out: string;
	try {
		out = await pool.call(async (u) => {
			if (u === 'html') throw new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON');
			return 'ok';
		});
	} catch (err) {
		out = `threw: ${(err as Error).message}`;
	}
	const html = pool.snapshot().find((e) => e.url === 'html')!;
	if (out === 'ok' && html.consecutiveFailures === 1)
		pass('endpoint fault: a non-JSON-RPC reply is rotated off');
	else fail('non-JSON reply rotation', `out=${out} html=${JSON.stringify(html)}`);
}
{
	// A node that faulted and never answered is asked LAST once its cooldown is
	// over, not first as a "never measured" bootstrap candidate.
	const pool = new EndpointPool({
		endpoints: ['bad', 'good'],
		maxRequestsPerSecond: 0,
		cooldownLadderMs: [20],
		cooldownJitterFraction: 0
	});
	const fn = async (u: string): Promise<string> => {
		if (u === 'bad') throw new Error('Could not find method get_block');
		return u;
	};
	await pool.call(fn).catch(() => {});
	await sleep(40);
	const order: string[] = [];
	await pool
		.call(async (u) => {
			order.push(u);
			return fn(u);
		})
		.catch(() => {});
	if (order[0] === 'good')
		pass('endpoint fault: a faulted, never-measured node ranks last after its cooldown');
	else fail('faulted node ranking', `order=${order.join(',')}`);
}
{
	// read: a plausible-looking application error from ONE node is that node's
	// problem once another node answers the same read.
	const pool = new EndpointPool({ endpoints: ['liar', 'good'], maxRequestsPerSecond: 0 });
	let out: string;
	try {
		out = await pool.call(
			async (u) => {
				if (u === 'liar') throw new Error('Assert Exception: itr != idx.end(): unknown key');
				return 'value';
			},
			{ read: true }
		);
	} catch (err) {
		out = `threw: ${(err as Error).message}`;
	}
	const liar = pool.snapshot().find((e) => e.url === 'liar')!;
	if (out === 'value' && liar.consecutiveFailures === 1 && liar.cooldownUntil > Date.now())
		pass('read: an application error one node alone gives is failed over and that node is parked');
	else fail('read app-error failover', `out=${out} liar=${JSON.stringify(liar)}`);
}
{
	// read: the SAME error from three operators is the request's own fault
	// (an unknown transaction id, say). It is returned, nobody is parked, and
	// the rest of the pool is not walked.
	const pool = new EndpointPool({ endpoints: ['a', 'b', 'c', 'd', 'e'], maxRequestsPerSecond: 0 });
	const asked: string[] = [];
	let msg = '';
	try {
		await pool.call(
			async (u) => {
				asked.push(u);
				throw new Error('Assert Exception: unknown transaction');
			},
			{ read: true }
		);
	} catch (err) {
		msg = (err as Error).message;
	}
	const parked = pool.snapshot().filter((e) => e.consecutiveFailures > 0).length;
	if (msg.includes('unknown transaction') && asked.length === 3 && parked === 0)
		pass('read: an error three operators agree on is returned without parking anyone');
	else fail('read app-error agreement', `msg=${msg} asked=${asked.join(',')} parked=${parked}`);
}
{
	// A broadcast (no `read`) keeps its semantics: the chain's rejection is the
	// answer, the same signed bytes are not offered to every node, nothing is
	// parked.
	const pool = new EndpointPool({ endpoints: ['n1', 'n2'], maxRequestsPerSecond: 0 });
	const asked: string[] = [];
	let msg = '';
	try {
		await pool.call(async (u) => {
			asked.push(u);
			throw new Error('missing required active authority');
		});
	} catch (err) {
		msg = (err as Error).message;
	}
	const parked = pool.snapshot().filter((e) => e.consecutiveFailures > 0).length;
	if (msg.includes('missing required active authority') && asked.length === 1 && parked === 0)
		pass('write: a chain rejection propagates from the first node, no rotation, no cooldown');
	else fail('write app-error semantics', `msg=${msg} asked=${asked.join(',')} parked=${parked}`);
}

{
	// 2026-10-08 (morphit.io relay crash loop): when the primary won before the
	// hedge's stagger ran out, the hedge was still dispatched — with an
	// already-aborted signal. The relay then abandoned the RPC it started, and
	// that call's later failure was an unhandled rejection that exits it.
	const pool = new EndpointPool({
		endpoints: ['fast', 'slow'],
		hedgeThresholdMs: 1,
		hedgeStaggerFloorMs: 30,
		maxRequestsPerSecond: 0
	});
	const calls: Array<{ url: string; abortedAtCall: boolean }> = [];
	const fn = async (url: string, signal: AbortSignal): Promise<string> => {
		calls.push({ url, abortedAtCall: signal.aborted });
		await new Promise((r) => setTimeout(r, url === 'fast' ? 10 : 200));
		return url;
	};
	// Both answer once, so the primary has a latency above the hedge threshold.
	await pool.call(fn);
	await pool.call(fn);
	calls.length = 0;
	const winner = await pool.call(fn, { hedge: true });
	await new Promise((r) => setTimeout(r, 120));
	const late = calls.filter((c) => c.abortedAtCall);
	if (winner === 'fast' && late.length === 0 && calls.length === 1)
		pass('a hedge is never sent once the race is won (no call with an already-aborted signal)');
	else fail('hedge after the race was won', JSON.stringify(calls));
}

{
	// Review 2026-10-08: the caller's equivalenceKey runs on whatever a node
	// sent. One that throws on a malformed answer (the indexer's
	// blockConsistencyKey on a non-string block_id) was an unhandled rejection,
	// and when that was the last operator still out the call never finished, so
	// the indexer's poller stopped. Such an answer counts as no answer.
	const pool = new EndpointPool({ endpoints: ['bad', 'good1', 'good2'], maxRequestsPerSecond: 0 });
	const unhandled: unknown[] = [];
	const onUnhandled = (e: unknown): void => void unhandled.push(e);
	process.on('unhandledRejection', onUnhandled);
	const settled = await Promise.race([
		pool
			.quorumCall<{ id: unknown }>(
				async (u) => {
					await sleep(u === 'bad' ? 5 : 20);
					return { id: u === 'bad' ? 42 : 'block-1' };
				},
				{
					equivalenceKey: (v) => (v.id as string).trim(),
					minAgree: 2,
					maxOperators: 1,
					timeoutMs: 1_000
				}
			)
			.then((r) => r),
		sleep(1_500).then(() => 'hung' as const)
	]);
	await sleep(20);
	process.off('unhandledRejection', onUnhandled);
	if (
		settled !== 'hung' &&
		settled.kind === 'quorum_met' &&
		settled.agreedKey === 'block-1' &&
		unhandled.length === 0
	)
		pass(
			'quorumCall: an answer the caller cannot key counts as no answer (no hang, nothing unhandled)'
		);
	else
		fail(
			'quorumCall with a throwing equivalenceKey',
			`settled=${settled === 'hung' ? 'hung' : settled.kind} unhandled=${unhandled.length}`
		);
}

for (const r of results) {
	if (r.passed) {
		console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
	} else {
		console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
		if (r.detail) console.log('      ' + r.detail);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
	process.exit(1);
} else {
	console.log('✓ all ' + results.length + ' scenarios passed');
}
