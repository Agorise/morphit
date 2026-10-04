/**
 * A verified release OLDER than the build this site runs is not the current
 * release: a node may serve an old genuine release (one whose treasury may
 * since have been retired) while the second node is down or agrees. Such an
 * answer never supplies the chain-pinned treasury — a newer release this
 * browser already verified keeps supplying it — the integrity check says it
 * could not confirm the release instead of comparing against the old one, and
 * the answer is re-checked within the hour, not remembered for a day.
 *
 * The real store → releaseFetch → rotator stack runs; only `fetch` is replaced
 * by a small simulated chain, and the pinned key by a test key whose private
 * half signs the genuine releases. (From the verifier's VT1/VT5 harness.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNING_VERSION, olderThan } from './releaseTestVersions';
import { PrivateKey, cryptoUtils, DEFAULT_CHAIN_ID } from '@beblurt/dblurt';

const OFFICIAL = PrivateKey.fromSeed('morphit release budget test key');

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

/** One browser: its localStorage, shared by every "tab" (fresh module set). */
function browser(): Map<string, string> {
	const data = new Map<string, string>();
	vi.stubGlobal('window', {
		localStorage: {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
			removeItem: (k: string) => void data.delete(k),
			get length() {
				return data.size;
			},
			key: (i: number) => [...data.keys()][i] ?? null
		}
	});
	vi.stubGlobal('navigator', {});
	return data;
}
/** A page load: a fresh copy of the store, booted. */
async function pageLoad() {
	vi.resetModules();
	const store = await import('$stores/release');
	const { get } = await import('svelte/store');
	await store.initRelease();
	return {
		treasury: get(store.chainPinnedTreasury)?.btc?.address ?? null,
		staleBuild: get(store.staleBuild),
		integrity: get(store.integritySummary)
	};
}
const OLD_WITH_RETIRED_TREASURY = releaseTx(releaseJson(olderThan(), ATTACKER_BTC), OFFICIAL, 9);
const later = (ms: number): void => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + ms);
};

describe('a verified release older than this build', () => {
	it('best node serves it, every other node down: its treasury is not pinned, and the check says why', async () => {
		browser();
		const urls = await poolInOrder();
		nodes[urls[0]!] = serving(OLD_WITH_RETIRED_TREASURY, 64_000_000);
		for (const u of urls.slice(1)) nodes[u] = 'down';
		const page = await pageLoad();
		expect(page.treasury).toBeNull();
		expect(page.staleBuild).not.toBe(true);
		expect(page.integrity.kind).toBe('unconfirmed');
	});

	it('two nodes both serve it: the same', async () => {
		browser();
		const urls = await poolInOrder();
		nodes[urls[0]!] = serving(OLD_WITH_RETIRED_TREASURY, 64_000_000);
		nodes[urls[1]!] = serving(OLD_WITH_RETIRED_TREASURY, 64_000_000);
		for (const u of urls.slice(2)) nodes[u] = honest;
		const page = await pageLoad();
		expect(page.treasury).toBeNull();
		expect(page.integrity.kind).toBe('unconfirmed');
	});

	it('is re-checked within the hour, not remembered for a day', async () => {
		browser();
		const urls = await poolInOrder();
		nodes[urls[0]!] = serving(OLD_WITH_RETIRED_TREASURY, 64_000_000);
		for (const u of urls.slice(1)) nodes[u] = 'down';
		await pageLoad();
		for (const u of urls) nodes[u] = honest; // the nodes recover
		later(61 * 60 * 1000);
		const page = await pageLoad();
		expect(page.treasury).toBe(GENUINE_BTC);
		expect(page.integrity.kind).not.toBe('unconfirmed');
	});

	it('a newer release this browser already verified keeps supplying the treasury', async () => {
		browser();
		const urls = await everyNode(honest);
		expect((await pageLoad()).treasury).toBe(GENUINE_BTC);
		later(25 * 60 * 60 * 1000); // the day's answer has expired
		nodes[urls[0]!] = serving(OLD_WITH_RETIRED_TREASURY, 64_000_000);
		for (const u of urls.slice(1)) nodes[u] = 'down';
		const page = await pageLoad();
		expect(page.treasury).toBe(GENUINE_BTC);
		expect(page.staleBuild).toBe(false);
	});
});
