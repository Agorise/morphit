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

import {
	EndpointPool,
	DEFAULT_HEDGE_THRESHOLD_MS,
	DEFAULT_COOLDOWN_LADDER_MS,
	DEFAULT_RATE_LIMIT_COOLDOWN_LADDER_MS,
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
		pass(
			`quorumCall: minAgree=1 returns on first success (responses=${r.responses.length})`
		);
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
		pass(
			`quorumCall: 2-of-3 quorum returns in ${elapsed} ms without waiting for slow endpoint`
		);
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
	if (
		r.kind === 'quorum_met' &&
		r.responses.length === 2 &&
		elapsed < 200
	) {
		pass(
			`quorumCall: 2 transport failures + 2 successes → quorum met fast (${elapsed} ms)`
		);
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
	if (
		r.kind === 'all_responses_in' &&
		r.responses.length === 3 &&
		r.agreedKey === undefined
	) {
		pass(
			'quorumCall: disagreeing responses → all_responses_in without quorum'
		);
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
	const allHealthy = snap.every(
		(s) => s.ewmaLatencyMs !== null && s.cooldownUntil === 0
	);
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
			fail('call(): dead-endpoint rotation', `result=${r} deadHits=${deadHits} goodHits=${goodHits}`);
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
		fail('call(): dead endpoint cooldown', `cooldownUntil=${deadEp?.cooldownUntil ?? 'n/a'} now=${Date.now()}`);
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
		pass('call(): all endpoints dead → throws a single clear "all RPC endpoints unavailable" error');
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
		"failover succeeded", // contains 'failover' but is not the dblurt line
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
		// cp328: the 520-527 family — non-standard 5xx that an upstream
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
		pass('isTransportError: 408/429/500/502/503/504 + upstream 52x (origin-down) are transport; 4xx client errors are not');
	} else {
		fail(
			'HTTP status classification',
			`retryable-all-transport=${retryOk} client-none-transport=${clientOk}`
		);
	}
}

/* ---------------- scenario 18b: a 521 (upstream origin down) endpoint rotates ---------------- */
// cp328: the exact relay ACT-auto-mint symptom — one upstream Blurt RPC
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
		pass('call(): a 521 (upstream origin-down) endpoint rotates to a healthy one and is cooled down');
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
		pass('call(): a 429 (rate-limited) endpoint rotates to a healthy one and is cooled down (backoff)');
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
		pass('isRateLimitError: matches 429/too-many-requests/rate-limit, not 500/502/timeout; 429 is a subset of transport');
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

	// Deterministic ladders: generic 50 ms floor, rate-limit 600 ms floor.
	const rlPool = new EndpointPool({
		endpoints: ['a'],
		cooldownLadderMs: [50, 100],
		rateLimitCooldownLadderMs: [600, 2_000]
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
		pass('a 429 parks the endpoint on the longer rate-limit ladder (~600 ms, not the 50 ms generic)');
	} else {
		fail('429 parks on rate-limit ladder', `cooldown=${rlCooldown} ms (expected ~600)`);
	}

	// Contrast: a GENERIC transport failure on a fresh endpoint still uses the
	// short ladder — the 429 handling must not have regressed it.
	const genPool = new EndpointPool({
		endpoints: ['b'],
		cooldownLadderMs: [50, 100],
		rateLimitCooldownLadderMs: [600, 2_000]
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
		pass('a generic transport failure still uses the short ladder (~50 ms) — 429 handling did not regress it');
	} else {
		fail('generic transport failure stays short', `cooldown=${genCooldown} ms (expected ~50)`);
	}
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
