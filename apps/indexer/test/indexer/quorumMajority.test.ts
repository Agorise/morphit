/**
 * Trusted chain reads (posting-key confirmation, the snapshot op, the official-op
 * heal, the RPC directory reload) — decided per account by the operators that
 * answered. Operators are counted by NODE NAME (rpc-pool `operatorOf`); one
 * person's several named nodes are several votes.
 *
 * SAFETY FIRST (VT5-1). A key is confirmed only when at least two operators
 * agree, they are a strict majority of those that answered, and no other
 * answer could be NEWER. Account state changes (a key rotation), so a node
 * that is behind and a hostile one can agree on the OLD key; a bare majority
 * of whoever answered first confirmed a leaked key over the rotation, for good.
 * An answer that is provably older (its `last_account_update` is earlier) is
 * outvoted at once. Any other dissent delays the read: more operators are
 * asked, and a dissent backed by a second operator always blocks. A LONE
 * dissent that never gains a second operator over several reads spread over
 * time is overruled — liveness (VT1-3): one node must not block a read forever.
 *
 * Immutable reads (a block by its height) have no "older": a node that does
 * not have the block abstains. There a lone dissenter is simply outvoted.
 *
 * Real BlurtClient and rpc pool; local JSON-RPC stubs, one operator per loopback
 * address.
 */
import * as http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BlurtClient } from '$blurt/client';

const NAMES = Array.from({ length: 50 }, (_, i) => `user${i}`);
const REAL = (n: string): string => `BLT${n}`.padEnd(53, 'x');
const FORGED = 'BLTattacker'.padEnd(53, 'z');
const LEAKED = 'BLTleakedkey'.padEnd(53, 'l');
/** When the chain last saw an account_update: the rotation, and before it. */
const ROTATED_AT = '2026-10-01T12:00:00';
const BEFORE = '2026-09-01T12:00:00';

interface Node {
	url: string;
	hits: number;
	close(): Promise<void>;
}

interface NodeOpts {
	delayMs: number;
	/** Accounts this node gives a different key, and the key and time it gives. */
	lie?: readonly string[];
	lieKey?: string;
	lieAt?: string;
	/** get_block answer. */
	block?: unknown;
}

async function node(host: string, opts: NodeOpts): Promise<Node> {
	const n: Node = { url: '', hits: 0, close: async () => {} };
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			n.hits++;
			const r = JSON.parse(body) as { id?: unknown; method?: string; params?: unknown[] };
			const method = r.method === 'call' ? String(r.params?.[1]) : String(r.method);
			let result: unknown;
			if (method.includes('get_block')) result = opts.block ?? null;
			else {
				const asked = (r.method === 'call' ? r.params?.[2] : r.params) as unknown[];
				const names = (Array.isArray(asked?.[0]) ? asked[0] : []) as string[];
				result = names.map((name) => {
					const lying = opts.lie?.includes(name) === true;
					const key = lying ? (opts.lieKey ?? FORGED) : REAL(name);
					const auth = { weight_threshold: 1, account_auths: [], key_auths: [[key, 1]] };
					return {
						name,
						posting: auth,
						active: auth,
						owner: auth,
						memo_key: key,
						last_account_update: lying ? (opts.lieAt ?? ROTATED_AT) : ROTATED_AT
					};
				});
			}
			setTimeout(() => {
				if (res.destroyed) return;
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id ?? 0, result }));
			}, opts.delayMs);
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

const keyOf = (a: { posting?: { key_auths?: [string, number][] } } | undefined): string =>
	a?.posting?.key_auths?.[0]?.[0] ?? 'missing';

