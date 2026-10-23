/**
 * The browser's release check must not take its source's word.
 *
 * The source is the instance's agreed-read relay (`POST /v1/chain/agreed`:
 * what two RPC operators of its pool return alike). The instance — or two
 * operators that agree — could still answer `get_account_history` with an op
 * that was made up. The release check proves the op instead: the block that
 * holds it is read too, the transaction id is recomputed from the block's
 * content, and the transaction's signature must recover to the pinned
 * @morphit posting key. Only the payload parsed from that block is used. (The
 * request budget itself is pinned by ./releaseBudget.test.ts.)
 *
 * These tests drive the real releaseFetch → chainRelay stack; only `fetch` is
 * replaced, by a small simulated chain the instance serves, honest or not.
 * The pinned key is swapped for a test key whose private half signs the
 * genuine release.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNING_VERSION, newerThan } from './releaseTestVersions';
import { PrivateKey, cryptoUtils, DEFAULT_CHAIN_ID } from '@beblurt/dblurt';

const OFFICIAL = PrivateKey.fromSeed('morphit release test key');
const ATTACKER = PrivateKey.fromSeed('somebody else');

vi.mock('$net/config', async (importOriginal) => {
	const real = (await importOriginal()) as Record<string, unknown>;
	return {
		...real,
		MORPHIT_OFFICIAL_POSTING_PUBKEY: PrivateKey.fromSeed('morphit release test key')
			.createPublic('BLT')
			.toString()
	};
});

const GENUINE_BTC = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const ATTACKER_BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const ATTACKER_XMR =
	'47ohRcAbr8b8iaqq3sQWm795zAr8V5DKSLzfLDihsi55W4xaZ5dBu3zVnkqE7zMVc7ckPgz8AHYai96BzyNF4D4X5eSHr7B';

function releaseJson(version: string, btc: string, xmr?: string): string {
	return JSON.stringify({
		version,
		hash_manifest: {},
		treasury: {
			btc: { address: btc, satoshis: 1500 },
			...(xmr !== undefined
				? { xmr: { address: xmr, piconero: '1000000000', primary_address: xmr } }
				: {})
		}
	});
}

interface Tx {
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
	operations: Array<[string, Record<string, unknown>]>;
	extensions: unknown[];
	signatures: string[];
}

function releaseTx(json: string, key: PrivateKey | null, salt = 1): Tx {
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

function historyEntry(seq: number, block: number, tx: Tx): unknown {
	return [
		seq,
		{
			block,
			trx_id: trxIdOf(tx),
			trx_in_block: 0,
			op_in_trx: 0,
			timestamp: '2026-10-01T00:00:30',
			op: tx.operations[0]
		}
	];
}
function blockWith(num: number, txs: Tx[]): unknown {
	return {
		previous: '0'.repeat(40),
		timestamp: '2026-10-01T00:00:30',
		witness: 'w',
		transaction_merkle_root: '0'.repeat(40),
		extensions: [],
		witness_signature: '',
		transactions: txs,
		block_id: num.toString(16).padStart(8, '0') + 'f'.repeat(32),
		signing_key: '',
		transaction_ids: txs.map(trxIdOf)
	};
}

type NodeAnswer = (method: string, params: unknown) => unknown;
const calls: Array<{ url: string; method: string }> = [];
/** What the instance's agreed-read relay answers ('down': 502, no agreement). */
let instance: NodeAnswer | 'down' = 'down';

/** A chain every honest node agrees on. */
const GENUINE_TX = releaseTx(releaseJson(RUNNING_VERSION, GENUINE_BTC), OFFICIAL);
const GENUINE_BLOCK = 64_000_000;
const honest: NodeAnswer = (method, params) => {
	if (method === 'condenser_api.get_account_history')
		return [historyEntry(7, GENUINE_BLOCK, GENUINE_TX)];
	if (method === 'condenser_api.get_block')
		return (params as number[])[0] === GENUINE_BLOCK
			? blockWith(GENUINE_BLOCK, [GENUINE_TX])
			: null;
	if (method === 'condenser_api.get_accounts')
		return [
			{
				name: 'morphit',
				posting: {
					weight_threshold: 1,
					account_auths: [],
					key_auths: [[OFFICIAL.createPublic('BLT').toString(), 1]]
				}
			}
		];
	return null;
};

