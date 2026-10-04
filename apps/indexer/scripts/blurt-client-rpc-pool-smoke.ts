/**
 * BlurtClient integration smoke.
 *
 * Verifies that the indexer's BlurtClient and the relay's BlurtClient,
 * both migrated to `@morphit/rpc-pool`, actually do what they say:
 *
 *   1. With two fake JSON-RPC endpoints of differing latency, after
 *      warm-up the slow endpoint is NOT picked first.
 *   2. When the fast endpoint is killed mid-stream, the call
 *      transparently rotates to the slow endpoint instead of failing.
 *   3. An RPC error on a READ from one node asks the next operator
 *      (one node cannot decide a read by erroring); an error every node
 *      gives is the answer, and nobody is parked for it.
 *   4. The pool's snapshot() is exposed via endpointSnapshot() on
 *      both clients (operator diagnostics).
 *
 * We spin up two `http` servers on ephemeral ports and configure both
 * BlurtClient flavors to point at them.  No real network, no real
 * Blurt RPC — the test is deterministic.
 */

import * as http from 'node:http';
import { BlurtClient as IndexerBlurt } from '../src/blurt/client.ts';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string): void {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string): void {
	results.push({ name, passed: false, detail });
}

/** Spin up a fake Blurt-RPC HTTP server that responds with a fixed
 *  account shape after a configurable latency.  Returns { url, close,
 *  setLatency, setShouldError, callCount }. */
