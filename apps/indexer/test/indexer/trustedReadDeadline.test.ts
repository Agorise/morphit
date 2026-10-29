/**
 * A trusted read a person is waiting on ends in time to answer (v1.21.17).
 *
 * Posting an order on vigilante.trading failed with "indexer
 * /v1/account/:name/keys timed out": the browser waits 15 s for the account's
 * keys, and the indexer's trusted read heard three operators in full at
 * background priority — 10 s per node, 60 s for a hidden one — so one slow node
 * outlasted the browser. The route now asks with user-facing timeouts and a
 * deadline; a read cut short before the first round was heard decides nothing
 * (the browser retries), rather than deciding from fewer operators than the
 * key-rotation rule (VT5-1) needs.
 *
 * Real BlurtClient and rpc pool; local JSON-RPC stubs, one operator per
 * loopback address.
 */
import * as http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
	ACCOUNT_KEYS_DEADLINE_CLEARNET_MS,
	ACCOUNT_KEYS_DEADLINE_HIDDEN_MS,
	accountKeysRoute,
	hiddenRequestHost
} from '$api/accountKeys';
import { BlurtClient, type ChainAccount, type TrustedReadBudget } from '$blurt/client';

const KEY = 'BLTalice'.padEnd(53, 'x');

interface Node {
	url: string;
	hits: number;
	close(): Promise<void>;
}

async function node(
	host: string,
	delayMs: number,
	as: { key?: string; at?: string } = {}
): Promise<Node> {
	const n: Node = { url: '', hits: 0, close: async () => {} };
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			n.hits++;
			const r = JSON.parse(body) as { id?: unknown; method?: string; params?: unknown[] };
			const asked = (r.method === 'call' ? r.params?.[2] : r.params) as unknown[];
			const names = (Array.isArray(asked?.[0]) ? asked[0] : []) as string[];
			const key = as.key ?? KEY;
			const auth = { weight_threshold: 1, account_auths: [], key_auths: [[key, 1]] };
			const result = names.map((name) => ({
				name,
				posting: auth,
				active: auth,
				owner: auth,
				memo_key: key,
				last_account_update: as.at ?? '2026-10-01T12:00:00'
			}));
			setTimeout(() => {
				if (res.destroyed) return;
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id ?? 0, result }));
			}, delayMs);
		});
	});
	await new Promise<void>((r) => server.listen(0, host, () => r()));
	n.url = `http://${host}:${(server.address() as { port: number }).port}`;
	n.close = () =>
		new Promise<void>((r) => {
			server.closeAllConnections?.();
			server.close(() => r());
		});
	return n;
}

const keyOf = (a: ChainAccount | undefined): string =>
	(a as { posting?: { key_auths?: [string, number][] } } | undefined)?.posting
		?.key_auths?.[0]?.[0] ?? 'missing';

