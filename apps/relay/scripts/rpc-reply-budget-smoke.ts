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
 *
 * Every reply is downloaded once (v1.22.1): dblurt's per-attempt timer (500 ms
 * on the first attempt) is meant for the headers, and ran over the whole body
 * once the guard read it, so every reply slower than that was cut off and
 * requested again. The local nodes serialise their replies before they are
 * asked, so that only the transfer, not this process building a 98 MiB
 * string, is timed.
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
/** Replies as JSON bytes, built once per result (`prepare`) and not while a
 *  request waits. */
const serialised = new WeakMap<object, Buffer>();
function prepare(result: unknown): Buffer {
	if (result === null || typeof result !== 'object') return Buffer.from(JSON.stringify(result));
	let b = serialised.get(result);
	if (b === undefined) {
		b = Buffer.from(JSON.stringify(result));
		serialised.set(result, b);
	}
	return b;
}
function node(name: string, handler: Handler, bodyDelayMs = 0): Promise<string> {
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
					const result = prepare(handler(method, params));
					rsp.setHeader('content-type', 'application/json');
					rsp.flushHeaders();
					const send = (): void => {
						if (rsp.destroyed) return;
						rsp.write(`{"jsonrpc":"2.0","id":${JSON.stringify(r.id)},"result":`);
						rsp.write(result);
						rsp.end('}');
					};
					if (bodyDelayMs > 0) setTimeout(send, bodyDelayMs);
					else send();
				});
			})
			.listen(0, '127.0.0.1', () =>
				resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`)
			);
		servers.push(s);
	});
}

const DGP = { head_block_number: 1, time: '2026-10-01T12:00:00', last_irreversible_block_num: 1 };
/** dblurt's own timeout for the clients here. */
const CLIENT_TIMEOUT_MS = 8000;
const histories: Record<string, unknown[]> = {};
const accounts: unknown[] = Array.from({ length: 100 }, (_, i) => account(`acct${i}`, 40_000));
prepare(accounts);
prepare(DGP);
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
	urls.map(
		(u) => [u, rpcFetch.guardDblurtClient(new Client(u, { timeout: CLIENT_TIMEOUT_MS }))] as const
	)
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
/** Clear the request counts; `askedTwice()` then names any node asked the
 *  same method more than once since. */
const resetHits = (): void => {
	for (const k of Object.keys(hits)) delete hits[k];
};
const askedTwice = (): string =>
	Object.entries(hits)
		.filter(([, v]) => v > 1)
		.map(([k, v]) => `${k}×${v}`)
		.join(', ');

console.log('rpc-reply-budget-smoke');

// 1, 2. Honest 10,000-entry chat histories.
for (const [label, account, cipher] of [
	['a chat-active trader (400-character messages)', 'trader400', 416],
	['a trader at the largest chat message size (1,536-character ciphertexts)', 'tradermax', 1150]
] as const) {
	histories[account] = Array.from({ length: 10_000 }, (_, i) => chatEntry(i, cipher));
	const size = replyBytes(histories[account]);
	prepare(histories[account]);
	resetHits();
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
	check(`…downloaded once (no node asked twice)`, askedTwice() === '', JSON.stringify(hits));
}

// 3. Honest 100-account batch with full profiles.
{
	const size = replyBytes(accounts);
	resetHits();
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
	check(`…downloaded once (no node asked twice)`, askedTwice() === '', JSON.stringify(hits));
}

// 4. An honest reply too large for any budget, the same from every node.
{
	histories.longwriter = Array.from({ length: 10_000 }, (_, i) => postEntry(i));
	const size = replyBytes(histories.longwriter);
	prepare(histories.longwriter);
	resetHits();
	const t0 = Date.now();
	let outcome = 'returned';
	try {
		await read('condenser_api', 'get_account_history', ['longwriter', -1, 10_000]);
	} catch (e) {
		outcome = (e as Error).message.slice(0, 120);
	}
	const ms = Date.now() - t0;
	check(
		`a history no budget holds (${MiB(size)}, the same on every node) fails without cooling any node down`,
		outcome !== 'returned' && cooled() === '',
		`outcome=${outcome} cooled=[${cooled()}]`
	);
	check(
		'…at once, with each node asked once at most (no re-download until the client timeout)',
		ms < CLIENT_TIMEOUT_MS && askedTwice() === '',
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

// 5. A reply whose body takes longer than dblurt's first attempt timer (500 ms)
//    to arrive: read once. Before, it was cut off at 500 ms, 1 s, 1.5 s, … and
//    failed at the client's timeout after five requests.
{
	const slowUrl = await node('S', honest, 2_000);
	const slow = rpcFetch.guardDblurtClient(new Client(slowUrl, { timeout: CLIENT_TIMEOUT_MS }));
	resetHits();
	let outcome = 'ok';
	try {
		const r = (await slow.call('condenser_api', 'get_dynamic_global_properties', [])) as {
			head_block_number?: number;
		};
		if (r.head_block_number !== 1) outcome = `wrong reply ${JSON.stringify(r)}`;
	} catch (e) {
		outcome = (e as Error).message.slice(0, 120);
	}
	check(
		'a reply whose body arrives after 2 s is read, and asked for once',
		outcome === 'ok' && hits['S:get_dynamic_global_properties'] === 1,
		`outcome=${outcome} hits=${JSON.stringify(hits)}`
	);
}

// 6. The attempt timer still bounds the wait for the headers: dblurt's signal
//    aborts a request whose headers have not come, and only that.
{
	const guarded = (base: (init: RequestInit) => Promise<Response>): typeof fetch =>
		rpcFetch.guardedRpcFetch(
			((_: unknown, init: RequestInit) => base(init)) as unknown as typeof fetch,
			undefined,
			{ signalUntilHeaders: true }
		);
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'call',
		params: ['condenser_api', 'get_config', []]
	});
	const within = <T>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> =>
		Promise.race([
			p,
			new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))
		]);
	// No headers yet: the abort ends the request.
	const before = new AbortController();
	const pending = guarded(
		(init) =>
			new Promise<Response>((_, reject) =>
				init.signal?.addEventListener('abort', () =>
					reject(new Error('aborted before the headers'))
				)
			)
	)('http://node.example', { method: 'POST', body, signal: before.signal }).then(
		() => 'returned',
		(e: Error) => e.message
	);
	before.abort();
	const b4 = await within(pending, 2_000);
	check(
		'an abort before the headers ends the request',
		b4 === 'aborted before the headers',
		String(b4)
	);
	// Headers in, body still coming: the abort does not cut it off.
	const after = new AbortController();
	let cutOff = false;
	const res = await guarded(async (init) => {
		init.signal?.addEventListener('abort', () => (cutOff = true));
		const stream = new ReadableStream<Uint8Array>({
			start(ctl) {
				ctl.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,'));
				setTimeout(() => {
					ctl.enqueue(new TextEncoder().encode('"result":{"ok":true}}'));
					ctl.close();
				}, 300);
			}
		});
		const r = new Response(stream, { status: 200 });
		// The caller's timer fires once the headers are in, while the body is read.
		setTimeout(() => after.abort(), 50);
		return r;
	})('http://node.example', { method: 'POST', body, signal: after.signal })
		.then((r) => r.json())
		.then(
			(j) => JSON.stringify(j),
			(e: Error) => e.message
		);
	check(
		'an abort after the headers leaves the body to be read',
		res === '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' && after.signal.aborted && !cutOff,
		`reply=${res} aborted=${after.signal.aborted} cutOff=${cutOff}`
	);
}

// 7. Bombs stay node faults: a reply over the budget of a request whose size
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
