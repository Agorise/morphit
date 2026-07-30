/**
 * broadcast op-allowlist smoke (cp428).
 *
 * Regression for the Power Up / Power Down bug: the indexer's /v1/broadcast
 * relay allowlists the op types Morphit broadcasts from the browser. It had
 * `custom_json` + `transfer` (so featuring an order and sending BLURT worked)
 * but was MISSING `transfer_to_vesting` (Power Up) and `withdraw_vesting`
 * (Power Down) — so a perfectly valid, signed power-up op was rejected with
 * "operation type not permitted", which the wallet surfaced as a generic
 * "couldn't be completed on-chain" error.
 *
 * These four self-only ops MUST pass the allowlist (reach the mocked broadcast
 * → 200), and a genuinely disallowed op MUST still be refused with 400.
 */
import { broadcastRoute } from '../src/api/broadcast.ts';
import type { BlurtClient } from '../src/blurt/client.ts';

interface Scenario {
	name: string;
	run: () => Promise<string | null> | (string | null);
}
const scenarios: Scenario[] = [];

/** A BlurtClient stub whose broadcast always "succeeds", so any request that
 *  reaches it (i.e. passed the allowlist) returns 200. */
const okBlurt = {
	callCondenser: async () => ({ id: 'a'.repeat(40), block_num: 42, trx_num: 0 })
} as unknown as BlurtClient;

function tx(op: [string, Record<string, unknown>]) {
	return {
		trx: {
			ref_block_num: 1,
			ref_block_prefix: 1,
			expiration: '2026-01-01T00:00:00',
			operations: [op],
			extensions: [],
			signatures: ['deadbeef']
		}
	};
}

async function post(op: [string, Record<string, unknown>]): Promise<{ status: number; body: unknown }> {
	const app = broadcastRoute(okBlurt);
	const res = await app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(tx(op))
	});
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		/* ignore */
	}
	return { status: res.status, body };
}

const SELF_OPS: Array<[string, Record<string, unknown>]> = [
	['transfer_to_vesting', { from: 'bob', to: 'bob', amount: '100.000 BLURT' }],
	['withdraw_vesting', { account: 'bob', vesting_shares: '0.000000 VESTS' }],
	['transfer', { from: 'bob', to: 'alice', amount: '5.000 BLURT', memo: '' }],
	['custom_json', { required_auths: [], required_posting_auths: ['bob'], id: 'morphit_feedback_v1', json: '{}' }]
];

for (const op of SELF_OPS) {
	scenarios.push({
		name: `allowlisted op passes the relay → 200: ${op[0]}`,
		async run() {
			const { status, body } = await post(op);
			if (status === 400) {
				const msg =
					typeof body === 'object' && body !== null && 'message' in body
						? String((body as { message?: unknown }).message)
						: '';
				return `rejected with 400 "${msg}" — op is not allowlisted`;
			}
			return status === 200 ? null : `expected 200, got ${status}`;
		}
	});
}

scenarios.push({
	name: 'a genuinely disallowed op is still refused (allowlist is not open)',
	async run() {
		const { status, body } = await post(['account_create', { creator: 'bob', new_account_name: 'x' }]);
		if (status !== 400) return `expected 400, got ${status}`;
		const msg =
			typeof body === 'object' && body !== null && 'message' in body
				? String((body as { message?: unknown }).message)
				: '';
		return /not permitted/.test(msg) ? null : `expected "not permitted", got "${msg}"`;
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
console.log(`✓ all ${pass} broadcast-op-allowlist scenarios passed`);