const ORIGIN = 'https://morphit.example';
function serve(): void {
	vi.stubGlobal('fetch', async (input: string | URL, init: { body: string }) => {
		const url = String(input);
		const req = JSON.parse(init.body) as { method: string; params: unknown };
		calls.push({ url, method: req.method });
		if (url !== `${ORIGIN}/v1/chain/agreed`) throw new TypeError('Failed to fetch');
		if (instance === 'down')
			return new Response(JSON.stringify({ status: 'error', code: 'internal' }), { status: 502 });
		return new Response(
			JSON.stringify({ result: instance(`condenser_api.${req.method}`, req.params) }),
			{ status: 200 }
		);
	});
}

beforeEach(() => {
	vi.resetModules();
	calls.length = 0;
	instance = 'down';
	vi.stubGlobal('location', { protocol: 'https:', hostname: 'morphit.example' });
	vi.stubGlobal('window', { location: { origin: ORIGIN, hostname: 'morphit.example' } });
	serve();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('a forged release op is refused', () => {
	it('the instance serves an unsigned op naming @morphit → not verified', async () => {
		const forged = releaseTx(releaseJson(RUNNING_VERSION, ATTACKER_BTC, ATTACKER_XMR), null, 9);
		const lying: NodeAnswer = (method, params) => {
			if (method === 'condenser_api.get_account_history')
				return [historyEntry(9, GENUINE_BLOCK + 5, forged)];
			if (method === 'condenser_api.get_block')
				return (params as number[])[0] === GENUINE_BLOCK + 5
					? blockWith(GENUINE_BLOCK + 5, [forged])
					: null;
			return honest(method, params);
		};
		instance = lying;
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(false);
	});

	it('the agreed answer is a block whose op is signed by another key → pubkey_mismatch, nothing usable', async () => {
		const forged = releaseTx(releaseJson(RUNNING_VERSION, ATTACKER_BTC, ATTACKER_XMR), ATTACKER, 9);
		const lying: NodeAnswer = (method, params) => {
			if (method === 'condenser_api.get_account_history')
				return [historyEntry(9, GENUINE_BLOCK + 5, forged)];
			if (method === 'condenser_api.get_block')
				return (params as number[])[0] === GENUINE_BLOCK + 5
					? blockWith(GENUINE_BLOCK + 5, [forged])
					: null;
			return honest(method, params);
		};
		instance = lying;
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.kind).toBe('pubkey_mismatch');
	});

	it('an answer that pairs the real trx id with altered operations is not believed', async () => {
		const altered = {
			...GENUINE_TX,
			operations: [
				[
					'custom_json',
					{
						required_auths: [],
						required_posting_auths: ['morphit'],
						id: 'morphit_release_v1',
						json: releaseJson(RUNNING_VERSION, ATTACKER_BTC)
					}
				]
			] as Tx['operations']
		};
		const lying: NodeAnswer = (method, params) => {
			if (method === 'condenser_api.get_block')
				return (params as number[])[0] === GENUINE_BLOCK
					? {
							...(blockWith(GENUINE_BLOCK, [altered]) as object),
							transaction_ids: [trxIdOf(GENUINE_TX)]
						}
					: null;
			return honest(method, params);
		};
		instance = lying;
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(false);
	});
});

describe('the genuine release is verified, through the instance alone', () => {
	it('verified; one history read and one block read, both to the instance', async () => {
		instance = honest;
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.payload.version).toBe(RUNNING_VERSION);
		expect(r.value.blockNumber).toBe(GENUINE_BLOCK);
		expect(calls.map((c) => c.method)).toEqual(['get_account_history', 'get_block']);
		expect(new Set(calls.map((c) => c.url))).toEqual(new Set([`${ORIGIN}/v1/chain/agreed`]));
	});

	it('no agreed answer (or no instance): rpc_failed, nothing claimed', async () => {
		instance = 'down';
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(!r.ok && r.error.kind).toBe('rpc_failed');
	});
});

