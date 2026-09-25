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
 * ORIGINALLY this file also pinned the synchronous METHOD, on the reasoning
 * that a "broadcast_transaction" (async) rewrite would drop block_num from the
 * frontend contract. That reasoning held for orders, transfers, feature bids,
 * account creation and chat-IDENTITY publication, all of which record the block
 * number — and it did NOT hold for a chat message, whose result both send paths
 * in chatService.ts discard without reading. v1.18.0 split the two: a chat
 * message uses the async method and answers before a block exists, everything
 * else is unchanged.
 *
 * The hedge guarantee this file exists for is untouched by that split and is now
 * checked on BOTH paths, because it was never really about which method was
 * called — it was about never parallel-firing a signed write.
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
				{ required_auths: [], required_posting_auths: ['tester2'], id: 'morphit_chat_v1', json: '{}' }
			]
		],
		extensions: [],
		signatures: ['deadbeef']
	}
};

/** A non-chat signed write. v1.18.0 split the broadcast method by op class —
 *  chat answers before a block, everything else still waits for one — so the
 *  hedge guarantee below has to be checked on BOTH paths, not just whichever
 *  one this file's original fixture happened to take. */
const TRANSFER_TX = {
	trx: {
		ref_block_num: 1,
		ref_block_prefix: 1,
		expiration: '2026-01-01T00:00:00',
		operations: [
			['transfer', { from: 'tester2', to: 'tester3', amount: '1.000 BLURT', memo: '' }]
		],
		extensions: [],
		signatures: ['deadbeef']
	}
};

async function post(tx: unknown): Promise<{
	status: number;
	body: unknown;
	calls: Array<{ method: string; options: RpcCallOptions }>;
}> {
	const { client, calls } = capturingBlurt();
	const app = broadcastRoute(client);
	const res = await app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(tx)
	});
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		/* a non-JSON body is itself a failure the assertions will catch */
	}
	return { status: res.status, body, calls };
}

/** A chat send from a CURRENT client, which asks for the fast answer. The flag
 *  is what makes the async path safe across versions: an older browser tab does
 *  not send it, gets the old synchronous behaviour, and cannot be handed a reply
 *  shape it would read as a failure. See the `chat_async` field in
 *  apps/indexer/src/api/broadcast.ts. */
const postChat = () => post({ ...CHAT_TX, chat_async: true });

/** The same chat transaction from an OLDER client, which does not ask. */
const postChatUnflagged = () => post(CHAT_TX);

scenarios.push({
	name: 'route reaches the broadcast (allowlisted chat op → 200)',
	async run() {
		const { status } = await postChat();
		return status === 200 ? null : `expected 200, got ${status}`;
	}
});

scenarios.push({
	name: 'a chat message broadcasts through the ASYNC broadcast_transaction, exactly once',
	async run() {
		const { calls } = await postChat();
		if (calls.length !== 1) return `expected exactly 1 callCondenser call, got ${calls.length}`;
		return calls[0].method === 'broadcast_transaction'
			? null
			: `expected method broadcast_transaction, got ${calls[0].method}`;
	}
});

scenarios.push({
	name: 'and answers with block_num null — it did not wait for a block',
	async run() {
		const { status, body } = await postChat();
		if (status !== 200) return `expected 200, got ${status}`;
		const b = body as { block_num?: unknown; trx_id?: unknown };
		if (b.block_num !== null) return `expected block_num null, got ${JSON.stringify(b.block_num)}`;
		return typeof b.trx_id === 'string' && b.trx_id.length > 0
			? null
			: 'a chat send must still return a usable trx_id';
	}
});

scenarios.push({
	name: 'a chat send that did NOT ask still waits for its block',
	async run() {
		// The version-skew guard. A browser tab from before this release calls the
		// generic submit path, which reads a null block_num as a malformed reply
		// and throws — so the user is shown a permanent failure for a message that
		// was in fact delivered, beside a retry button that sends a second copy.
		// The indexer must therefore never take the fast path on its own
		// initiative, however chat-like the transaction looks.
		const { status, body, calls } = await postChatUnflagged();
		if (status !== 200) return `expected 200, got ${status}`;
		if (calls[0]?.method !== 'broadcast_transaction_synchronous')
			return `expected the synchronous method, got ${calls[0]?.method}`;
		const b = body as { block_num?: unknown };
		return typeof b.block_num === 'number'
			? null
			: `an older client must get a numeric block_num, got ${JSON.stringify(b.block_num)}`;
	}
});

