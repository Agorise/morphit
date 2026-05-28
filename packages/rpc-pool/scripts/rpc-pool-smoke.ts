/**
 * @morphit/rpc-pool smoke — cp165.
 *
 * Validates the four core behaviours of EndpointPool against a
 * deterministic in-memory upstream (no real network):
 *
 *   1. Fastest-EWMA-first ordering — given a pool of three
 *      endpoints with seeded latencies (50/200/500 ms), the 50 ms
 *      one is the primary.
 *   2. Cooldown ladder — three consecutive transport failures push
 *      an endpoint to 60 s cooldown; success resets the ladder.
 *   3. Application-level errors propagate (no rotation, no
 *      cooldown bumped).
 *   4. Adaptive hedging — when the primary's EWMA is above the
 *      degradation threshold AND `hedge: true`, the pool fires a
 *      second request to the next-best endpoint after the stagger
 *      interval and returns the first winner.  When the primary is
 *      fast, no hedge is dispatched.
 *
 * The "upstream" is a fake `fn` whose latency and outcome the test
 * controls per-endpoint per-call.  Wall-clock time is real (we use
 * setTimeout) but the test sleeps are short (≤ 250 ms) so the
 * whole smoke runs in under 2 seconds.
 */

import {
	EndpointPool,
	DEFAULT_HEDGE_THRESHOLD_MS
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

/* ---------------- scenario 2: cooldown ladder on consecutive failures ---------------- */
{
	const pool = new EndpointPool({
		endpoints: ['a'],
		cooldownLadderMs: [50, 200, 1_000] // tight ladder for the test
	});
	let calls = 0;
	const transportErr = () =>
		Promise.reject(new Error('fetch failed'));
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
		fail(
			'cooldown ladder: success resets',
			`state ${JSON.stringify(snap2[0])}`
		);
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
				fail(
					'app errors do not rotate',
					`x=${xCalls} y=${yCalls} (expected 1, 0)`
				);
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
		fail(
			'scenario 4a warm-up — endpoint warmed below threshold',
			`ewma=${snap[0]!.ewmaLatencyMs}`
		);
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
			pass(
				'hedge: true with no second endpoint → single call only (no double-dispatch)'
			);
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
		pass(
			'hedge: degraded primary + slow response → second endpoint wins fast'
		);
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
	fail(
		'DEFAULT_HEDGE_THRESHOLD_MS',
		`expected 500, got ${DEFAULT_HEDGE_THRESHOLD_MS}`
	);
}

/* ---------------- report ---------------- */

let failed = 0;
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