describe('how far back the release check reads', () => {
	it('starts with the last 100 entries and stops there when the release is in them', async () => {
		instance = honest;
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		await fetchVerifiedRelease();
		const sizes = calls.filter((c) => c.method === 'get_account_history');
		expect(sizes.length).toBe(1);
		expect(calls.some((c) => c.method === 'get_block')).toBe(true);
	});

	it('walks the 10,000-entry window only when the last 100 hold no release', async () => {
		const windows: number[] = [];
		const deep: NodeAnswer = (method, params) => {
			if (method === 'condenser_api.get_account_history') {
				const limit = (params as number[])[2]!;
				windows.push(limit);
				return limit >= 10_000 ? [historyEntry(7, GENUINE_BLOCK, GENUINE_TX)] : [];
			}
			return honest(method, params);
		};
		instance = deep;
		const { fetchVerifiedRelease, RELEASE_HISTORY_WINDOWS } = await import('$net/releaseFetch');
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(true);
		expect(RELEASE_HISTORY_WINDOWS).toEqual([100, 10_000]);
		expect(windows).toEqual([100, 10_000]);
	});

	it('no release anywhere: no_release after the full window', async () => {
		const empty: NodeAnswer = (method, params) =>
			method === 'condenser_api.get_account_history' ? [] : honest(method, params);
		instance = empty;
		const { fetchVerifiedRelease } = await import('$net/releaseFetch');
		expect(await fetchVerifiedRelease()).toEqual({ ok: false, error: { kind: 'no_release' } });
		expect(calls.some((c) => c.method === 'get_block')).toBe(false);
	});
});

describe('the release check asks at most once a day, whatever the outcome', () => {
	function browserStorage(): Map<string, string> {
		const data = new Map<string, string>();
		vi.stubGlobal('window', {
			location: { origin: ORIGIN, hostname: 'morphit.example' },
			localStorage: {
				getItem: (k: string) => data.get(k) ?? null,
				setItem: (k: string, v: string) => void data.set(k, v),
				removeItem: (k: string) => void data.delete(k)
			}
		});
		return data;
	}
	async function boot(): Promise<{ kind: string }> {
		const store = await import('$stores/release');
		store.resetReleaseStore();
		await store.initRelease();
		const { get } = await import('svelte/store');
		return get(store.release);
	}

	it('a verified answer is reused for 24 h: the second page load asks nothing', async () => {
		browserStorage();
		instance = honest;
		expect((await boot()).kind).toBe('ok');
		const first = calls.length;
		expect(first).toBeGreaterThan(0);
		expect((await boot()).kind).toBe('ok');
		expect(calls.length).toBe(first);
	});

	it('a failed check is remembered too: nothing is asked again on every page load', async () => {
		browserStorage();
		instance = 'down';
		expect((await boot()).kind).toBe('error');
		const first = calls.length;
		expect((await boot()).kind).toBe('error');
		expect(calls.length).toBe(first);
	});

	it('an instance still running an older version than the chain announces is not re-checked on every load', async () => {
		browserStorage();
		const newer = releaseTx(releaseJson(newerThan(), GENUINE_BTC), OFFICIAL, 3);
		const ahead: NodeAnswer = (method, params) => {
			if (method === 'condenser_api.get_account_history')
				return [historyEntry(8, GENUINE_BLOCK + 1, newer)];
			if (method === 'condenser_api.get_block')
				return (params as number[])[0] === GENUINE_BLOCK + 1
					? blockWith(GENUINE_BLOCK + 1, [newer])
					: null;
			return honest(method, params);
		};
		instance = ahead;
		expect((await boot()).kind).toBe('ok');
		const first = calls.length;
		expect((await boot()).kind).toBe('ok');
		expect(calls.length).toBe(first);
	});

	it('an answer remembered by an older build (before signatures were checked) is discarded', async () => {
		const data = browserStorage();
		const forged = {
			savedAt: Date.now(),
			release: {
				payload: JSON.parse(releaseJson(RUNNING_VERSION, ATTACKER_BTC, ATTACKER_XMR)),
				trxId: 'ab'.repeat(20),
				blockNumber: 1,
				timestamp: '2026-10-01T00:00:00',
				signer: 'morphit'
			}
		};
		data.set('morphit.releaseCheck.v1', JSON.stringify(forged));
		instance = honest;
		const store = await import('$stores/release');
		await boot();
		const { get } = await import('svelte/store');
		expect(get(store.chainPinnedTreasury)?.btc?.address).toBe(GENUINE_BTC);
		expect(data.has('morphit.releaseCheck.v1')).toBe(false);
	});
});