describe('trusted reads: safe first, then live (VT5-1, VT1-3)', () => {
	let nodes: Node[] = [];
	beforeAll(() => {
		process.env.MORPHIT_RPC_HEALTH_STATE = join(mkdtempSync(join(tmpdir(), 'vt51-')), 'h.json');
	});
	afterEach(async () => {
		await Promise.all(nodes.map((n) => n.close()));
		nodes = [];
	});
	const make = async (host: string, opts: NodeOpts): Promise<Node> => {
		const n = await node(host, opts);
		nodes.push(n);
		return n;
	};
	const client = (
		ns: readonly Node[],
		quorum?: { standingReads?: number; standingMs?: number }
	): BlurtClient =>
		new BlurtClient(
			{
				blurtRpcEndpoints: ns.map((n) => n.url),
				hiddenRpcEndpoints: [],
				localRpcEndpoints: []
			} as never,
			quorum === undefined ? undefined : { quorum }
		);
	const user7 = async (b: BlurtClient): Promise<string> => {
		const m = await b.getAccountsAgreed(NAMES, keyOf as never);
		return m === null ? 'none' : keyOf(m.get('user7') as never);
	};

	// ── safety ─────────────────────────────────────────────────────────────
	it('a hostile operator and a lagging node never confirm the pre-rotation key over the current one', async () => {
		const ns = [
			// Hostile, fastest, claims the leaked key — and the lagging node's time,
			// to agree with it.
			await make('127.0.0.61', { delayMs: 1, lie: ['user7'], lieKey: LEAKED, lieAt: BEFORE }),
			await make('127.0.0.62', { delayMs: 10 }),
			// Lagging honest node: has not applied the rotation yet.
			await make('127.0.0.63', { delayMs: 20, lie: ['user7'], lieKey: LEAKED, lieAt: BEFORE }),
			await make('127.0.0.64', { delayMs: 30 })
		];
		// Even with overruling switched to its fastest setting.
		const b = client(ns, { standingReads: 1, standingMs: 0 });
		for (let i = 0; i < 5; i++) expect(await user7(b)).not.toBe(LEAKED);
	});

	it('two lagging nodes among three never confirm the old key, and the current one is not punished', async () => {
		const ns = [
			await make('127.0.0.65', { delayMs: 1, lie: ['user7'], lieKey: LEAKED, lieAt: BEFORE }),
			await make('127.0.0.66', { delayMs: 5, lie: ['user7'], lieKey: LEAKED, lieAt: BEFORE }),
			await make('127.0.0.67', { delayMs: 20 })
		];
		const b = client(ns);
		for (let i = 0; i < 5; i++) expect(await user7(b)).toBe('none');
		expect(b.quorumDissent()).toEqual([]);
	});

	it('two colluding operators against two honest ones decide nothing', async () => {
		const ns = [
			await make('127.0.0.68', { delayMs: 1, lie: ['user7'] }),
			await make('127.0.0.69', { delayMs: 10 }),
			await make('127.0.0.70', { delayMs: 20, lie: ['user7'] }),
			await make('127.0.0.71', { delayMs: 30 })
		];
		const b = client(ns, { standingReads: 1, standingMs: 0 });
		for (let i = 0; i < 4; i++) expect(await user7(b)).toBe('none');
		expect(b.quorumDissent()).toEqual([]);
	});

	it('one operator never makes a forged value win, however many addresses it has', async () => {
		// Two addresses on one host are one operator; the only honest one is down.
		const evil1 = await make('127.0.0.72', { delayMs: 1, lie: NAMES });
		const evil2 = await make('127.0.0.72', { delayMs: 1, lie: NAMES });
		const dead: Node = { url: 'http://127.0.0.73:9', hits: 0, close: async () => {} };
		expect(await client([evil1, evil2, dead]).getAccountsAgreed(NAMES, keyOf as never)).toBeNull();
	});

	it('no majority, no answer: two operators that disagree decide nothing', async () => {
		const a = await make('127.0.0.74', { delayMs: 1, lie: ['user0'] });
		const b = await make('127.0.0.75', { delayMs: 2 });
		expect(await client([a, b]).getAccountsAgreed(NAMES, keyOf as never)).toBeNull();
	});

	// ── liveness ───────────────────────────────────────────────────────────
	it('a lagging node (older answer) is outvoted at once, per account, and left out for a while', async () => {
		const lag = await make('127.0.0.76', {
			delayMs: 1,
			lie: ['user1', 'user7'],
			lieKey: LEAKED,
			lieAt: BEFORE
		});
		const a = await make('127.0.0.77', { delayMs: 20 });
		const c = await make('127.0.0.78', { delayMs: 30 });
		const b = client([lag, a, c]);
		expect(await user7(b)).toBe(REAL('user7'));
		expect(b.quorumDissent().map((d) => d.operator)).toEqual([b.operatorOf(lag.url)]);
		const hits = lag.hits;
		// Left out: the next read is decided by the other two without asking it.
		expect(await user7(b)).toBe(REAL('user7'));
		expect(lag.hits).toBe(hits);
	});

	it('a lone liar copying the current time delays reads, then is overruled — never wins', async () => {
		const evil = await make('127.0.0.79', { delayMs: 1, lie: ['user7'] });
		const honest = await Promise.all(
			['127.0.0.80', '127.0.0.81', '127.0.0.82'].map((h, i) => make(h, { delayMs: 20 + 10 * i }))
		);
		const b = client([evil, ...honest], { standingReads: 3, standingMs: 0 });
		const rounds: string[] = [];
		for (let i = 0; i < 8; i++) rounds.push(await user7(b));
		expect(rounds.slice(0, 3)).toEqual(['none', 'none', 'none']);
		expect(rounds.slice(3)).toEqual(Array(5).fill(REAL('user7')));
		expect(b.quorumDissent().map((d) => d.operator)).toEqual([b.operatorOf(evil.url)]);
	});

	it('a lone dissent is not overruled before its time has passed, however often it is asked', async () => {
		const evil = await make('127.0.0.83', { delayMs: 1, lie: ['user7'] });
		const honest = await Promise.all(
			['127.0.0.84', '127.0.0.85'].map((h, i) => make(h, { delayMs: 20 + 10 * i }))
		);
		const b = client([evil, ...honest]); // the default: ten minutes
		for (let i = 0; i < 6; i++) expect(await user7(b)).toBe('none');
	});

	it('an immutable read (a block by height) is not blocked by a lone dissenter', async () => {
		const good = { block_id: 'aa'.repeat(20), transactions: [] };
		const evil = await make('127.0.0.86', {
			delayMs: 1,
			block: { ...good, block_id: 'bb'.repeat(20) }
		});
		const a = await make('127.0.0.87', { delayMs: 30, block: good });
		const c = await make('127.0.0.88', { delayMs: 40, block: good });
		const b = client([evil, a, c]);
		const r = await b.condenserAgreed<{ block_id: string }>(
			'get_block',
			[5],
			(x) => x.block_id,
			b.trustedQuorumSize()
		);
		expect(r?.key).toBe(good.block_id);
	});
});