scenarios.push({
	name: 'a NON-chat write still waits for its block (synchronous, block_num returned)',
	async run() {
		const { status, body, calls } = await post(TRANSFER_TX);
		if (status !== 200) return `expected 200, got ${status}`;
		if (calls.length !== 1) return `expected exactly 1 callCondenser call, got ${calls.length}`;
		if (calls[0].method !== 'broadcast_transaction_synchronous') {
			return `a transfer must stay synchronous, got ${calls[0].method}`;
		}
		const b = body as { block_num?: unknown };
		return typeof b.block_num === 'number'
			? null
			: `a transfer must report the block it landed in, got ${JSON.stringify(b.block_num)}`;
	}
});

scenarios.push({
	name: 'a chat op riding alongside a transfer stays synchronous (ALL ops, not ANY)',
	async run() {
		const mixed = {
			trx: {
				...TRANSFER_TX.trx,
				operations: [...TRANSFER_TX.trx.operations, ...CHAT_TX.trx.operations]
			}
		};
		const { calls } = await post(mixed);
		if (calls.length !== 1) return `expected 1 call, got ${calls.length}`;
		return calls[0].method === 'broadcast_transaction_synchronous'
			? null
			: `a mixed transaction must keep block confirmation, got ${calls[0].method}`;
	}
});

scenarios.push({
	name: 'the non-chat write is ALSO never hedged',
	async run() {
		const { calls } = await post(TRANSFER_TX);
		if (calls.length !== 1) return `expected 1 call, got ${calls.length}`;
		return calls[0].options.hedge === false
			? null
			: `transfer options.hedge must be false, got ${JSON.stringify(calls[0].options.hedge)}`;
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

// ─── v1.18.0 review (W5): a duplicate is the chain already having it ───────
//
// With hedge:false the pool never parallel-fires a write — but it still
// FAILS OVER in sequence: a node that accepted the send and timed out on the
// answer is followed by the next node, which refuses the same signed
// transaction as a duplicate. For the async chat answer that duplicate is the
// success it is; everything else keeps the old reply.

async function postWithError(tx: unknown, message: string): Promise<{ status: number; body: unknown }> {
	const client = {
		callCondenser: async () => {
			throw new Error(message);
		}
	} as unknown as BlurtClient;
	const res = await broadcastRoute(client).request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(tx)
	});
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		/* checked below */
	}
	return { status: res.status, body };
}

const DUP = 'Duplicate transaction check failed';

scenarios.push({
	name: 'a chat send the chain calls a DUPLICATE is answered as the success it is',
	async run() {
		const { status, body } = await postWithError({ ...CHAT_TX, chat_async: true }, DUP);
		if (status !== 200)
			return `expected 200, got ${status} — the sender is shown a failure for a message on its way to a block`;
		const b = body as { block_num?: unknown; trx_id?: unknown };
		return b.block_num === null && typeof b.trx_id === 'string' && b.trx_id.length === 40
			? null
			: `expected {block_num:null, trx_id:<40 hex>}, got ${JSON.stringify(body)}`;
	}
});

scenarios.push({
	name: 'but a duplicate for a client that needs a block number keeps the old reply',
	async run() {
		const older = await postWithError(CHAT_TX, DUP);
		const transfer = await postWithError(TRANSFER_TX, DUP);
		return older.status === 400 && transfer.status === 400
			? null
			: `expected 400 for both, got chat ${older.status}, transfer ${transfer.status}`;
	}
});

scenarios.push({
	name: 'and any OTHER chain rejection of a chat send is still a rejection',
	async run() {
		const { status } = await postWithError({ ...CHAT_TX, chat_async: true }, 'missing required posting authority');
		return status === 400 ? null : `expected 400, got ${status}`;
	}
});

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