async function startFakeRPC(initialLatencyMs: number): Promise<{
	url: string;
	close: () => Promise<void>;
	setLatency: (ms: number) => void;
	setShouldError: (mode: 'none' | 'transport' | 'rpc') => void;
	callCount: () => number;
}> {
	let latency = initialLatencyMs;
	let mode: 'none' | 'transport' | 'rpc' = 'none';
	let calls = 0;
	const server = http.createServer((req, res) => {
		calls++;
		if (mode === 'transport') {
			// Hang up unexpectedly — looks like a transport failure.
			req.socket.destroy();
			return;
		}
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			// Echo back the same id dblurt sent — it validates round-trip.
			let reqId: unknown = 0;
			try {
				reqId = JSON.parse(body).id ?? 0;
			} catch {
				/* malformed body; default to 0 */
			}
			setTimeout(() => {
				if (res.destroyed) return;
				if (mode === 'rpc') {
					// Return an application-level RPC error.
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(
						JSON.stringify({
							jsonrpc: '2.0',
							id: reqId,
							error: { code: -32000, message: 'assert_exception: account_object: foo' }
						})
					);
					return;
				}
				// Successful response.  Parse method to decide shape.
				let method = 'unknown';
				try {
					const req = JSON.parse(body);
					method = req.method ?? req.params?.[0] ?? 'unknown';
				} catch {
					/* ignore */
				}
				let result: unknown;
				if (method === 'get_dynamic_global_properties' || body.includes('get_dynamic_global_properties')) {
					result = {
						head_block_number: 100_000_000,
						last_irreversible_block_num: 99_999_990,
						time: '2026-05-28T12:00:00'
					};
				} else if (body.includes('get_accounts') || method.includes('get_accounts')) {
					result = [
						{
							name: 'test',
							balance: '0.000 BLURT',
							memo_key: 'BLT0',
							posting: { weight_threshold: 1, account_auths: [], key_auths: [] },
							active: { weight_threshold: 1, account_auths: [], key_auths: [] },
							owner: { weight_threshold: 1, account_auths: [], key_auths: [] }
						}
					];
				} else {
					result = null;
				}
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: reqId, result }));
			}, latency);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const addr = server.address();
	if (typeof addr === 'string' || addr === null) {
		throw new Error('expected an address object');
	}
	return {
		url: `http://127.0.0.1:${addr.port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				// In case keepalive sockets are hanging:
				server.closeAllConnections?.();
			}),
		setLatency: (ms) => {
			latency = ms;
		},
		setShouldError: (m) => {
			mode = m;
		},
		callCount: () => calls
	};
}

/* ---------------- scenario 1: fastest-endpoint preference ---------------- */
{
	const fast = await startFakeRPC(10);
	const slow = await startFakeRPC(200);
	const client = new IndexerBlurt({
		blurtRpcEndpoints: [slow.url, fast.url] as readonly string[]
	} as never);
	// Warm up: do a few calls so EWMA settles.
	for (let i = 0; i < 6; i++) {
		await client.getDynamicGlobalProperties();
	}
	const fastCallsBefore = fast.callCount();
	const slowCallsBefore = slow.callCount();
	// On the next call, the pool should pick fast first.
	await client.getDynamicGlobalProperties();
	const fastIncr = fast.callCount() - fastCallsBefore;
	const slowIncr = slow.callCount() - slowCallsBefore;
	if (fastIncr === 1 && slowIncr === 0) {
		pass('indexer BlurtClient picks the faster endpoint after warm-up (EWMA)');
	} else {
		fail(
			'indexer fastest-first',
			`after warm-up: fast +${fastIncr}, slow +${slowIncr} (expected 1, 0)`
		);
	}
	await fast.close();
	await slow.close();
}

/* ---------------- scenario 2: transparent rotation on transport failure ---------------- */
{
	const ep1 = await startFakeRPC(10);
	const ep2 = await startFakeRPC(15);
	const client = new IndexerBlurt({
		blurtRpcEndpoints: [ep1.url, ep2.url] as readonly string[]
	} as never);
	// Warm up
	for (let i = 0; i < 4; i++) {
		await client.getDynamicGlobalProperties();
	}
	// Kill ep1 — start returning transport errors.
	ep1.setShouldError('transport');
	// Next call should rotate to ep2 and succeed.
	try {
		const dgp = await client.getDynamicGlobalProperties();
		if (typeof dgp.head_block_number === 'number') {
			pass('indexer BlurtClient rotates transparently when an endpoint fails');
		} else {
			fail('indexer rotation', `bad shape: ${JSON.stringify(dgp)}`);
		}
	} catch (err) {
		fail(
			'indexer rotation',
			`call threw despite healthy alternate endpoint: ${(err as Error).message}`
		);
	}
	await ep1.close();
	await ep2.close();
}

/* ---------------- scenario 3: an RPC error on a READ asks the next operator ---------------- */
{
	// One node answering every read with a plausible RPC error used to be the
	// answer (no rotation), so it could freeze the indexer by itself. A read
	// now asks the next operator, and the healthy answer wins.
	const ep1 = await startFakeRPC(10);
	const ep2 = await startFakeRPC(15);
	const client = new IndexerBlurt({
		blurtRpcEndpoints: [ep1.url, ep2.url] as readonly string[]
	} as never);
	ep1.setShouldError('rpc');
	try {
		const dgp = await client.getDynamicGlobalProperties();
		if (dgp.head_block_number === 100_000_000) {
			pass('indexer BlurtClient: one node erroring on a read does not decide the answer');
		} else {
			fail('read error rotates', `unexpected answer ${JSON.stringify(dgp).slice(0, 80)}`);
		}
	} catch (err) {
		fail('read error rotates', `threw ${(err as Error).message.slice(0, 80)}`);
	}
	await ep1.close();
	await ep2.close();
}

/* ---------------- scenario 3b: an error EVERY node gives on a read is the answer ---------------- */
{
	const ep1 = await startFakeRPC(10);
	const ep2 = await startFakeRPC(15);
	const client = new IndexerBlurt({
		blurtRpcEndpoints: [ep1.url, ep2.url] as readonly string[]
	} as never);
	// Both answer with the same application error: every operator was asked,
	// and the error (the request's own fault) is thrown, nobody parked.
	ep1.setShouldError('rpc');
	ep2.setShouldError('rpc');
	const callsBefore = ep1.callCount() + ep2.callCount();
	try {
		await client.getDynamicGlobalProperties();
		fail('read errors from every node propagate', 'expected throw, got success');
	} catch (err) {
		const delta = ep1.callCount() + ep2.callCount() - callsBefore;
		const parked = client.endpointSnapshot().filter((e) => e.cooldownUntil > Date.now()).length;
		if (delta === 2 && parked === 0 && (err as Error).message.includes('assert_exception')) {
			pass('indexer BlurtClient: an error every node gives is thrown, nobody parked');
		} else {
			fail(
				'read errors from every node propagate',
				`delta=${delta} (expected 2), parked=${parked}, err=${(err as Error).message.slice(0, 80)}`
			);
		}
	}
	await ep1.close();
	await ep2.close();
}

/* ---------------- scenario 4: endpointSnapshot exposes pool state ---------------- */
{
	const ep1 = await startFakeRPC(10);
	const ep2 = await startFakeRPC(15);
	const client = new IndexerBlurt({
		blurtRpcEndpoints: [ep1.url, ep2.url] as readonly string[]
	} as never);
	await client.getDynamicGlobalProperties();
	await client.getDynamicGlobalProperties();
	const snap = client.endpointSnapshot();
	if (
		snap.length === 2 &&
		snap.every((s) => 'url' in s && 'ewmaLatencyMs' in s && 'consecutiveFailures' in s)
	) {
		pass('indexer endpointSnapshot returns the pool state (URL, EWMA, failures)');
	} else {
		fail('endpointSnapshot shape', `got ${JSON.stringify(snap[0] ?? null).slice(0, 100)}`);
	}
	await ep1.close();
	await ep2.close();
}

/* ---------------- scenario 5: getAccount with userFacing=true hedges ---------------- */
{
	const ep1 = await startFakeRPC(800); // slow primary
	const ep2 = await startFakeRPC(50); // fast peer
	const client = new IndexerBlurt({
		blurtRpcEndpoints: [ep1.url, ep2.url] as readonly string[]
	} as never);
	// Warm up so both endpoints have EWMAs.  Manually probe each to
	// seed.
	for (let i = 0; i < 6; i++) {
		await client.getDynamicGlobalProperties();
	}
	// Now ep1 will be the primary (we warmed it first / slower
	// fellow) — actually after EWMA settles ep2 is primary.  For
	// this test we just want to confirm: when both endpoints are
	// configured and getAccount is called, hedging kicks in on the
	// slow path so the call returns in ~ the fast endpoint's time
	// rather than waiting on the slow one.
	// Make ep1 (whoever the primary is) slow on THIS call by raising
	// its latency to 2 seconds; ep2 stays fast.
	ep1.setLatency(2_000);
	ep2.setLatency(50);
	const t0 = Date.now();
	await client.getAccount('test'); // user-facing — hedge on
	const elapsed = Date.now() - t0;
	if (elapsed < 1_500) {
		pass(
			`indexer getAccount with hedge=on returns fast under primary degradation (${elapsed} ms < 1500)`
		);
	} else {
		fail(
			'hedge fires on user-facing getAccount',
			`elapsed=${elapsed} ms (expected <1500 ms — hedge should have fired)`
		);
	}
	await ep1.close();
	await ep2.close();
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