describe('past treasury BTC keys (orders numbered before a key rotation)', () => {
	const XPUB_OLD =
		'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
	const XPUB_ATTACKER =
		'xpub6DAQJuk3fp8AHZTEz7mx9KazuHD2LPT9GGmPLLbM2gv2sHmbnxPB615DomoH5wsFwXgNjREEh5XGDWssDJU68Pmy1kWDjDMx3YJmk7tfRk9';
	const pinJson = (version: string, xpub: string) =>
		JSON.stringify({
			version,
			hash_manifest: {},
			treasury: { btc: { address: GENUINE_BTC, satoshis: 1500, xpub } }
		});
	function browserStorage(): void {
		const data = new Map<string, string>();
		vi.stubGlobal('window', {
			location: { origin: ORIGIN, hostname: 'morphit.example' },
			localStorage: {
				getItem: (k: string) => data.get(k) ?? null,
				setItem: (k: string, v: string) => void data.set(k, v),
				removeItem: (k: string) => void data.delete(k)
			}
		});
	}
	async function bootWith(tx: Tx, block: number): Promise<void> {
		const chain: NodeAnswer = (method, params) => {
			if (method === 'condenser_api.get_account_history') return [historyEntry(3, block, tx)];
			if (method === 'condenser_api.get_block')
				return (params as number[])[0] === block ? blockWith(block, [tx]) : null;
			return null;
		};
		instance = chain;
		vi.resetModules();
		const store = await import('$stores/release');
		store.resetReleaseStore();
		await store.initRelease();
	}

	it('a key from a release this browser verified is accepted after the rotation, with no request', async () => {
		browserStorage();
		await bootWith(releaseTx(pinJson(RUNNING_VERSION, XPUB_OLD), OFFICIAL, 12), GENUINE_BLOCK - 50);
		const before = calls.length;
		const { verifyPinnedBtcXpub } = await import('$lib/orders/btcFeeKeyHistory');
		expect(await verifyPinnedBtcXpub(XPUB_OLD)).toBe(true);
		expect(calls.length).toBe(before);
	});

	it('a key only the source claims (unsigned release) is never remembered or accepted', async () => {
		browserStorage();
		await bootWith(
			releaseTx(pinJson(RUNNING_VERSION, XPUB_ATTACKER), null, 11),
			GENUINE_BLOCK - 50
		);
		const { verifyPinnedBtcXpub } = await import('$lib/orders/btcFeeKeyHistory');
		expect(await verifyPinnedBtcXpub(XPUB_ATTACKER)).toBe(false);
	});

	it('a key this browser never saw verified: hidden (false), and no request is made for it', async () => {
		browserStorage();
		const { verifyPinnedBtcXpub } = await import('$lib/orders/btcFeeKeyHistory');
		expect(await verifyPinnedBtcXpub(XPUB_OLD)).toBe(false);
		expect(calls.length).toBe(0);
	});
});
