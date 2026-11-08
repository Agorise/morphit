/**
 * GET /v1/chain/tx/:id — "the chain does not have it" is not an outage.
 *
 * v1.18.0 review (W3). The browser's chat sweep asks this before it calls one
 * of the user's sends failed: a message that DID land, on an instance whose
 * indexer is behind, must not be failed and retried into a second on-chain
 * copy. That needs "no such transaction" and "could not ask" kept apart. A node
 * answers an unknown id by THROWING ("Unknown Transaction …"), and every throw
 * used to become a 502 — so "no" read as "could not reach the network".
 */
import { describe, expect, it } from 'vitest';

import { chainExplorerRoute } from '$api/chainExplorer';
import type { BlurtClient } from '$blurt/client';
import type { Database } from '$db/pool';

const ID = 'a'.repeat(40);

function routeThrowing(err: unknown) {
	const blurt = {
		callCondenser: async () => {
			throw err;
		}
	} as unknown as BlurtClient;
	return chainExplorerRoute(blurt, {} as Database);
}

describe('GET /tx/:id', () => {
	it('a node that answers "Unknown Transaction" is a 404, not an outage', async () => {
		const res = await routeThrowing(
			new Error(`Assert Exception:false: Unknown Transaction ${ID}`)
		).request(`/tx/${ID}`);
		expect(res.status).toBe(404);
	});

	it('a transport failure is still a 502', async () => {
		const res = await routeThrowing(
			Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
		).request(`/tx/${ID}`);
		expect(res.status).toBe(502);
	});

	it('any other chain error is still a 502, never a false "not there"', async () => {
		const res = await routeThrowing(new Error('Could not find API account_history_api')).request(
			`/tx/${ID}`
		);
		expect(res.status).toBe(502);
	});
});

/**
 * v1.23.4 — `?block=N`: owner, a live trade: the BLURT receipt's "Verify on
 * block explorer" said "Transaction not found" right after the payment (both
 * instances found it later). A node's transaction index may not hold a fresh
 * transaction yet, or the node keeps none; the block it is in, every node
 * serves.
 */
describe('GET /tx/:id?block=N (v1.23.4)', () => {
	const TX = {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: '2026-11-07T20:44:00',
		operations: [['transfer', { from: 'kencode', to: 'josiemoto', amount: '3804.602 BLURT' }]],
		extensions: [],
		signatures: ['1f']
	};
	const OTHER = { ...TX, signatures: ['20'] };
	function route(tx: 'unknown' | 'no_plugin' | 'down' | 'found', block: unknown = undefined) {
		const calls: string[] = [];
		const blurt = {
			callCondenser: async (method: string) => {
				calls.push(method);
				if (method === 'get_transaction') {
					if (tx === 'found')
						return { ...TX, transaction_id: ID, block_num: 9, transaction_num: 1 };
					if (tx === 'unknown')
						throw new Error(`Assert Exception:false: Unknown Transaction ${ID}`);
					if (tx === 'no_plugin') throw new Error('Could not find API account_history_api');
					throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
				}
				if (method === 'get_block') {
					if (block instanceof Error) throw block;
					return block;
				}
				throw new Error(method);
			}
		} as unknown as BlurtClient;
		return { app: chainExplorerRoute(blurt, {} as Database), calls };
	}
	const BLOCK = {
		transactions: [OTHER, TX],
		transaction_ids: ['b'.repeat(40), ID]
	};

	it('not in the index yet: read from its block, annotated like get_transaction', async () => {
		const { app, calls } = route('unknown', BLOCK);
		const res = await app.request(`/tx/${ID}?block=65148473`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tx: Record<string, unknown> };
		expect(body.tx).toEqual({
			...TX,
			transaction_id: ID,
			block_num: 65148473,
			transaction_num: 1
		});
		expect(calls).toEqual(['get_transaction', 'get_block']);
	});

	it('a node keeping no index, or none answering it: still read from its block', async () => {
		for (const t of ['no_plugin', 'down'] as const) {
			const res = await route(t, BLOCK).app.request(`/tx/${ID}?block=7`);
			expect(res.status, t).toBe(200);
		}
	});

	it('found in the index: the block is not read', async () => {
		const { app, calls } = route('found', BLOCK);
		expect((await app.request(`/tx/${ID}?block=7`)).status).toBe(200);
		expect(calls).toEqual(['get_transaction']);
	});

	it('the block read and not holding it: 404 only when the index said "unknown" too', async () => {
		const absent = { transactions: [OTHER], transaction_ids: ['b'.repeat(40)] };
		expect((await route('unknown', absent).app.request(`/tx/${ID}?block=7`)).status).toBe(404);
		// The index could not answer: the block number may be wrong (review).
		expect((await route('no_plugin', absent).app.request(`/tx/${ID}?block=7`)).status).toBe(502);
		expect((await route('down', absent).app.request(`/tx/${ID}?block=7`)).status).toBe(502);
	});

	it('the block unreadable: "could not check", never "not found" (review: the owner\'s symptom)', async () => {
		expect((await route('unknown', null).app.request(`/tx/${ID}?block=7`)).status).toBe(502);
		expect(
			(await route('unknown', new Error('down')).app.request(`/tx/${ID}?block=7`)).status
		).toBe(502);
		expect((await route('down', null).app.request(`/tx/${ID}?block=7`)).status).toBe(502);
		expect(
			(await route('no_plugin', new Error('down')).app.request(`/tx/${ID}?block=7`)).status
		).toBe(502);
		// A block whose lists do not line up is no answer either.
		const odd = { transactions: [null, null], transaction_ids: ['b'.repeat(40), ID] };
		expect((await route('down', odd).app.request(`/tx/${ID}?block=7`)).status).toBe(502);
	});

	it('the id matches whatever its case', async () => {
		const upper = { transactions: [TX], transaction_ids: [ID.toUpperCase()] };
		expect((await route('unknown', upper).app.request(`/tx/${ID}?block=7`)).status).toBe(200);
	});

	it('a bad block number: 400, nothing asked', async () => {
		for (const b of ['0', '-1', '1.5', 'x', '01', '2147483648', '99999999999', '']) {
			const { app, calls } = route('unknown', BLOCK);
			expect((await app.request(`/tx/${ID}?block=${b}`)).status, b).toBe(400);
			expect(calls).toEqual([]);
		}
	});

	it('without ?block, as before: no block read', async () => {
		const { app, calls } = route('unknown', BLOCK);
		expect((await app.request(`/tx/${ID}`)).status).toBe(404);
		expect(calls).toEqual(['get_transaction']);
	});
});
