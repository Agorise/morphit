/**
 * The release check's request budget, counted on the wire.
 *
 * Steady state: TWO small requests — one history read (the last 100 entries)
 * and one block read — to ONE node, at most once per 24 h per browser, however
 * many page loads and tabs. One other operator's node is asked only when the
 * first one fails, serves something that cannot be verified, or serves a
 * genuine release that is not the version this site runs; never a third.
 * Signature recovery against the pinned key keeps a single node from forging a
 * release or raising a false alarm.
 *
 * The real store → releaseFetch → rotator stack runs; only `fetch` is replaced
 * by a small simulated chain served by every node of the pool, and the pinned
 * key by a test key whose private half signs the genuine releases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNING_VERSION, olderThan } from './releaseTestVersions';
import { PrivateKey, cryptoUtils, DEFAULT_CHAIN_ID } from '@beblurt/dblurt';

const OFFICIAL = PrivateKey.fromSeed('morphit release budget test key');
const ATTACKER = PrivateKey.fromSeed('somebody else entirely');

vi.mock('$net/config', async (importOriginal) => {
	const real = (await importOriginal()) as Record<string, unknown>;
	return {
		...real,
		MORPHIT_OFFICIAL_POSTING_PUBKEY: PrivateKey.fromSeed('morphit release budget test key')
			.createPublic('BLT')
			.toString()
	};
});

const RUNNING = RUNNING_VERSION;
const GENUINE_BTC = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const ATTACKER_BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

interface Tx {
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
	operations: Array<[string, Record<string, unknown>]>;
	extensions: unknown[];
	signatures: string[];
}

const releaseJson = (version: string, btc: string): string =>
	JSON.stringify({
		version,
		hash_manifest: {},
		treasury: { btc: { address: btc, satoshis: 1500 } }
	});

function releaseTx(json: string, key: PrivateKey | null, salt: number): Tx {
	const tx = {
		ref_block_num: 4242 + salt,
		ref_block_prefix: 99_000 + salt,
		expiration: '2026-10-01T00:01:00',
		operations: [
			[
				'custom_json',
				{ required_auths: [], required_posting_auths: ['morphit'], id: 'morphit_release_v1', json }
			]
		] as Array<[string, Record<string, unknown>]>,
		extensions: [] as unknown[]
	};
	if (key === null) return { ...tx, signatures: [] };
	return cryptoUtils.signTransaction(tx as never, key, DEFAULT_CHAIN_ID) as unknown as Tx;
}
const trxIdOf = (tx: Tx): string => cryptoUtils.generateTrxId(tx as never);

function blockWith(num: number, txs: Tx[]): unknown {
	return {
		previous: '0'.repeat(40),
		timestamp: '2026-10-01T00:00:30',
		transactions: txs,
		block_id: num.toString(16).padStart(8, '0') + 'f'.repeat(32),
		transaction_ids: txs.map(trxIdOf)
	};
}

type NodeAnswer = (method: string, params: unknown) => unknown;

/** A node that serves `tx` as @morphit's newest release, in block `block`. */
function serving(tx: Tx, block: number): NodeAnswer {
	return (method, params) => {
		if (method === 'condenser_api.get_account_history')
			return [
				[
					7,
					{
						block,
						trx_id: trxIdOf(tx),
						trx_in_block: 0,
						op_in_trx: 0,
						timestamp: '2026-10-01T00:00:30',
						op: tx.operations[0]
					}
				]
			];
		if (method === 'condenser_api.get_block')
			return (params as number[])[0] === block ? blockWith(block, [tx]) : null;
		return null;
	};
}

const CURRENT = releaseTx(releaseJson(RUNNING, GENUINE_BTC), OFFICIAL, 1);
const OLDER = releaseTx(releaseJson(olderThan(), GENUINE_BTC), OFFICIAL, 2);
const honest = serving(CURRENT, 64_000_000);

const calls: Array<{ url: string; method: string; params: unknown }> = [];
let nodes: Record<string, NodeAnswer | 'down'> = {};

