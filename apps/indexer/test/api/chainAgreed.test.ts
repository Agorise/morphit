/**
 * POST /v1/chain/agreed — the browser's release check, read by the instance
 * from two RPC operators that agree (v1.21.14 final review: the browser
 * contacts nothing but its own instance).
 *
 * Pinned:
 *   - only the two reads the check makes are relayed, and a block only when an
 *     agreed history named it (no asking the pool for blocks that do not exist);
 *   - operators agree on what the check reads — the newest release op, the
 *     release's transaction — not on every byte (a transfer to @morphit does
 *     not split them), and only that is relayed;
 *   - one quorum read serves every ask: shared while in flight, kept from when
 *     it settles, a failure kept 30 s — so a flood, from one visitor or many,
 *     costs the pool nothing more, and no visitor can lock the others out;
 *   - a visitor waits at most AGREED_ANSWER_DEADLINE_MS (503 + Retry-After);
 *     the read goes on and fills the cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import {
	AGREED_ANSWER_DEADLINE_MS,
	AGREED_FAIL_CACHE_MS,
	AGREED_HISTORY_ACCOUNT,
	AGREED_HISTORY_CACHE_MS,
	AGREED_MIN_OPERATORS,
	AGREED_NAMED_BLOCK_MS,
	chainExplorerRoute
} from '$api/chainExplorer';
import { transactionIdOf } from '$blurt/snapshotOpTrust';
import type { BlurtClient } from '$blurt/client';
import type { Database } from '$db/pool';

interface AgreedCall {
	method: string;
	params: readonly unknown[];
	minAgree: number;
	mutable: boolean;
	freshOf?: (a: unknown) => number | null;
	keyOf: (a: unknown) => string | null;
}
type Answer = (c: AgreedCall) => Promise<{ value: unknown; key: string } | null>;

function mount(answer: Answer) {
	const calls: AgreedCall[] = [];
	const blurt = {
		condenserAgreed: async (
			method: string,
			params: readonly unknown[],
			keyOf: (a: unknown) => string | null,
			minAgree: number,
			opts: { mutable?: boolean; freshOf?: (a: unknown) => number | null } = {}
		) => {
			const c: AgreedCall = {
				method,
				params,
				keyOf,
				minAgree,
				mutable: opts.mutable === true,
				...(opts.freshOf ? { freshOf: opts.freshOf } : {})
			};
			calls.push(c);
			return answer(c);
		}
	} as unknown as BlurtClient;
	const app = new Hono();
	app.route('/v1/chain', chainExplorerRoute(blurt, {} as Database));
	const post = (body: unknown, ip = '203.0.113.9') =>
		app.request(
			'/v1/chain/agreed',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			},
			{ incoming: { socket: { remoteAddress: ip } } }
		);
	return { calls, post };
}

const HISTORY = { method: 'get_account_history', params: [AGREED_HISTORY_ACCOUNT, -1, 100] };

/** A release transaction (unsigned: the browser checks signatures) and its id. */
function releaseTx(salt: number) {
	const tx = {
		ref_block_num: 100 + salt,
		ref_block_prefix: 7_000 + salt,
		expiration: '2026-10-01T00:01:00',
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: [AGREED_HISTORY_ACCOUNT],
					id: 'morphit_release_v1',
					json: `{"version":"1.21.${salt}"}`
				}
			]
		],
		extensions: [],
		signatures: []
	};
	return { tx, id: transactionIdOf(tx)! };
}
const R1 = releaseTx(14);
const R0 = releaseTx(13);
const BLOCK = 64_000_000;

/** A history entry for `tx` in `block`, sequence `seq`. */
const entry = (seq: number, block: number, r: ReturnType<typeof releaseTx>) => [
	seq,
	{ block, trx_id: r.id, op: r.tx.operations[0] }
];
const transferEntry = (seq: number) => [
	seq,
	{ block: BLOCK + seq, trx_id: 'f'.repeat(40), op: ['transfer', { from: 'x', to: 'morphit' }] }
];
const history = [entry(5, BLOCK - 10, R0), entry(9, BLOCK, R1), transferEntry(10)];
const blockWith = (...txs: unknown[]) => ({
	block_id: BLOCK.toString(16).padStart(8, '0') + 'a'.repeat(32),
	timestamp: '2026-10-01T00:00:30',
	transactions: [{ ref_block_num: 1, ref_block_prefix: 1, expiration: 'x', operations: [] }, ...txs]
});