describe('trusted read with a budget (account keys)', () => {
	let nodes: Node[] = [];
	beforeAll(() => {
		process.env.MORPHIT_RPC_HEALTH_STATE = join(mkdtempSync(join(tmpdir(), 'trd-')), 'h.json');
	});
	afterEach(async () => {
		await Promise.all(nodes.map((n) => n.close()));
		nodes = [];
	});
	const make = async (
		host: string,
		delayMs: number,
		as: { key?: string; at?: string } = {}
	): Promise<Node> => {
		const n = await node(host, delayMs, as);
		nodes.push(n);
		return n;
	};
	const client = (ns: readonly Node[]): BlurtClient =>
		new BlurtClient({
			blurtRpcEndpoints: ns.map((n) => n.url),
			hiddenRpcEndpoints: [],
			localRpcEndpoints: []
		} as never);

	it('a stalled node is given up on at the user-facing timeout and another operator is heard', async () => {
		const ns = [
			await make('127.0.1.61', 1),
			await make('127.0.1.62', 4_000),
			await make('127.0.1.63', 1),
			await make('127.0.1.64', 1)
		];
		const b = client(ns);
		const t0 = Date.now();
		const m = await b.getAccountsAgreed(['alice'], keyOf, { timeoutMs: 250, userFacing: true });
		expect(keyOf(m?.get('alice'))).toBe(KEY);
		// Background priority would wait out the stalled node's 4 s answer.
		expect(Date.now() - t0).toBeLessThan(2_000);
	});

	it('cut short by the deadline before three operators were heard, it decides nothing', async () => {
		const ns = [
			await make('127.0.1.65', 1),
			await make('127.0.1.66', 1),
			await make('127.0.1.67', 5_000)
		];
		const b = client(ns);
		// The deadline: aborts itself after 300 ms (no timer wait in the test).
		const deadline = { signal: AbortSignal.timeout(300) };
		const t0 = Date.now();
		const m = await b.getAccountsAgreed(['alice'], keyOf, {
			timeoutMs: 10_000,
			signal: deadline.signal
		});
		expect(m).toBeNull();
		expect(Date.now() - t0).toBeLessThan(2_000);
		// Nobody was counted as dissenting from a partial read.
		expect(b.quorumDissent()).toEqual([]);
	});

	it('a deadline during the widening never wears an up-to-date operator down to "overruled" (VT5-1)', async () => {
		// The account rotated its key. A hostile and a lagging operator name the
		// leaked key at the old time; one up-to-date operator names the new key —
		// a lone dissent until the widening (two more up-to-date operators, slow
		// here) backs it. Repeated requests that the deadline cuts during the
		// widening must not count as that dissent standing alone.
		const LEAKED = 'BLTleaked'.padEnd(53, 'l');
		const ns = [
			await make('127.0.1.71', 1, { key: LEAKED, at: '2026-09-01T12:00:00' }),
			await make('127.0.1.72', 1, { key: LEAKED, at: '2026-09-01T12:00:00' }),
			await make('127.0.1.73', 1),
			await make('127.0.1.74', 3_000),
			await make('127.0.1.75', 3_000)
		];
		// Overruling at its fastest setting: one earlier standing read suffices.
		const b = new BlurtClient(
			{
				blurtRpcEndpoints: ns.map((n) => n.url),
				hiddenRpcEndpoints: [],
				localRpcEndpoints: []
			} as never,
			{ quorum: { standingReads: 1, standingMs: 0 } }
		);
		for (let i = 0; i < 3; i++) {
			// The deadline: aborts itself after 300 ms (no timer wait in the test).
			const deadline = { signal: AbortSignal.timeout(300) };
			const m = await b.getAccountsAgreed(['alice'], keyOf, {
				timeoutMs: 10_000,
				signal: deadline.signal
			});
			expect(m).toBeNull();
		}
		expect(b.quorumDissent()).toEqual([]);
	});

	it('a node the deadline cut off is asked after the others next time, so a retry can succeed', async () => {
		const ns = [
			await make('127.0.1.76', 1),
			await make('127.0.1.77', 1),
			await make('127.0.1.78', 3_000),
			await make('127.0.1.79', 1)
		];
		const b = client(ns);
		const read = () => {
			// The deadline: aborts itself after 300 ms (no timer wait in the test).
			const deadline = { signal: AbortSignal.timeout(300) };
			return b.getAccountsAgreed(['alice'], keyOf, { timeoutMs: 10_000, signal: deadline.signal });
		};
		// The slow node is in the first three asked: cut off, nothing decided.
		expect(await read()).toBeNull();
		// The browser's retry: the fourth operator is asked instead of it.
		expect(keyOf((await read())?.get('alice'))).toBe(KEY);
		// It was not put in cooldown: it is still a candidate.
		expect(b.quorumDissent()).toEqual([]);
	});

	it('with no deadline the same pool waits for the third operator and decides', async () => {
		const ns = [
			await make('127.0.1.68', 1),
			await make('127.0.1.69', 1),
			await make('127.0.1.70', 400)
		];
		const m = await client(ns).getAccountsAgreed(['alice'], keyOf);
		expect(keyOf(m?.get('alice'))).toBe(KEY);
	});
});

describe('the account-keys route asks within the browser budget', () => {
	const capture = () => {
		const seen: { budget?: TrustedReadBudget } = {};
		const blurt = {
			getAccountsAgreed: (_n: readonly string[], _k: unknown, budget?: TrustedReadBudget) => {
				seen.budget = budget;
				return new Promise<null>((resolve) => {
					budget?.signal?.addEventListener('abort', () => resolve(null));
				});
			}
		};
		return { seen, app: accountKeysRoute(blurt as never) };
	};

	it('clearnet: user-facing per-node timeouts and an answer before the browser gives up', async () => {
		vi.useFakeTimers();
		try {
			const { seen, app } = capture();
			const res = app.request('/alice/keys', { headers: { host: 'vigilante.trading' } });
			await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_DEADLINE_CLEARNET_MS - 1);
			expect(seen.budget?.signal?.aborted).toBe(false);
			expect(seen.budget?.timeoutMs).toBe(4_000);
			expect(seen.budget?.userFacing).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			expect(seen.budget?.signal?.aborted).toBe(true);
			expect((await res).status).toBe(502);
		} finally {
			vi.useRealTimers();
		}
		// The browser's clearnet budget (web ACCOUNT_KEYS_TIMEOUT_MS).
		expect(ACCOUNT_KEYS_DEADLINE_CLEARNET_MS).toBeLessThan(15_000);
	});

	it('hidden: the page came over Tor/I2P, where the browser waits 75 s', async () => {
		vi.useFakeTimers();
		try {
			const { seen, app } = capture();
			const res = app.request('/alice/keys', { headers: { host: 'abcdef.onion' } });
			await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_DEADLINE_CLEARNET_MS);
			expect(seen.budget?.signal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_DEADLINE_HIDDEN_MS);
			expect(seen.budget?.signal?.aborted).toBe(true);
			expect((await res).status).toBe(502);
		} finally {
			vi.useRealTimers();
		}
		expect(ACCOUNT_KEYS_DEADLINE_HIDDEN_MS).toBeLessThan(75_000);
	});

	it('names a hidden host by its suffix, with or without a port', () => {
		expect(hiddenRequestHost('x.onion')).toBe(true);
		expect(hiddenRequestHost('x.b32.i2p:8080')).toBe(true);
		expect(hiddenRequestHost('X.LOKI')).toBe(true);
		expect(hiddenRequestHost('vigilante.trading')).toBe(false);
		expect(hiddenRequestHost(undefined)).toBe(false);
	});
});