beforeEach(() => {
	vi.resetModules();
	calls.length = 0;
	nodes = {};
	vi.spyOn(Math, 'random').mockReturnValue(0); // a deterministic "best node"
	vi.stubGlobal('location', { protocol: 'https:', hostname: 'morphit.example' });
	vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
		const req = JSON.parse(init.body) as { id: number; method: string; params: unknown };
		calls.push({ url, method: req.method.replace(/^condenser_api\./, ''), params: req.params });
		const node = nodes[url];
		if (node === undefined || node === 'down') throw new TypeError('Failed to fetch');
		return new Response(
			JSON.stringify({ jsonrpc: '2.0', id: req.id, result: node(req.method, req.params) }),
			{ status: 200 }
		);
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** The pool, in the order the rotator tries it. */
async function poolInOrder(): Promise<string[]> {
	const { DEFAULT_RPC_ENDPOINTS } = await import('$net/config');
	const { EndpointRotator } = await import('$net/endpoints');
	return new EndpointRotator([...DEFAULT_RPC_ENDPOINTS]).getAll().map((s) => s.url);
}
async function everyNode(answer: NodeAnswer | 'down'): Promise<string[]> {
	const urls = await poolInOrder();
	for (const u of urls) nodes[u] = answer;
	return urls;
}
const nodesAsked = (): string[] => [...new Set(calls.map((c) => c.url))];

describe('steady state: two small requests to one node', () => {
	it('one history read of the last 100 entries and one block read, same node, nothing else', async () => {
		await everyNode(honest);
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease({ runningVersion: RUNNING });
		expect(r.ok).toBe(true);
		expect(calls.map((c) => c.method)).toEqual(['get_account_history', 'get_block']);
		expect((calls[0]!.params as unknown[])[2]).toBe(100);
		expect(nodesAsked()).toHaveLength(1);
	});
});

describe('at most once per 24 h per browser: page loads and tabs', () => {
	function browser(opts: { locks: boolean }) {
		const data = new Map<string, string>();
		const localStorage = {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
			removeItem: (k: string) => void data.delete(k),
			get length() {
				return data.size;
			},
			key: (i: number) => [...data.keys()][i] ?? null
		};
		vi.stubGlobal('window', { localStorage });
		// One lock manager for the whole browser, like the real one.
		const queue = new Map<string, Promise<unknown>>();
		const locks = {
			request<T>(name: string, cb: () => Promise<T>): Promise<T> {
				const prev = queue.get(name) ?? Promise.resolve();
				const run = prev.then(cb, cb);
				queue.set(
					name,
					run.catch(() => undefined)
				);
				return run;
			}
		};
		vi.stubGlobal('navigator', opts.locks ? { locks } : {});
	}
	/** A fresh tab: its own copy of every module, the browser's storage. */
	async function tab() {
		vi.resetModules();
		const store = await import('$stores/release');
		const { get } = await import('svelte/store');
		return {
			boot: async () => {
				await store.initRelease();
				return get(store.release).kind;
			}
		};
	}

	it('page loads within 24 h make no request; the next day costs two again', async () => {
		browser({ locks: true });
		await everyNode(honest);
		expect(await (await tab()).boot()).toBe('ok');
		expect(calls).toHaveLength(2);
		expect(await (await tab()).boot()).toBe('ok');
		expect(await (await tab()).boot()).toBe('ok');
		expect(calls).toHaveLength(2);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1000);
		expect(await (await tab()).boot()).toBe('ok');
		expect(calls).toHaveLength(4);
	});

	it('two tabs opened together share one check (Web Locks)', async () => {
		browser({ locks: true });
		await everyNode(honest);
		const [a, b] = [await tab(), await tab()];
		expect(await Promise.all([a.boot(), b.boot()])).toEqual(['ok', 'ok']);
		expect(calls).toHaveLength(2);
	});

	it('two tabs opened together share one check (no Web Locks: plain-http pages)', async () => {
		browser({ locks: false });
		await everyNode(honest);
		const [a, b] = [await tab(), await tab()];
		expect(await Promise.all([a.boot(), b.boot()])).toEqual(['ok', 'ok']);
		expect(calls).toHaveLength(2);
	});
});

describe('a single node cannot forge a release or raise a false alarm', () => {
	it('the best node serves an unsigned release: refused; one other node gives the genuine one', async () => {
		const urls = await everyNode(honest);
		nodes[urls[0]!] = serving(releaseTx(releaseJson(RUNNING, ATTACKER_BTC), null, 9), 64_000_005);
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease({ runningVersion: RUNNING });
		expect(r.ok && r.value.payload.treasury?.btc?.address).toBe(GENUINE_BTC);
		expect(nodesAsked()).toHaveLength(2);
	});

	it('the best node serves a release signed by another key: no alarm, the genuine one wins', async () => {
		const urls = await everyNode(honest);
		nodes[urls[0]!] = serving(
			releaseTx(releaseJson(RUNNING, ATTACKER_BTC), ATTACKER, 9),
			64_000_005
		);
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease({ runningVersion: RUNNING });
		expect(r.ok && r.value.payload.treasury?.btc?.address).toBe(GENUINE_BTC);
	});

	it('every node serves the same forgery signed by another key: pubkey_mismatch, 2 nodes', async () => {
		await everyNode(
			serving(releaseTx(releaseJson(RUNNING, ATTACKER_BTC), ATTACKER, 9), 64_000_005)
		);
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease({ runningVersion: RUNNING });
		expect(!r.ok && r.error.kind).toBe('pubkey_mismatch');
		expect(nodesAsked()).toHaveLength(2);
	});

	it('every node serves an unsigned forgery: nothing is accepted', async () => {
		await everyNode(serving(releaseTx(releaseJson(RUNNING, ATTACKER_BTC), null, 9), 64_000_005));
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		expect((await fetchVerifiedRelease({ runningVersion: RUNNING })).ok).toBe(false);
		expect(nodesAsked()).toHaveLength(2);
	});
});

describe('an old-but-genuine release triggers exactly one extra node', () => {
	it('the best node lags (older genuine release): one other node, the newer release wins', async () => {
		const urls = await everyNode(honest);
		nodes[urls[0]!] = serving(OLDER, 63_000_000);
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease({ runningVersion: RUNNING });
		expect(r.ok && r.value.payload.version).toBe(RUNNING);
		expect(nodesAsked()).toHaveLength(2);
		expect(calls).toHaveLength(4);
	});

	it('every node says the release is older than this build: accepted after one extra node, no third', async () => {
		await everyNode(serving(OLDER, 63_000_000));
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease({ runningVersion: RUNNING });
		expect(r.ok && r.value.payload.version).toBe(olderThan());
		expect(nodesAsked()).toHaveLength(2);
		expect(calls).toHaveLength(4);
	});

	it('the best node is down: one other node, and no third even if that fails too', async () => {
		const urls = await everyNode('down');
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease({ runningVersion: RUNNING });
		expect(!r.ok && r.error.kind).toBe('rpc_failed');
		expect(nodesAsked()).toEqual(urls.slice(0, 2));
	});
});
