/**
 * A JSON-RPC batch is many requests in one HTTP body. The SDK runs every
 * message in it, and each tools/call can fan out to upstream fetches, but the
 * HTTP rate limit took ONE token per body: a client sent 100 tools/call in one
 * POST and got 100 replies for the price of one request. Runs the real server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(ROOT, '..', '..', 'node_modules', '.bin', 'tsx');

function post(port: number, body: unknown): Promise<{ status: number; body: string }> {
	const data = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const r = request(
			{
				host: '127.0.0.1',
				port,
				path: '/mcp',
				method: 'POST',
				headers: {
					host: `127.0.0.1:${port}`,
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					'content-length': Buffer.byteLength(data)
				}
			},
			(res) => {
				let b = '';
				res.on('data', (c) => (b += c));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
			}
		);
		r.on('error', reject);
		r.end(data);
	});
}

async function boot(port: number, perMin: number): Promise<ChildProcess> {
	const child = spawn(TSX, [join(ROOT, 'src', 'main.ts')], {
		env: {
			...process.env,
			MORPHIT_MCP_TRANSPORT: 'http',
			MORPHIT_MCP_HTTP_HOST: '127.0.0.1',
			MORPHIT_MCP_HTTP_PORT: String(port),
			MORPHIT_MCP_RATE_LIMIT_PER_MIN: String(perMin)
		},
		stdio: ['ignore', 'ignore', 'pipe']
	});
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('server did not start')), 30_000);
		child.stderr!.on('data', (d: Buffer) => {
			if (/listening on/.test(d.toString())) {
				clearTimeout(t);
				resolve();
			}
		});
	});
	return child;
}

/** n tools/call messages. An unknown tool answers without any upstream fetch. */
const batch = (n: number, from = 1) =>
	Array.from({ length: n }, (_, i) => ({
		jsonrpc: '2.0',
		id: from + i,
		method: 'tools/call',
		params: { name: 'morphit_no_such_tool', arguments: {} }
	}));

const base = 30000 + (process.pid % 5000) * 2;
let small: ChildProcess;
let large: ChildProcess;
beforeAll(async () => {
	[small, large] = await Promise.all([boot(base, 5), boot(base + 1, 100_000)]);
}, 60_000);
afterAll(() => {
	small?.kill();
	large?.kill();
});

describe('JSON-RPC batches against the HTTP rate limit', () => {
	it('every message in a batch costs a token (limit 5: a batch of 3 runs, the next 3 are refused)', async () => {
		const first = await post(base, batch(3));
		expect(first.status, first.body).toBe(200);
		expect(JSON.parse(first.body)).toHaveLength(3);
		const second = await post(base, batch(3, 10));
		expect(second.status, `3 more calls ran with 2 tokens left: ${second.body.slice(0, 200)}`).toBe(
			429
		);
	});

	it('a 100-call batch is not run, however high the limit', async () => {
		const r = await post(base + 1, batch(100));
		expect(r.status, `ran ${r.body.split('"jsonrpc"').length - 1} calls`).not.toBe(200);
		expect(r.body).not.toMatch(/"id":100\b/);
	});

	it('a single request still works', async () => {
		const r = await post(base + 1, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
		expect(r.status, r.body).toBe(200);
		expect(r.body).toMatch(/morphit_search_orders/);
	});
});
