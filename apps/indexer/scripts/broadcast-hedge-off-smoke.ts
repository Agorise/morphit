/**
 * broadcast hedge-off smoke (cp452).
 *
 * Regression for the ~60s send hang. The indexer's /v1/broadcast relayed a
 * SIGNED WRITE with `userFacing:true`, which `callCondenser` maps to
 * `hedge:true` — so the broadcast was parallel-fired to a second Blurt node.
 * That second node can't include a duplicate transaction, so its
 * `broadcast_transaction_synchronous` call blocks on the duplicate until the
 * tx expires (~60s), and the pool waits on it. When nodes were fast the race
 * resolved instantly ("fastchat"); once one node got slow, the loser hung to
 * expiry and every send took a minute. The relay's broadcast path forbids
 * exactly this with its own `hedge:false`; the indexer now does the same.
 *
 * This pins the fix at BOTH layers so it can't creep back:
 *   Layer 1 — the /v1/broadcast route MUST hand `callCondenser` `hedge:false`
 *             (and must NOT hand it `userFacing:true`), for the exact method
 *             it actually broadcasts with.
 *   Layer 2 — `resolveHedge` MUST honour an explicit `hedge:false` over any
 *             `userFacing`, while leaving user-facing READ hedging intact (so
 *             a fix here can't over-correct and disable read hedging).
 *
 * A "broadcast_transaction" (async) rewrite would drop block_num from the
 * frontend contract, so the fix deliberately keeps the synchronous method and
 * only removes the hedge — the single-broadcast latency is the cost of
 * correctness, same trade the relay makes.
 */
import { broadcastRoute } from '../src/api/broadcast.ts';
import { resolveHedge, type RpcCallOptions, type BlurtClient } from '../src/blurt/client.ts';

interface Scenario {
	name: string;
	run: () => Promise<string | null> | (string | null);
}
const scenarios: Scenario[] = [];

// ─── Layer 1: the route hands callCondenser hedge:false ──────────────────────

/** A BlurtClient stub that records exactly how the route invoked
 *  callCondenser (method + options) and returns a successful broadcast. */
function capturingBlurt(): {
	client: BlurtClient;
	calls: Array<{ method: string; options: RpcCallOptions }>;
} {
	const calls: Array<{ method: string; options: RpcCallOptions }> = [];
	const client = {
		callCondenser: async (
			method: string,
			_params: readonly unknown[] = [],
			options: RpcCallOptions = {}
		) => {
			calls.push({ method, options });
			// condenser_api.broadcast_transaction_synchronous shape.
			return { id: 'a'.repeat(40), block_num: 42, trx_num: 0 };
		}
	} as unknown as BlurtClient;
	return { client, calls };
}

/** A valid, allowlisted signed write (a chat message) — the exact op class
 *  whose send was hanging. */
const CHAT_TX = {
	trx: {
		ref_block_num: 1,
		ref_block_prefix: 1,
		expiration: '2026-01-01T00:00:00',
		operations: [
			[
				'custom_json',
				{ required_auths: [], required_posting_auths: ['kentest2'], id: 'morphit_chat_v1', json: '{}' }
			]
		],
		extensions: [],
		signatures: ['deadbeef']
	}
};

async function postChat(): Promise<{
	status: number;
	calls: Array<{ method: string; options: RpcCallOptions }>;
}> {
	const { client, calls } = capturingBlurt();
	const app = broadcastRoute(client);
	const res = await app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(CHAT_TX)
	});
	return { status: res.status, calls };
}

scenarios.push({
	name: 'route reaches the broadcast (allowlisted chat op → 200)',
	async run() {
		const { status } = await postChat();
		return status === 200 ? null : `expected 200, got ${status}`;
	}
});

scenarios.push({
	name: 'route broadcasts through broadcast_transaction_synchronous exactly once',
	async run() {
		const { calls } = await postChat();
		if (calls.length !== 1) return `expected exactly 1 callCondenser call, got ${calls.length}`;
		return calls[0].method === 'broadcast_transaction_synchronous'
			? null
			: `expected method broadcast_transaction_synchronous, got ${calls[0].method}`;
	}
});

scenarios.push({
	name: 'route hands callCondenser hedge:false (never hedge a signed write)',
	async run() {
		const { calls } = await postChat();
		if (calls.length !== 1) return `expected 1 call, got ${calls.length}`;
		return calls[0].options.hedge === false
			? null
			: `broadcast options.hedge must be false, got ${JSON.stringify(calls[0].options.hedge)}`;
	}
});

scenarios.push({
	name: 'route does NOT hand callCondenser userFacing:true (the original bug)',
	async run() {
		const { calls } = await postChat();
		if (calls.length !== 1) return `expected 1 call, got ${calls.length}`;
		// userFacing:true was the exact value that turned hedging on for the write.
		return calls[0].options.userFacing !== true
			? null
			: 'broadcast passed userFacing:true — that re-enables hedging on the write';
	}
});

// ─── Layer 2: resolveHedge honours explicit hedge:false, keeps read hedging ──

interface HedgeCase {
	label: string;
	options: RpcCallOptions;
	expected: boolean;
}
const HEDGE_CASES: HedgeCase[] = [
	// The write path: explicit hedge:false disables hedging.
	{ label: 'hedge:false (write) → false', options: { hedge: false }, expected: false },
	// Explicit hedge:false wins even if userFacing:true is also present, so a
	// future edit that re-adds userFacing to the broadcast still can't re-hedge.
	{
		label: 'hedge:false + userFacing:true → false (explicit wins)',
		options: { hedge: false, userFacing: true },
		expected: false
	},
	// Reads must STILL hedge — the fix must not over-correct into slow reads.
	{ label: 'userFacing:true (read) → true', options: { userFacing: true }, expected: true },
	// Background default: no hedge.
	{ label: '{} (background) → false', options: {}, expected: false },
	{ label: 'userFacing:false → false', options: { userFacing: false }, expected: false },
	// Explicit hedge:true still hedges.
	{ label: 'hedge:true → true', options: { hedge: true }, expected: true }
];

for (const c of HEDGE_CASES) {
	scenarios.push({
		name: `resolveHedge ${c.label}`,
		run() {
			const got = resolveHedge(c.options);
			return got === c.expected ? null : `expected ${c.expected}, got ${got}`;
		}
	});
}

// ─── runner ───
let pass = 0;
let fail = 0;
for (const s of scenarios) {
	try {
		const err = await s.run();
		if (err) {
			console.log(`  ✗ ${s.name}: ${err}`);
			fail++;
		} else {
			console.log(`  ✓ ${s.name}`);
			pass++;
		}
	} catch (e) {
		console.log(`  ✗ ${s.name}: threw ${e instanceof Error ? e.message : String(e)}`);
		fail++;
	}
}
console.log('');
if (fail > 0) {
	console.log(`✗ ${fail} failed, ${pass} passed`);
	process.exit(1);
}
console.log(`✓ all ${pass} broadcast-hedge-off scenarios passed`);
