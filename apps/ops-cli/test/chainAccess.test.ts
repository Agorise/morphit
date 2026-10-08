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
import { chainRead } from '../src/lib/chainAccess.ts';

type Mode = 'ok' | 'down503' | 'duplicate' | 'flaky' | 'rpcerror' | 'slow' | 'bad400' | 'err502';
/** 'slow' indexer: answers after this many ms (a chain read over Tor). */
const SLOW_MS = 1500;
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
		// A node that answers every read with a generic JSON-RPC error.
		if (m.mode === 'rpcerror' && method !== 'condenser_api.broadcast_transaction_synchronous')
			return send(res, 200, {
				jsonrpc: '2.0',
				id: 1,
				error: { code: -32000, message: 'Internal Error' }
			});
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
		if (m.mode === 'slow') await new Promise((r) => setTimeout(r, SLOW_MS));
		if (m.mode === 'bad400') return send(res, 400, { message: 'method not allowed' });
		if (m.mode === 'err502')
			return send(res, 502, { message: 'could not reach the Blurt network' });
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

	it('indexer down, one node answers reads with an RPC error → the read fails over to the other', async () => {
		nodeA.mode = 'rpcerror';
		nodeB.mode = 'ok';
		const info = await lookupBlurtAccount(
			'alice',
			undefined,
			deps({ indexerBases: [deadIndexer] })
		);
		expect(info?.balance).toBe('7.000 BLURT');
		nodeA.mode = 'ok';
		nodeB.mode = 'rpcerror';
		const again = await lookupBlurtAccount(
			'alice',
			undefined,
			deps({ indexerBases: [deadIndexer] })
		);
		expect(again?.balance).toBe('7.000 BLURT');
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

// morphitir (2026-10-07): a box whose clearnet nodes are unreachable, and whose
// indexer reaches the chain over Tor, answered slower than the 4 s the first
// local read allows; the clearnet pool then failed too, and the upgrade
// refused ("all RPC endpoints unavailable"). The indexer was the one path that
// worked: when the pool fails, it is asked again with a long wait.
describe('reads when the clearnet nodes are unreachable', () => {
	it('slow indexer + every node down → the indexer is asked again, with a long wait, and answers', async () => {
		indexer.mode = 'slow';
		nodeA.mode = 'down503';
		nodeB.mode = 'down503';
		const props = await chainRead<{ head_block_number: number }>(
			'get_dynamic_global_properties',
			[],
			deps({ localReadTimeoutMs: 300, localRetryTimeoutMs: SLOW_MS * 4 })
		);
		expect(props.head_block_number).toBe(HEAD.head_block_number);
		const asked = indexer.requests.filter((r) => r.method.startsWith('/v1/chain/condenser'));
		expect(asked.length).toBe(2); // the quick try, then the patient one
		expect(blocked).toEqual([]);
	});

	it('indexer down + every node down → no second try (nothing is there), and the error names both paths', async () => {
		nodeA.mode = 'down503';
		nodeB.mode = 'down503';
		const err = (await chainRead(
			'get_dynamic_global_properties',
			[],
			deps({ indexerBases: [deadIndexer] })
		).catch((e: unknown) => e)) as Error;
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(
			/this node's own indexer did not answer .*and the Blurt RPC nodes could not be reached/s
		);
		// Not the hidden-only wording, and no "asked again".
		expect(err.message).not.toMatch(/hidden-only/);
		expect(err.message).not.toMatch(/asked again/);
	});

	it('nodes ANSWER with an RPC error → that error, and the indexer is not asked again', async () => {
		indexer.mode = 'slow';
		nodeA.mode = 'rpcerror';
		nodeB.mode = 'rpcerror';
		await expect(
			chainRead(
				'get_dynamic_global_properties',
				[],
				deps({ localReadTimeoutMs: 300, localRetryTimeoutMs: SLOW_MS * 4 })
			)
		).rejects.toThrow(/RPC error/);
		const asked = indexer.requests.filter((r) => r.method.startsWith('/v1/chain/condenser'));
		expect(asked.length).toBe(1);
	});

	it('the indexer ANSWERS with a request error (4xx) → not asked again; the message says it answered', async () => {
		indexer.mode = 'bad400';
		nodeA.mode = 'down503';
		nodeB.mode = 'down503';
		const err = (await chainRead('get_dynamic_global_properties', [], deps()).catch(
			(e: unknown) => e
		)) as Error;
		expect(err.message).toMatch(
			/this node's own indexer answered with an error \(method not allowed\)/
		);
		const asked = indexer.requests.filter((r) => r.method.startsWith('/v1/chain/condenser'));
		expect(asked.length).toBe(1);
	});

	it('the indexer could not reach the network (5xx) and the nodes are down → asked again', async () => {
		indexer.mode = 'err502';
		nodeA.mode = 'down503';
		nodeB.mode = 'down503';
		await chainRead(
			'get_dynamic_global_properties',
			[],
			deps({ localRetryTimeoutMs: 2_000 })
		).catch(() => undefined);
		const asked = indexer.requests.filter((r) => r.method.startsWith('/v1/chain/condenser'));
		expect(asked.length).toBe(2);
	});

	it('no indexer installed (no indexer.env, no configured address) → no second try', async () => {
		nodeA.mode = 'down503';
		nodeB.mode = 'down503';
		const prev = process.env.MORPHIT_ENV_ROOT;
		process.env.MORPHIT_ENV_ROOT = tmp; // an empty root: no indexer.env
		const started = Date.now();
		try {
			const d = { ...deps() } as Record<string, unknown>;
			delete d.indexerBases;
			await chainRead('get_dynamic_global_properties', [], d as never).catch(() => undefined);
		} finally {
			if (prev === undefined) delete process.env.MORPHIT_ENV_ROOT;
			else process.env.MORPHIT_ENV_ROOT = prev;
		}
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(blocked.filter((u) => u.includes('/v1/chain/condenser')).length).toBeLessThanOrEqual(3);
	});

	it('a deadline that has passed stops the second try', async () => {
		indexer.mode = 'slow';
		nodeA.mode = 'down503';
		nodeB.mode = 'down503';
		await chainRead(
			'get_dynamic_global_properties',
			[],
			deps({ localReadTimeoutMs: 300, deadlineAt: Date.now() + 200 })
		).catch(() => undefined);
		const asked = indexer.requests.filter((r) => r.method.startsWith('/v1/chain/condenser'));
		expect(asked.length).toBe(1);
	});

	it('a fast indexer is asked once, and no node is asked', async () => {
		await chainRead('get_dynamic_global_properties', [], deps());
		expect(indexer.requests.length).toBe(1);
		expect(nodeA.requests.length + nodeB.requests.length).toBe(0);
	});
});

describe('a broadcast with a deadline', { timeout: 60_000 }, () => {
	it('is never signed or sent once the deadline has passed (the caller already said it gave up)', async () => {
		indexer.mode = 'slow';
		const deadlineAt = Date.now() + SLOW_MS / 2; // the head read finishes after it
		await expect(
			broadcastCustomJson({
				account: 'alice',
				wif: WIF,
				opId: 'x',
				payload: {},
				deps: deps({ localReadTimeoutMs: SLOW_MS * 4 }),
				deadlineAt
			})
		).rejects.toThrow(/gave up before signing/);
		expect(indexer.requests.filter((r) => r.method === '/v1/broadcast').length).toBe(0);
		expect(nodeA.requests.length + nodeB.requests.length).toBe(0);
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
