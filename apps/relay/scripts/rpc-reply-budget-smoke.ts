#!/usr/bin/env tsx
/**
 * Morphit relay — RPC reply budget smoke: large HONEST replies are read, and a
 * reply too large for its request does not cool down honest nodes.
 *
 * The reply cap was one number for every request. At 8 MiB it refused honest
 * replies the code asks for: a 10,000-entry account history (the yearly P&L
 * export asks for exactly that) of a chat-active trader is 8–17 MiB, and of a
 * trader writing long messages ~40 MiB; a 100-account get_accounts batch
 * with full profiles is over 10 MiB. Worse, the refusal was worded as a
 * network fault, so every honest node took a failure and a cooldown, and
 * dblurt re-downloaded the same reply from the same node until its timeout.
 *
 * Here a real EndpointPool drives real dblurt Clients wrapped by
 * guardDblurtClient (how the relay and the indexer build theirs) against two
 * HONEST local nodes, as a read (the mode both clients use for reads).
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@beblurt/dblurt';
import { EndpointPool, isTransportError } from '@morphit/rpc-pool';
import * as rpcFetch from '@morphit/hidden-transport/rpc-fetch';

let failures = 0;
let n = 0;
function check(name: string, ok: boolean, detail = ''): void {
	n++;
	if (ok) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

const b64 = (bytes: number): string => randomBytes(bytes).toString('base64');
const MiB = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} MiB`;

/** A v2 chat custom_json history entry with real field sizes (crypto_box:
 *  ciphertext = message + 16-byte MAC, base64; the keep-history self copy). */
function chatEntry(seq: number, cipherBytes: number): unknown {
	const json = JSON.stringify({
		recipient: 'counterparty1',
		ciphertext: b64(cipherBytes),
		header: {
			v: 2,
			client_tag: randomBytes(16).toString('hex'),
			ephemeral_pub: b64(32),
			nonce: b64(24),
			self_ciphertext: b64(cipherBytes),
			self_nonce: b64(24)
		},
		order_permlink: `sell-blurt-for-usd-${randomBytes(4).toString('hex')}`
	});
	return [
		seq,
		{
			trx_id: randomBytes(20).toString('hex'),
			block: 60_000_000 + seq,
			trx_in_block: 3,
			op_in_trx: 0,
			virtual_op: 0,
			timestamp: '2026-10-01T12:00:00',
			op: [
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['activetrader'],
					id: 'morphit_chat_v1',
					json
				}
			]
		}
	];
}

/** A long blog post in history: honest, and more than any budget can hold
 *  10,000 times over. */
function postEntry(seq: number): unknown {
	return [
		seq,
		{
			trx_id: randomBytes(20).toString('hex'),
			block: 60_000_000 + seq,
			trx_in_block: 0,
			op_in_trx: 0,
			virtual_op: 0,
			timestamp: '2026-10-01T12:00:00',
			op: [
				'comment',
				{
					parent_author: '',
					parent_permlink: 'blog',
					author: 'longwriter',
					permlink: `post-${seq}`,
					title: 'A long post',
					body: 'x'.repeat(10_000),
					json_metadata: '{}'
				}
			]
		}
	];
}

function account(name: string, metaBytes: number): unknown {
	return {
		name,
		owner: { weight_threshold: 1, account_auths: [], key_auths: [[`BLT${'8'.repeat(50)}`, 1]] },
		active: { weight_threshold: 1, account_auths: [], key_auths: [[`BLT${'7'.repeat(50)}`, 1]] },
		posting: { weight_threshold: 1, account_auths: [], key_auths: [[`BLT${'6'.repeat(50)}`, 1]] },
		memo_key: `BLT${'5'.repeat(50)}`,
		json_metadata: JSON.stringify({ profile: { about: b64(metaBytes) } }),
		posting_json_metadata: JSON.stringify({ profile: { about: b64(metaBytes) } }),
		balance: '1.000 BLURT'
	};
}

