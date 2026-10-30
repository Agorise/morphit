/**
 * POST /v1/chain/agreed on an instance whose every RPC node is a Tor/I2P
 * service (v1.21.18).
 *
 * WHAT WENT WRONG. The browser's release check asks the instance for the
 * newest 100 entries of @morphit's history; the instance read them in one
 * quorum read. Over Tor/I2P such a read never arrives (morphitlat, v1.21.16:
 * 10 entries took 33.7 s, 100 none within 240 s), so on a zero-clearnet
 * instance the check never had an answer.
 *
 * NOW. On such an instance the same window is read in small agreed pages,
 * newest first, and the first page naming a release op answers. A window the
 * pages do not reach is "could not read" (502), never "no release" — the
 * browser shows a warning only for what it was told.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import {
	AGREED_HIDDEN_MAX_DEPTH,
	AGREED_HISTORY_ACCOUNT,
	AGREED_MIN_OPERATORS,
	chainExplorerRoute
} from '$api/chainExplorer';
import { HIDDEN_HISTORY_PAGE_SIZE, transactionIdOf } from '$blurt/snapshotOpTrust';
import type { BlurtClient } from '$blurt/client';
import type { Database } from '$db/pool';

const RELEASE = {
	ref_block_num: 114,
	ref_block_prefix: 7_014,
	expiration: '2026-10-01T00:01:00',
	operations: [
		[
			'custom_json',
			{
				required_auths: [],
				required_posting_auths: [AGREED_HISTORY_ACCOUNT],
				id: 'morphit_release_v1',
				json: '{"version":"1.21.18"}'
			}
		]
	],
	extensions: [],
	signatures: []
};
const RELEASE_ID = transactionIdOf(RELEASE)!;
const BLOCK = 64_900_000;

/** @morphit's history 0..top: an entry at every odd position (the other is the
 *  chain's fee for the op), the release at `releaseAt` (if any). */
function history(top: number, releaseAt: number | null): Array<[number, unknown]> {
	const out: Array<[number, unknown]> = [];
	for (let seq = 1; seq <= top; seq += 2) {
		out.push(
			seq === releaseAt
				? [seq, { block: BLOCK, trx_id: RELEASE_ID, op: RELEASE.operations[0] }]
				: [
						seq,
						{
							block: BLOCK - 1_000 + seq,
							trx_id: seq.toString(16).padStart(40, '0'),
							op: [
								'custom_json',
								{ id: 'community', required_posting_auths: ['morphit'], json: '{}' }
							]
						}
					]
		);
	}
	return out;
}

function mount(top: number, releaseAt: number | null, pool: string[]) {
	const h = history(top, releaseAt);
	const calls: Array<{ method: string; params: readonly unknown[]; minAgree: number }> = [];
	const blurt = {
		endpointSnapshot: () => pool.map((url) => ({ url })),
		condenserAgreed: async (
			method: string,
			params: readonly unknown[],
			keyOf: (a: unknown) => string | null,
			minAgree: number
		) => {
			calls.push({ method, params, minAgree });
			if (method === 'get_block')
				return {
					value: { block_id: 'b'.repeat(40), transactions: [RELEASE] },
					key: keyOf({ block_id: 'b'.repeat(40), transactions: [RELEASE] }) ?? ''
				};
			const [, from, limit] = params as [string, number, number];
			const hi = from === -1 ? top : from;
			const page = h.filter(([s]) => s >= Math.max(0, hi - limit) && s <= hi);
			// Over Tor/I2P a large page never arrives: no agreement.
			if (page.length > 50) return null;
			const key = keyOf(page);
			return key === null ? null : { value: page, key };
		}
	} as unknown as BlurtClient;
	const app = new Hono();
	app.route('/v1/chain', chainExplorerRoute(blurt, {} as Database));
	const post = (body: unknown) =>
		app.request(
			'/v1/chain/agreed',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			},
			{ incoming: { socket: { remoteAddress: '203.0.113.9' } } }
		);
	return { calls, post };
}

const HIDDEN = ['http://aaaa.onion', 'http://bbbb.b32.i2p'];
const ask = (limit: number) => ({
	method: 'get_account_history',
	params: [AGREED_HISTORY_ACCOUNT, -1, limit]
});

describe('the release check on a Tor/I2P-only instance', () => {
	it('reads the window in small agreed pages and answers with the release', async () => {
		const { calls, post } = mount(1_201, 1_175, HIDDEN);
		const res = await post(ask(100));
		expect(res.status).toBe(200);
		const result = ((await res.json()) as { result: unknown[] }).result;
		expect(result).toHaveLength(1);
		expect((result[0] as [number, { trx_id: string }])[1].trx_id).toBe(RELEASE_ID);
		const pages = calls.filter((c) => c.method === 'get_account_history');
		expect(pages.map((p) => p.params[1])).toEqual([-1, 1_190, 1_180]);
		for (const p of pages) {
			expect(p.params[2]).toBeLessThanOrEqual(HIDDEN_HISTORY_PAGE_SIZE);
			expect(p.minAgree).toBe(AGREED_MIN_OPERATORS);
		}
		// The block that history named may now be read, as before.
		expect((await post({ method: 'get_block', params: [BLOCK] })).status).toBe(200);
	});

	it('a window the pages do not reach is "could not read", never "no release"', async () => {
		const { post } = mount(5_001, 101, HIDDEN);
		const res = await post(ask(10_000));
		expect(res.status).toBe(502);
	});

	it('a window read to its end without a release is "no release", as before', async () => {
		const { post } = mount(1_201, 101, HIDDEN);
		const res = await post(ask(100));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { result: unknown[] }).result).toEqual([]);
		expect(AGREED_HIDDEN_MAX_DEPTH).toBeGreaterThanOrEqual(100);
	});

	it('an instance with a clearnet node keeps the one read of the window', async () => {
		const { calls, post } = mount(99, 75, [...HIDDEN, 'https://rpc.example.org']);
		expect((await post(ask(100))).status).toBe(200);
		expect(calls.map((c) => c.params)).toEqual([[AGREED_HISTORY_ACCOUNT, -1, 100]]);
	});
});
