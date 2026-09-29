/**
 * /v1/broadcast — a DUPLICATE answer means the transaction LANDED (v1.20.0 fix
 * wave, D8).
 *
 * A node accepts a signed order/transfer, its reply is lost, the pool offers
 * the SAME signed bytes to the next node, and that node answers "Duplicate
 * transaction check failed". Only chat treated that as success; every other op
 * got HTTP 400 with the raw chain message — the browser told the user their
 * order/transfer failed and invited a retry, which re-signs a SECOND copy.
 * Now the route looks the transaction up and answers with its block, as for
 * any successful synchronous broadcast.
 */
import { broadcastRoute } from '../src/api/broadcast.ts';
import type { BlurtClient } from '../src/blurt/client.ts';

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

function stub(lookup: (id: string) => unknown): { client: BlurtClient; methods: string[] } {
	const methods: string[] = [];
	const client = {
		callCondenser: async (method: string, params: readonly unknown[] = []) => {
			methods.push(method);
			if (method.startsWith('broadcast_transaction'))
				throw new Error('Duplicate transaction check failed');
			if (method === 'get_transaction') return lookup(String(params[0]));
			throw new Error(`unexpected ${method}`);
		}
	} as unknown as BlurtClient;
	return { client, methods };
}
async function post(
	client: BlurtClient
): Promise<{ status: number; body: Record<string, unknown> }> {
	const app = broadcastRoute(client, undefined, undefined, { duplicateLookupDelayMs: 10 });
	const res = await app.request('/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(TRANSFER_TX)
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let failed = 0;
let n = 0;
async function check(name: string, fn: () => Promise<string | null>): Promise<void> {
	n++;
	const err = await fn().catch((e) => String(e));
	if (err === null) console.log(`  ✓ ${name}`);
	else {
		failed++;
		console.log(`  ✗ ${name}\n      ${err}`);
	}
}

console.log('broadcast duplicate-landed smoke:\n');
await check('a non-chat duplicate answers 200 with the block the transaction is in', async () => {
	const { client } = stub((id) => ({ transaction_id: id, block_num: 77 }));
	const r = await post(client);
	return r.status === 200 &&
		r.body.block_num === 77 &&
		typeof r.body.trx_id === 'string' &&
		(r.body.trx_id as string).length === 40
		? null
		: `HTTP ${r.status} ${JSON.stringify(r.body)}`;
});
await check(
	'when the block cannot be found yet, the answer says it is ALREADY on the network (never "failed, retry")',
	async () => {
		const { client, methods } = stub(() => {
			throw new Error('Unknown Transaction');
		});
		const r = await post(client);
		const msg = String(r.body.message ?? '');
		return r.status === 400 &&
			/already/i.test(msg) &&
			/do not send it again/i.test(msg) &&
			methods.filter((m) => m === 'get_transaction').length >= 2
			? null
			: `HTTP ${r.status} ${JSON.stringify(r.body)} lookups=${methods.filter((m) => m === 'get_transaction').length}`;
	}
);

console.log('');
if (failed > 0) {
	console.log(`✗ ${failed} of ${n} broadcast duplicate-landed scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${n} broadcast duplicate-landed scenarios passed`);
