/**
 * D12 — ops-cli reaches the chain through the local indexer first, then (not
 * hidden-only) a health-ordered clearnet pool, and SIGNS A BROADCAST ONCE.
 *
 * Drives the REAL entry points (lookupBlurtAccount, broadcastCustomJson) against
 * a mock local indexer and two mock Blurt nodes on loopback. Global fetch is
 * wrapped so ANY request that is not to one of those mocks is refused and
 * recorded — nothing here can reach a real node, and a hidden-only node is
 * proven to never even try clearnet.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lookupBlurtAccount } from '../src/init/chainCheck.ts';
import { broadcastCustomJson } from '../src/commands/chainErrors.ts';

type Mode = 'ok' | 'down503' | 'duplicate' | 'flaky';
/** 'flaky' nodes: the FIRST broadcast any of them receives gets HTTP 503. */
let broadcastsSeen = 0;

interface Mock {
	server: Server;
	url: string;
	requests: Array<{ method: string; params: unknown }>;
	mode: Mode;
}

const HEAD = {
	head_block_number: 60_000_123,
	head_block_id: '0393877b' + 'ab'.repeat(16),
	time: '2026-09-27T00:00:00'
};

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve) => {
		let s = '';
		req.on('data', (c) => (s += c));
		req.on('end', () => {
			try {
				resolve(JSON.parse(s));
			} catch {
				resolve(null);
			}
		});
	});
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function startNode(): Promise<Mock> {
	const m = { requests: [], mode: 'ok' } as unknown as Mock;
	m.server = createServer(async (req, res) => {
		const body = (await readBody(req)) as { method?: string; params?: unknown[] } | null;
		const method = body?.method ?? '';
		m.requests.push({ method, params: body?.params });
		if (m.mode === 'down503') return send(res, 503, { error: 'down' });
		if (method === 'condenser_api.get_accounts')
			return send(res, 200, { result: [{ name: 'alice', balance: '7.000 BLURT' }] });
		if (method === 'condenser_api.get_dynamic_global_properties')
			return send(res, 200, { result: HEAD });
		if (method === 'condenser_api.broadcast_transaction_synchronous') {
			if (m.mode === 'flaky' && broadcastsSeen++ === 0) return send(res, 503, { error: 'busy' });
			if (m.mode === 'duplicate')
				return send(res, 200, { error: { message: 'Duplicate transaction check failed' } });
			return send(res, 200, { result: { id: 'node-trx', block_num: 60_000_124 } });
		}
		return send(res, 200, { result: null });
	});
	await new Promise<void>((r) => m.server.listen(0, '127.0.0.1', () => r()));
	m.url = `http://127.0.0.1:${(m.server.address() as AddressInfo).port}`;
	return m;
}

async function startIndexer(): Promise<Mock> {
	const m = { requests: [], mode: 'ok' } as unknown as Mock;
	m.server = createServer(async (req, res) => {
		const body = (await readBody(req)) as {
			method?: string;
			params?: unknown[];
			trx?: unknown;
		} | null;
		const path = req.url ?? '';
		m.requests.push({
			method: path + (body?.method ? `:${body.method}` : ''),
			params: body?.trx ?? body?.params
		});
		if (path === '/v1/chain/condenser') {
			if (body?.method === 'get_accounts')
				return send(res, 200, { result: [{ name: 'alice', balance: '9.000 BLURT' }] });
			if (body?.method === 'get_dynamic_global_properties') return send(res, 200, { result: HEAD });
		}
		if (path === '/v1/broadcast') return send(res, 200, { trx_id: 'indexer-trx' });
		return send(res, 404, { message: 'no' });
	});
	await new Promise<void>((r) => m.server.listen(0, '127.0.0.1', () => r()));
	m.url = `http://127.0.0.1:${(m.server.address() as AddressInfo).port}`;
	return m;
}

let nodeA: Mock;
let nodeB: Mock;
let indexer: Mock;
/** A loopback port nothing listens on — "the local indexer is down". */
let deadIndexer = '';
let blocked: string[] = [];
let tmp = '';
let WIF = '';

beforeAll(async () => {
	nodeA = await startNode();
	nodeB = await startNode();
	indexer = await startIndexer();
	const probe = createServer();
	await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
	deadIndexer = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
	await new Promise<void>((r) => probe.close(() => r()));
	const dblurt = (await import('@beblurt/dblurt')) as unknown as {
		PrivateKey: { fromSeed(s: string): { toString(): string } };
	};
	WIF = dblurt.PrivateKey.fromSeed('morphit-d12-test-key').toString();
});
afterAll(async () => {
	for (const m of [nodeA, nodeB, indexer])
		await new Promise<void>((r) => m.server.close(() => r()));
});

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'morphit-d12-'));
	for (const m of [nodeA, nodeB, indexer]) {
		m.requests.length = 0;
		m.mode = 'ok';
	}
	blocked = [];
	const realFetch = globalThis.fetch;
	const allowed = (): string[] => [nodeA.url, nodeB.url, indexer.url, deadIndexer];
	vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
		const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (!allowed().some((a) => u.startsWith(a))) {
			blocked.push(u);
			return Promise.reject(new Error(`fetch failed (test blocked a non-mock URL: ${u})`));
		}
		return realFetch(input, init);
	});
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	rmSync(tmp, { recursive: true, force: true });
});

