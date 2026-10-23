/**
 * For the release tests: the instance's agreed-read relay (`POST
 * /v1/chain/agreed`) simulated behind `fetch`, and the @morphit release
 * fixtures it serves. A request to any other URL fails, as the page's
 * Content-Security-Policy (connect-src 'self') makes it fail in a browser.
 */
import { vi } from 'vitest';
import { PrivateKey, cryptoUtils, DEFAULT_CHAIN_ID } from '@beblurt/dblurt';

export const TEST_ORIGIN = 'https://instance.example';
export const AGREED_URL = `${TEST_ORIGIN}/v1/chain/agreed`;
export const GENUINE_BTC = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
export const ATTACKER_BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

/** What the relay answers for one read; 'down' is a 502 (no agreement). */
export type ChainAnswer = (method: string, params: unknown) => unknown;

export const instance: {
	answer: ChainAnswer | 'down';
	calls: Array<{ url: string; method: string; params: unknown }>;
} = { answer: 'down', calls: [] };

/** Stub `location`, `window` (with `extra`) and `fetch`; the relay starts down. */
export function stubInstance(extra: Record<string, unknown> = {}): void {
	instance.answer = 'down';
	instance.calls.length = 0;
	stubWindow(extra);
	vi.stubGlobal('location', { protocol: 'https:', hostname: 'instance.example' });
	vi.stubGlobal('fetch', async (input: string | URL, init: { body: string }) => {
		const url = String(input);
		const req = JSON.parse(init.body) as { method: string; params: unknown };
		instance.calls.push({ url, method: req.method, params: req.params });
		if (url !== AGREED_URL) throw new TypeError('Failed to fetch');
		const answer = instance.answer;
		if (answer === 'down')
			return new Response(JSON.stringify({ status: 'error', code: 'internal' }), {
				status: 502
			});
		return new Response(
			JSON.stringify({ result: answer(`condenser_api.${req.method}`, req.params) }),
			{
				status: 200
			}
		);
	});
}

/** `window` with this origin and whatever else a test needs (storage). */
export function stubWindow(extra: Record<string, unknown> = {}): void {
	vi.stubGlobal('window', {
		location: { origin: TEST_ORIGIN, hostname: 'instance.example' },
		...extra
	});
}

/** A browser's localStorage, shared by every "tab" (fresh module set). */
export function browserStorage(): Map<string, string> {
	const data = new Map<string, string>();
	stubWindow({
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
	return data;
}

export interface Tx {
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
	operations: Array<[string, Record<string, unknown>]>;
	extensions: unknown[];
	signatures: string[];
}

export const releaseJson = (version: string, btc: string): string =>
	JSON.stringify({
		version,
		hash_manifest: {},
		treasury: { btc: { address: btc, satoshis: 1500 } }
	});

/** A release transaction, signed by `key` (none: unsigned). */
export function releaseTx(json: string, key: PrivateKey | null, salt: number): Tx {
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
export const trxIdOf = (tx: Tx): string => cryptoUtils.generateTrxId(tx as never);

export function blockWith(num: number, txs: Tx[]): unknown {
	return {
		previous: '0'.repeat(40),
		timestamp: '2026-10-01T00:00:30',
		transactions: txs,
		block_id: num.toString(16).padStart(8, '0') + 'f'.repeat(32),
		transaction_ids: txs.map(trxIdOf)
	};
}

/** The relay serving `tx` as @morphit's newest release, in block `block`. */
export function serving(tx: Tx, block: number): ChainAnswer {
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