type Handler = (method: string, params: unknown) => unknown;
const hits: Record<string, number> = {};
const servers: http.Server[] = [];
function node(name: string, handler: Handler): Promise<string> {
	return new Promise((resolve) => {
		const s = http
			.createServer((req, rsp) => {
				const chunks: Buffer[] = [];
				req.on('data', (c: Buffer) => chunks.push(c));
				req.on('end', () => {
					const r = JSON.parse(Buffer.concat(chunks).toString()) as {
						id: number;
						method: string;
						params: unknown[];
					};
					const method =
						r.method === 'call' ? String(r.params[1]) : r.method.replace(/^condenser_api\./, '');
					const params = r.method === 'call' ? r.params[2] : r.params;
					hits[`${name}:${method}`] = (hits[`${name}:${method}`] ?? 0) + 1;
					rsp.setHeader('content-type', 'application/json');
					rsp.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: handler(method, params) }));
				});
			})
			.listen(0, '127.0.0.1', () =>
				resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`)
			);
		servers.push(s);
	});
}

const DGP = { head_block_number: 1, time: '2026-10-01T12:00:00', last_irreversible_block_num: 1 };
const histories: Record<string, unknown[]> = {};
const accounts: unknown[] = Array.from({ length: 100 }, (_, i) => account(`acct${i}`, 40_000));
const honest: Handler = (method, params) => {
	if (method === 'get_account_history') return histories[(params as [string])[0]] ?? [];
	if (method === 'get_accounts') return accounts;
	return DGP;
};

const dir = mkdtempSync(join(tmpdir(), 'rpc-reply-budget-'));
const urls = [await node('A', honest), await node('B', honest)];
// Two operators, as two distinct public nodes would be.
const operatorOf = (u: string): string => (u === urls[0] ? 'op-a' : 'op-b');
const clients = new Map(
	urls.map((u) => [u, rpcFetch.guardDblurtClient(new Client(u, { timeout: 8000 }))] as const)
);
const pool = new EndpointPool({
	endpoints: urls,
	healthStatePath: join(dir, 'rpc-health.json'),
	operatorOf
});
const read = <T>(api: string, method: string, params: unknown[]): Promise<T> =>
	pool.call<T>((url) => clients.get(url)!.call(api, method, params) as Promise<T>, {
		read: true,
		hedge: true
	});
const replyBytes = (result: unknown): number =>
	Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
const cooled = (): string =>
	pool
		.snapshot()
		.filter((s) => s.consecutiveFailures > 0 || s.cooldownUntil > Date.now())
		.map((s) => `${s.url} failures=${s.consecutiveFailures}`)
		.join(', ');

console.log('rpc-reply-budget-smoke');

// 1, 2. Honest 10,000-entry chat histories.
for (const [label, account, cipher] of [
	['a chat-active trader (400-character messages)', 'trader400', 416],
	['a trader at the largest chat message size (1,536-character ciphertexts)', 'tradermax', 1150]
] as const) {
	histories[account] = Array.from({ length: 10_000 }, (_, i) => chatEntry(i, cipher));
	const size = replyBytes(histories[account]);
	let got = -1;
	let err = '';
	try {
		got = (await read<unknown[]>('condenser_api', 'get_account_history', [account, -1, 10_000]))
			.length;
	} catch (e) {
		err = (e as Error).message.slice(0, 160);
	}
	check(
		`the 10,000-entry history of ${label} (${MiB(size)}) is read`,
		got === 10_000,
		`entries=${got} ${err}`
	);
	check(`…and no node was cooled down`, cooled() === '', cooled());
}

// 3. Honest 100-account batch with full profiles.
{
	const size = replyBytes(accounts);
	let got = -1;
	let err = '';
	try {
		got = (
			await read<unknown[]>('condenser_api', 'get_accounts', [
				accounts.map((a) => (a as { name: string }).name)
			])
		).length;
	} catch (e) {
		err = (e as Error).message.slice(0, 160);
	}
	check(
		`a 100-account get_accounts batch with full profiles (${MiB(size)}) is read`,
		got === 100,
		`got=${got} ${err}`
	);
}

// 4. An honest reply too large for any budget, the same from every node.
{
	histories.longwriter = Array.from({ length: 10_000 }, (_, i) => postEntry(i));
	const size = replyBytes(histories.longwriter);
	for (const k of Object.keys(hits)) delete hits[k];
	const t0 = Date.now();
	let outcome = 'returned';
	try {
		await read('condenser_api', 'get_account_history', ['longwriter', -1, 10_000]);
	} catch (e) {
		outcome = (e as Error).message.slice(0, 120);
	}
	const ms = Date.now() - t0;
	const asked = (hits['A:get_account_history'] ?? 0) + (hits['B:get_account_history'] ?? 0);
	check(
		`a history no budget holds (${MiB(size)}, the same on every node) fails without cooling any node down`,
		outcome !== 'returned' && cooled() === '',
		`outcome=${outcome} cooled=[${cooled()}]`
	);
	check(
		'…promptly, with each node asked at most twice (no re-download until the client timeout)',
		ms < 4000 && asked <= 4,
		`ms=${ms} hits=${JSON.stringify(hits)}`
	);
	console.log(`      (${ms} ms; requests: ${JSON.stringify(hits)})`);
	let next = 'ok';
	try {
		await read('condenser_api', 'get_dynamic_global_properties', []);
	} catch (e) {
		next = (e as Error).message.slice(0, 120);
	}
	check('…and the next read goes through at once', next === 'ok', next);
}

// 5. Bombs stay node faults: a reply over the budget of a request whose size
//    the chain bounds (blocks), or with more values than any honest reply.
{
	const budget = (rpcFetch as { rpcReplyBudget?: (b: unknown) => { maxBytes: number } })
		.rpcReplyBudget;
	const batch = Array.from({ length: 20 }, (_, i) => ({
		jsonrpc: '2.0',
		id: i,
		method: 'condenser_api.get_block',
		params: [i + 1]
	}));
	const max = budget?.(batch).maxBytes ?? rpcFetch.RPC_REPLY_MAX_BYTES;
	const big = `[${'"x",'.repeat(Math.ceil((max + 1024) / 4))}"x"]`;
	let err: unknown = null;
	try {
		await rpcFetch.guardedRpcFetch((async () => new Response(big)) as unknown as typeof fetch)(
			'http://node.example',
			{ method: 'POST', body: JSON.stringify(batch) }
		);
	} catch (e) {
		err = e;
	}
	check(
		'a 20-block batch reply over its budget is refused as a node fault (the pool rotates off it)',
		err !== null && isTransportError(err),
		String(err)
	);
}

for (const s of servers) s.close();
rmSync(dir, { recursive: true, force: true });
console.log();
if (failures > 0) {
	console.log(`✗ ${failures} of ${n} RPC reply budget checks failed`);
	process.exit(1);
}
console.log(`✓ all ${n} RPC reply budget checks passed`);
process.exit(0);
