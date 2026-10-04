#!/usr/bin/env tsx
/**
 * Morphit relay — RPC reply bomb smoke.
 *
 * Every Blurt RPC node the relay reads from is a third party. A reply that is
 * small on the wire but huge once parsed — millions of `{}` — used to pass the
 * byte cap (32 MiB) and parse to over a gigabyte of heap, so the kernel killed
 * the relay at its MemoryMax (512M); systemd restarted it and the next reply
 * killed it again. Any one listed node could keep every relay down.
 *
 * Each scenario runs the REAL BlurtClient.getAccount in a child process whose
 * V8 heap is held under the relay's MemoryMax, against a local node that sends
 * the bomb, and requires: the call rejects (the process lives), and the
 * child's peak RSS stays under 512 MiB. A realistic large honest reply (a
 * 20-block batch) must still pass the parse guard.
 *
 * Wired into scripts/run-smokes.sh.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rpcFetch from '@morphit/hidden-transport/rpc-fetch';

const { RPC_REPLY_MAX_BYTES } = rpcFetch;

const here = dirname(fileURLToPath(import.meta.url));
const MEMORY_MAX = 512 * 1024 * 1024;
/** V8 heap ceiling for the child: what is left of 512M after the runtime. */
const CHILD_HEAP_MB = 448;

// ─── child mode: one getAccount against the given node ──────────────────────
if (process.argv[2] === '--child') {
	const url = process.argv[3]!;
	let peak = 0;
	const sample = (): void => {
		peak = Math.max(peak, process.memoryUsage().rss);
	};
	const timer = setInterval(sample, 20);
	const { BlurtClient } = await import('../src/blurt/client.ts');
	const c = new BlurtClient([url], 100);
	let outcome: string;
	try {
		await c.getAccount('alice');
		outcome = 'returned';
	} catch {
		outcome = 'rejected';
	}
	sample();
	clearInterval(timer);
	console.log(JSON.stringify({ outcome, peak }));
	process.exit(0);
}

// ─── child mode: concurrent 10,000-entry history reads (the largest budget) ──
if (process.argv[2] === '--child-history') {
	const url = process.argv[3]!;
	const legs = Number(process.argv[4] ?? '2');
	let peak = 0;
	const sample = (): void => {
		peak = Math.max(peak, process.memoryUsage().rss);
	};
	const timer = setInterval(sample, 10);
	const { Client } = await import('@beblurt/dblurt');
	const outcomes = await Promise.all(
		Array.from({ length: legs }, async () => {
			const c = rpcFetch.guardDblurtClient(new Client(url, { timeout: 5000 }));
			try {
				const r = (await c.call('condenser_api', 'get_account_history', [
					'bomb',
					-1,
					10_000
				])) as unknown[];
				sample();
				return r.length > 0 ? 'returned' : 'empty';
			} catch (err) {
				return `rejected:${(err as Error).name}`;
			}
		})
	);
	sample();
	clearInterval(timer);
	console.log(JSON.stringify({ outcome: outcomes.join(','), peak }));
	process.exit(0);
}