/** Quorum that answers history with `history` and the block with `block`. */
const honest =
	(block: unknown = blockWith(R1.tx)): Answer =>
	async (c) => {
		const value = c.method === 'get_account_history' ? history : block;
		const key = c.keyOf(value);
		return key === null ? null : { value, key };
	};

afterEach(() => {
	vi.useRealTimers();
});

describe('only the release check reads are relayed', () => {
	it('history: a quorum of two operators, as mutable state, agreeing on the newest release op only', async () => {
		const { calls, post } = mount(honest());
		const res = await post(HISTORY);
		expect(res.status).toBe(200);
		// Only what the check reads: the newest release op's entry.
		expect(((await res.json()) as { result: unknown }).result).toEqual([entry(9, BLOCK, R1)]);
		const c = calls[0]!;
		expect(c.minAgree).toBe(AGREED_MIN_OPERATORS);
		expect(c.minAgree).toBeGreaterThanOrEqual(2);
		expect(c.mutable).toBe(true);
		// Two nodes a moment apart: one has seen one more transfer to @morphit.
		// They name the same release, so they agree.
		expect(c.keyOf(history)).toBe(c.keyOf(history.slice(0, 2)));
		expect(c.keyOf(history)).toBe(`${BLOCK}|${R1.id}`);
		// A node behind names the older release: it disagrees, and it is the
		// OLDER one (freshness by the release's block).
		const behind = [entry(5, BLOCK - 10, R0)];
		expect(c.keyOf(behind)).not.toBe(c.keyOf(history));
		expect(c.freshOf!(behind)).toBeLessThan(c.freshOf!(history)!);
		// No release in the window: agreed as "none", relayed as [].
		expect(c.keyOf([transferEntry(1)])).toBe('none');
	});

	it('history with no release in the window: []', async () => {
		const { post } = mount(async (c) => ({
			value: [transferEntry(1)],
			key: c.keyOf([transferEntry(1)])!
		}));
		expect(((await (await post(HISTORY)).json()) as { result: unknown }).result).toEqual([]);
	});

	it('a block only when an agreed history named it; agreed on the release transaction; only it relayed', async () => {
		const { calls, post } = mount(honest());
		const ask = (n: number) => post({ method: 'get_block', params: [n] });
		// Not named yet: refused, and nothing is asked of the pool.
		expect((await ask(BLOCK)).status).toBe(400);
		expect(calls).toHaveLength(0);
		await post(HISTORY);
		// A block nobody named (one that does not exist, say): refused.
		expect((await ask(4_000_000_000)).status).toBe(400);
		expect((await ask(BLOCK - 10)).status).toBe(400);
		const res = await ask(BLOCK);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { result: unknown }).result).toEqual({
			block_id: blockWith().block_id,
			transactions: [R1.tx]
		});
		const c = calls.find((x) => x.method === 'get_block')!;
		expect(c.minAgree).toBe(AGREED_MIN_OPERATORS);
		expect(c.mutable).toBe(false);
		// Agreed on the transaction, not on the rest of the block.
		expect(c.keyOf(blockWith(R1.tx))).not.toBeNull();
		expect(c.keyOf(blockWith(R1.tx))).toBe(c.keyOf({ ...blockWith(R1.tx), timestamp: 'other' }));
		expect(c.keyOf(blockWith())).toBeNull();
		expect(c.keyOf(blockWith({ ...R1.tx, signatures: ['x'] }))).not.toBe(c.keyOf(blockWith(R1.tx)));
	});

	it('a named block is forgotten after a while', async () => {
		vi.useFakeTimers();
		const { post } = mount(honest());
		await post(HISTORY);
		vi.advanceTimersByTime(AGREED_NAMED_BLOCK_MS + 1);
		expect((await post({ method: 'get_block', params: [BLOCK] })).status).toBe(400);
	});

	it('anything else is refused', async () => {
		const { calls, post } = mount(honest());
		for (const body of [
			{ method: 'get_account_history', params: ['alice', -1, 100] },
			{ method: 'get_account_history', params: [AGREED_HISTORY_ACCOUNT, -1, 1000] },
			{ method: 'get_account_history', params: [AGREED_HISTORY_ACCOUNT, 0, 100] },
			{ method: 'get_block', params: [0] },
			{ method: 'get_block', params: ['1'] },
			{ method: 'get_block', params: [1.5] },
			{ method: 'get_dynamic_global_properties', params: [] },
			{ method: 'get_accounts', params: [['morphit']] },
			[HISTORY],
			'x'
		])
			expect((await post(body)).status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});

describe('no agreement, no answer', () => {
	it('the quorum decided nothing: 502; kept 30 s, then asked again', async () => {
		vi.useFakeTimers();
		const { calls, post } = mount(async () => null);
		expect((await post(HISTORY)).status).toBe(502);
		expect((await post(HISTORY)).status).toBe(502);
		expect(calls).toHaveLength(1);
		vi.advanceTimersByTime(AGREED_FAIL_CACHE_MS + 1);
		expect((await post(HISTORY)).status).toBe(502);
		expect(calls).toHaveLength(2);
	});

	it('a block whose agreed answer does not hold the named release: 502', async () => {
		const { post } = mount(honest(blockWith(R0.tx)));
		await post(HISTORY);
		expect((await post({ method: 'get_block', params: [BLOCK] })).status).toBe(502);
	});
});

describe('one quorum read serves every ask', () => {
	it('concurrent asks, from many visitors, share one read; repeats within a minute are answered from it', async () => {
		const { calls, post } = mount(honest());
		const all = await Promise.all(
			Array.from({ length: 200 }, (_, i) => post(HISTORY, `198.51.100.${i % 250}`))
		);
		expect(all.every((r) => r.status === 200)).toBe(true);
		for (let i = 0; i < 300; i++) expect((await post(HISTORY)).status).toBe(200);
		expect(calls).toHaveLength(1);
	});

	it('one visitor (or one shared Tor/I2P key) asking without end is never refused, and costs nothing more', async () => {
		const { calls, post } = mount(honest());
		for (let i = 0; i < 1_000; i++) expect((await post(HISTORY, '127.0.0.1')).status).toBe(200);
		expect(calls).toHaveLength(1);
	});

	it('kept from when it SETTLES: a slow read is not replaced while it is in flight', async () => {
		vi.useFakeTimers();
		let release: (() => void) | null = null;
		const { calls, post } = mount(
			(c) =>
				new Promise((resolve) => {
					release = () => resolve({ value: history, key: c.keyOf(history)! });
				})
		);
		const first = post(HISTORY);
		await vi.advanceTimersByTimeAsync(AGREED_HISTORY_CACHE_MS + 5_000);
		const second = post(HISTORY);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		release!();
		await vi.advanceTimersByTimeAsync(0);
		// Both waited past the deadline: told to come back; the read is kept.
		expect((await first).status).toBe(503);
		expect((await second).status).toBe(200);
		expect((await post(HISTORY)).status).toBe(200);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(AGREED_HISTORY_CACHE_MS + 1);
		const third = post(HISTORY);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(2);
		release!();
		expect((await third).status).toBe(200);
	});

	it(`a visitor waits at most ${AGREED_ANSWER_DEADLINE_MS / 1000} s: 503 with Retry-After, and the read goes on`, async () => {
		vi.useFakeTimers();
		let release: (() => void) | null = null;
		const { calls, post } = mount(
			(c) =>
				new Promise((resolve) => {
					release = () => resolve({ value: history, key: c.keyOf(history)! });
				})
		);
		const slow = post(HISTORY);
		await vi.advanceTimersByTimeAsync(AGREED_ANSWER_DEADLINE_MS + 1);
		const res = await slow;
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('30');
		release!();
		await vi.advanceTimersByTimeAsync(0);
		expect((await post(HISTORY)).status).toBe(200);
		expect(calls).toHaveLength(1);
	});
});