const deps = (over: Record<string, unknown> = {}) => ({
	hiddenOnly: () => false,
	indexerBases: [indexer.url],
	clearnetEndpoints: [nodeA.url, nodeB.url],
	healthStatePath: join(tmp, 'rpc-health.json'),
	...over
});

describe('lookupBlurtAccount routing (D12)', () => {
	it('reads through the local indexer first — no node is asked', async () => {
		const info = await lookupBlurtAccount('alice', undefined, deps());
		expect(info?.balance).toBe('9.000 BLURT'); // the indexer's answer
		expect(nodeA.requests.length + nodeB.requests.length).toBe(0);
		expect(blocked).toEqual([]);
	});

	it('indexer down, not hidden-only → the clearnet POOL answers', async () => {
		const info = await lookupBlurtAccount(
			'alice',
			undefined,
			deps({ indexerBases: [deadIndexer] })
		);
		expect(info?.balance).toBe('7.000 BLURT'); // a node's answer
		expect(blocked).toEqual([]);
	});

	it('hidden-only + indexer down → throws, and never touches clearnet', async () => {
		await expect(
			lookupBlurtAccount(
				'alice',
				undefined,
				deps({ hiddenOnly: () => true, indexerBases: [deadIndexer] })
			)
		).rejects.toThrow();
		expect(nodeA.requests.length + nodeB.requests.length).toBe(0);
		expect(blocked).toEqual([]);
	});
});

describe('register broadcast signs ONCE (D12)', { timeout: 60_000 }, () => {
	it('indexer up → the signed trx goes to /v1/broadcast, no node is asked', async () => {
		const r = await broadcastCustomJson({
			account: 'alice',
			wif: WIF,
			opId: 'morphit_test',
			payload: {},
			deps: deps()
		});
		expect(r.trx_id).toBe('indexer-trx');
		expect(indexer.requests.some((q) => q.method === '/v1/broadcast')).toBe(true);
		expect(nodeA.requests.length + nodeB.requests.length).toBe(0);
		expect(blocked).toEqual([]);
	});

	it('indexer down, first node 503 → the SAME signed object reaches the next node (one distinct signature)', async () => {
		nodeA.mode = 'flaky';
		nodeB.mode = 'flaky';
		broadcastsSeen = 0; // whichever node gets the first broadcast answers 503
		const r = await broadcastCustomJson({
			account: 'alice',
			wif: WIF,
			opId: 'morphit_test',
			payload: {},
			deps: deps({ indexerBases: [deadIndexer] })
		});
		expect(r.trx_id).toBe('node-trx');
		const sent = [...nodeA.requests, ...nodeB.requests]
			.filter((q) => q.method === 'condenser_api.broadcast_transaction_synchronous')
			.map((q) => (q.params as unknown[])[0] as { signatures: string[] });
		expect(sent.length).toBe(2); // tried the 503 node, then the good one
		const distinct = new Set(sent.map((t) => JSON.stringify(t)));
		expect(distinct.size).toBe(1); // byte-identical signed object — signed ONCE
		expect(new Set(sent.flatMap((t) => t.signatures)).size).toBe(1);
		expect(blocked).toEqual([]);
	});

	it('a "duplicate transaction" answer is success (it already landed)', async () => {
		nodeA.mode = 'duplicate';
		nodeB.mode = 'duplicate';
		const r = await broadcastCustomJson({
			account: 'alice',
			wif: WIF,
			opId: 'morphit_test',
			payload: {},
			deps: deps({ indexerBases: [deadIndexer] })
		});
		expect(typeof r.trx_id).toBe('string');
		expect(r.trx_id.length).toBeGreaterThan(0);
	});

	it('hidden-only + indexer down → throws, never touches clearnet', async () => {
		await expect(
			broadcastCustomJson({
				account: 'alice',
				wif: WIF,
				opId: 'morphit_test',
				payload: {},
				deps: deps({ hiddenOnly: () => true, indexerBases: [deadIndexer] })
			})
		).rejects.toThrow();
		expect(nodeA.requests.length + nodeB.requests.length).toBe(0);
		expect(blocked).toEqual([]);
	});
});