// ─── parent ─────────────────────────────────────────────────────────────────
let failures = 0;
let scenarios = 0;
function report(name: string, ok: boolean, detail: string): void {
	scenarios++;
	if (ok) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name}\n      ${detail}`);
	}
}

/** A node that answers every call with `{"result":[{},{},…]}` of `bytes` bytes. */
function bombNode(bytes: number): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		let b = '';
		req.on('data', (d) => (b += d));
		req.on('end', () => {
			const id = (JSON.parse(b) as { id: number }).id;
			const head = `{"jsonrpc":"2.0","id":${id},"result":[`;
			const n = Math.max(1, Math.floor((bytes - head.length - 4) / 3));
			res.setHeader('content-type', 'application/json');
			res.write(head);
			const chunk = '{},'.repeat(100_000);
			let left = n - 1;
			while (left >= 100_000) {
				res.write(chunk);
				left -= 100_000;
			}
			res.write('{},'.repeat(left));
			res.end('{}]}');
		});
	});
	return new Promise((r) =>
		server.listen(0, '127.0.0.1', () =>
			r({
				url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
				close: () => new Promise((c) => server.close(() => c()))
			})
		)
	);
}

/** A node whose every reply is `{"jsonrpc":"2.0","id":…,"result":<body>}`,
 *  written in 1 MiB pieces. */
function payloadNode(
	body: () => Iterable<string>
): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		let b = '';
		req.on('data', (d) => (b += d));
		req.on('end', () => {
			const id = (JSON.parse(b) as { id: number }).id;
			res.setHeader('content-type', 'application/json');
			res.write(`{"jsonrpc":"2.0","id":${id},"result":`);
			for (const piece of body()) res.write(piece);
			res.end('}');
		});
	});
	return new Promise((r) =>
		server.listen(0, '127.0.0.1', () =>
			r({
				url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
				close: () => new Promise((c) => server.close(() => c()))
			})
		)
	);
}

function* repeated(unit: string, count: number): Iterable<string> {
	const per = Math.max(1, Math.floor((1024 * 1024) / unit.length));
	let left = count;
	while (left > 0) {
		const k = Math.min(per, left);
		yield unit.repeat(k);
		left -= k;
	}
}

function runChild(
	url: string,
	stateDir: string,
	mode = '--child',
	extra: string[] = []
): Promise<{ code: number | null; out: string }> {
	return new Promise((r) => {
		const tsx = resolve(here, '../../../node_modules/.bin/tsx');
		const child = spawn(tsx, [fileURLToPath(import.meta.url), mode, url, ...extra], {
			env: {
				...process.env,
				NODE_OPTIONS: `--max-old-space-size=${CHILD_HEAP_MB}`,
				MORPHIT_RPC_HEALTH_STATE: join(stateDir, 'rpc-health.json')
			},
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('exit', (code) => r({ code, out }));
	});
}

const stateDir = mkdtempSync(join(tmpdir(), 'relay-rpc-bomb-'));
try {
	for (const [name, bytes] of [
		['a reply of {} objects just under the byte cap', RPC_REPLY_MAX_BYTES - 64],
		['a 20 MiB reply of {} objects', 20 * 1024 * 1024]
	] as const) {
		const node = await bombNode(bytes);
		const { code, out } = await runChild(node.url, stateDir);
		await node.close();
		const line = out.split('\n').find((l) => l.startsWith('{"outcome"'));
		const res = line ? (JSON.parse(line) as { outcome: string; peak: number }) : null;
		report(
			`${name}: the call is refused and the relay process survives under 512M`,
			code === 0 && res?.outcome === 'rejected' && res.peak < MEMORY_MAX,
			`exit=${code} result=${line ?? 'none'} tail=${out.slice(-300).replace(/\s+/g, ' ')}`
		);
	}

	// The worst reply the guard still lets through (just under the value limit;
	// each `{},` counts twice, as a container and as an element) must parse
	// inside the same budget.
	if (typeof rpcFetch.RPC_REPLY_MAX_VALUES === 'number') {
		const node = await bombNode(3 * (rpcFetch.RPC_REPLY_MAX_VALUES / 2 - 100));
		const { code, out } = await runChild(node.url, stateDir);
		await node.close();
		const line = out.split('\n').find((l) => l.startsWith('{"outcome"'));
		const res = line ? (JSON.parse(line) as { outcome: string; peak: number }) : null;
		report(
			`the largest reply the parse guard accepts is parsed well under 512M (peak ${res ? Math.round(res.peak / 1048576) : '?'} MiB)`,
			code === 0 && res?.outcome === 'returned' && res.peak < MEMORY_MAX / 2,
			`exit=${code} result=${line ?? 'none'} tail=${out.slice(-300).replace(/\s+/g, ' ')}`
		);
	} else {
		report('the parse guard exists', false, 'RPC_REPLY_MAX_VALUES is not exported');
	}

	// The largest budget any request gets — a 10,000-entry account history —
	// with the worst replies the guard still accepts under it, read by two
	// concurrent calls (a hedged read runs two legs at once).
	const ceiling =
		(rpcFetch as { RPC_REPLY_CEILING_BYTES?: number }).RPC_REPLY_CEILING_BYTES ??
		RPC_REPLY_MAX_BYTES;
	const maxValues = rpcFetch.RPC_REPLY_MAX_VALUES;
	const room = ceiling - 4096;
	const bombs: Array<[string, () => Iterable<string>]> = [
		[
			'containers up to the value limit, then a filler string up to the byte cap',
			function* () {
				yield '[';
				const objs = Math.floor(maxValues / 2) - 100; // each `{},` counts twice
				yield* repeated('{},', objs);
				const filler = room - 3 * objs - 8;
				yield '"';
				yield* repeated('x', filler);
				yield '"]';
			}
		],
		[
			'one string of two-byte characters up to the byte cap (a UTF-16 string once parsed)',
			function* () {
				yield '["';
				yield* repeated('\u00e9', Math.floor(room / 2));
				yield '"]';
			}
		],
		[
			'short strings up to the value limit, filling the byte cap',
			function* () {
				const count = maxValues - 100;
				const len = Math.max(1, Math.floor(room / count) - 3);
				yield '[';
				yield* repeated(`"${'s'.repeat(len)}",`, count - 1);
				yield `"${'s'.repeat(len)}"]`;
			}
		],
		[
			'a reply over the byte cap',
			function* () {
				yield '["';
				yield* repeated('x', ceiling + 1024);
				yield '"]';
			}
		]
	];
	for (const [name, body] of bombs) {
		const node = await payloadNode(body);
		const { code, out } = await runChild(node.url, stateDir, '--child-history', ['2']);
		await node.close();
		const line = out.split('\n').find((l) => l.startsWith('{"outcome"'));
		const res = line ? (JSON.parse(line) as { outcome: string; peak: number }) : null;
		report(
			`history budget (${Math.round(ceiling / 1048576)} MiB), ${name}: two concurrent reads, the process survives under 512M (peak ${res ? Math.round(res.peak / 1048576) : '?'} MiB)`,
			code === 0 && res !== null && res.peak < MEMORY_MAX,
			`exit=${code} result=${line ?? 'none'} tail=${out.slice(-300).replace(/\s+/g, ' ')}`
		);
	}

	// An honest large reply still parses: a JSON-RPC batch of 20 blocks, each
	// holding as many transfers as a 64 KB block can (~650).
	const transfer = (i: number) => [
		'transfer',
		{ from: `sender${i}`, to: `receiver${i}`, amount: '1.000 BLURT', memo: `memo ${i}` }
	];
	const tx = (i: number) => ({
		ref_block_num: i,
		ref_block_prefix: 123456789,
		expiration: '2026-10-01T00:00:00',
		operations: [transfer(i)],
		extensions: [],
		signatures: ['1f'.padEnd(130, 'a')]
	});
	const block = (n: number) => ({
		previous: '0'.repeat(40),
		timestamp: '2026-10-01T00:00:00',
		witness: 'witness',
		transaction_merkle_root: '0'.repeat(40),
		extensions: [],
		witness_signature: '1f'.padEnd(130, 'b'),
		transactions: Array.from({ length: 650 }, (_, i) => tx(i)),
		block_id: n.toString(16).padStart(40, '0'),
		signing_key: 'BLT5'.padEnd(53, 'x'),
		transaction_ids: Array.from({ length: 650 }, (_, i) => i.toString(16).padStart(40, '0'))
	});
	const batch = JSON.stringify(
		Array.from({ length: 20 }, (_, i) => ({ jsonrpc: '2.0', id: i, result: block(1000 + i) }))
	);
	const bytes = new TextEncoder().encode(batch);
	let honest = 'accepted';
	try {
		if (typeof rpcFetch.checkRpcReplyShape !== 'function') throw new Error('no parse guard');
		rpcFetch.checkRpcReplyShape(bytes);
	} catch (err) {
		honest = (err as Error).message;
	}
	report(
		`an honest 20-block batch (${(bytes.byteLength / 1048576).toFixed(1)} MiB) passes the parse guard and the byte cap`,
		honest === 'accepted' && bytes.byteLength < RPC_REPLY_MAX_BYTES,
		`guard=${honest} bytes=${bytes.byteLength} cap=${RPC_REPLY_MAX_BYTES}`
	);
} finally {
	rmSync(stateDir, { recursive: true, force: true });
}

console.log();
if (failures > 0) {
	console.log(`✗ ${failures} of ${scenarios} RPC reply bomb scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} RPC reply bomb scenarios passed`);
