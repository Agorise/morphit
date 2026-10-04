/**
 * One RPC node cannot roll the release check back to an OLDER genuine release.
 *
 * Which of two verified releases is newer is decided by what @morphit SIGNED
 * (the payload's version, then the transaction's expiration), never by the
 * block number a node reports: a node can claim any block number for a genuine
 * old transaction. Nor is the block's timestamp (unsigned) passed on.
 *
 * The real store → releaseFetch → rotator stack runs; only `fetch` is replaced
 * by a small simulated chain, and the pinned key by a test key whose private
 * half signs the genuine releases. (From the verifier's VT1 harness.)
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

describe('ordering by signed data, never by a node-reported block number', () => {
	it('the best node serves an OLDER genuine release at an inflated block: the current release wins', async () => {
		const urls = await poolInOrder();
		const OLD = releaseTx(releaseJson(olderThan(), ATTACKER_BTC), OFFICIAL, 9);
		nodes[urls[0]!] = serving(OLD, 999_999_999);
		for (const u of urls.slice(1)) nodes[u] = honest;
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease({ runningVersion: RUNNING });
		expect(r.ok && r.value.payload.version).toBe(RUNNING);
		expect(r.ok && r.value.payload.treasury?.btc?.address).toBe(GENUINE_BTC);
	});

	it('store: the treasury shown chain-pinned is the current one, and no "update landing" state hides the tamper alarm', async () => {
		const data = new Map<string, string>();
		vi.stubGlobal('window', {
			localStorage: {
				getItem: (k: string) => data.get(k) ?? null,
				setItem: (k: string, v: string) => void data.set(k, v),
				removeItem: (k: string) => void data.delete(k)
			}
		});
		vi.stubGlobal('navigator', {});
		const urls = await poolInOrder();
		const OLD = releaseTx(releaseJson(olderThan(), ATTACKER_BTC), OFFICIAL, 9);
		nodes[urls[0]!] = serving(OLD, 999_999_999);
		for (const u of urls.slice(1)) nodes[u] = honest;
		vi.resetModules();
		const store = await import('$stores/release');
		const { get } = await import('svelte/store');
		await store.initRelease();
		expect(get(store.chainPinnedTreasury)?.btc?.address).toBe(GENUINE_BTC);
		expect(get(store.staleBuild)).toBe(false);
	});

	it('a release OLDER than this build (every node agrees) is not "stale build" either', async () => {
		const data = new Map<string, string>();
		vi.stubGlobal('window', {
			localStorage: {
				getItem: (k: string) => data.get(k) ?? null,
				setItem: (k: string, v: string) => void data.set(k, v),
				removeItem: (k: string) => void data.delete(k)
			}
		});
		vi.stubGlobal('navigator', {});
		await everyNode(
			serving(releaseTx(releaseJson(olderThan(), GENUINE_BTC), OFFICIAL, 9), 63_000_000)
		);
		vi.resetModules();
		const store = await import('$stores/release');
		const { get } = await import('svelte/store');
		await store.initRelease();
		// Not "an update is landing" (which would hold back the tamper alarm);
		// the release is unconfirmed instead (releaseOlder.test.ts).
		expect(get(store.staleBuild)).not.toBe(true);
	});

	it("the block's unsigned timestamp is not passed on as the release's", async () => {
		const urls = await poolInOrder();
		const forged = (method: string, params: unknown) => {
			const v = serving(CURRENT, 64_000_000)(method, params);
			if (method === 'condenser_api.get_block' && v && typeof v === 'object')
				return { ...(v as object), timestamp: '1999-01-01T00:00:00' };
			return v;
		};
		for (const u of urls) nodes[u] = forged;
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease({ runningVersion: RUNNING });
		expect(r.ok).toBe(true);
		expect(JSON.stringify(r)).not.toContain('1999-01-01T00:00:00');
	});
});
