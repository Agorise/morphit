/**
 * fetchAccountKeys has a deadline (v1.21.13, review H2). Chat reads posting
 * keys through it on every message to someone without a chat key: a server
 * that never answers — or sends its headers and then stalls — must not hold a
 * send open forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ACCOUNT_KEYS_REUSE_MS,
	ACCOUNT_KEYS_RETRY_WAIT_MS,
	ACCOUNT_KEYS_TIMEOUT_MS,
	fetchAccountKeys,
	fetchAccountKeysForSigning
} from './accountKeys';

const ORIGIN = 'https://example.test';
const body = {
	account: {
		owner: { weight_threshold: 1, account_auths: [], key_auths: [] },
		active: { weight_threshold: 1, account_auths: [], key_auths: [] },
		posting: { weight_threshold: 1, account_auths: [], key_auths: [['BLTx', 1]] },
		memo_key: 'BLTm'
	}
};
const never = <T>() => new Promise<T>(() => undefined);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('fetchAccountKeys', () => {
	it('answers normally, and leaves no timer behind', async () => {
		const f = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
		const r = await fetchAccountKeys(ORIGIN, 'bob', f as never);
		expect(r?.posting.key_auths).toEqual([['BLTx', 1]]);
		expect(vi.getTimerCount()).toBe(0);
		expect(
			await fetchAccountKeys(
				ORIGIN,
				'bob',
				(async () => new Response('', { status: 404 })) as never
			)
		).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('a server that never answers: each try aborted at the deadline; rejected after the quiet second try', async () => {
		const signals: AbortSignal[] = [];
		const f = vi.fn((_u: URL, init?: RequestInit) => {
			if (init?.signal) signals.push(init.signal);
			return never<Response>();
		});
		let outcome = 'pending';
		void fetchAccountKeys(ORIGIN, 'bob', f as never).then(
			() => (outcome = 'resolved'),
			() => (outcome = 'rejected')
		);
		await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_TIMEOUT_MS - 1);
		expect(signals[0]?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signals[0]?.aborted).toBe(true);
		expect(outcome).toBe('pending'); // v1.24.2: asked once more, quietly
		await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_RETRY_WAIT_MS + ACCOUNT_KEYS_TIMEOUT_MS);
		expect(outcome).toBe('rejected');
		expect(f).toHaveBeenCalledTimes(2);
		expect(signals[1]?.aborted).toBe(true);
	});

	it('a server that sends headers and then stalls the body: rejected at the deadline too', async () => {
		const f = vi.fn(
			async () => ({ ok: true, status: 200, json: () => never() }) as unknown as Response
		);
		const settled = fetchAccountKeys(ORIGIN, 'bob', f as never).then(
			() => 'resolved',
			() => 'rejected'
		);
		await vi.advanceTimersByTimeAsync(2 * ACCOUNT_KEYS_TIMEOUT_MS + ACCOUNT_KEYS_RETRY_WAIT_MS);
		expect(await settled).toBe('rejected');
	});

	it('overlapping lookups of one account share one request; a later one is reused, then asked again', async () => {
		const resolvers: Array<(r: Response) => void> = [];
		const f = vi.fn(() => new Promise<Response>((r) => resolvers.push(r)));
		const a = fetchAccountKeys(ORIGIN, 'bob', f as never);
		const b = fetchAccountKeys(ORIGIN, 'bob', f as never);
		const c = fetchAccountKeys(ORIGIN, 'cyd', f as never);
		expect(f).toHaveBeenCalledTimes(2);
		for (const r of resolvers) r(new Response(JSON.stringify(body), { status: 200 }));
		await Promise.all([a, b, c]);
		expect(await a).toBe(await b);
		const g = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
		await fetchAccountKeys(ORIGIN, 'bob', g as never);
		// Posting an order reads the keys twice within seconds (the active-key
		// window, then the broadcast): the second read is the first's answer.
		vi.advanceTimersByTime(ACCOUNT_KEYS_REUSE_MS - 1);
		await fetchAccountKeys(ORIGIN, 'bob', g as never);
		expect(g).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		await fetchAccountKeys(ORIGIN, 'bob', g as never);
		expect(g).toHaveBeenCalledTimes(2);
	});

	it('"no such account" is not kept: the next lookup asks again', async () => {
		const g = vi.fn(async () => new Response('{}', { status: 404 }));
		expect(await fetchAccountKeys(ORIGIN, 'nobody', g as never)).toBeNull();
		expect(await fetchAccountKeys(ORIGIN, 'nobody', g as never)).toBeNull();
		expect(g).toHaveBeenCalledTimes(2);
	});

	it('a failed lookup is not kept either', async () => {
		let n = 0;
		const g = vi.fn(async () =>
			++n <= 2
				? new Response('{}', { status: 502 })
				: new Response(JSON.stringify(body), { status: 200 })
		);
		const first = expect(fetchAccountKeys(ORIGIN, 'eve', g as never)).rejects.toThrow(/502/);
		await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_RETRY_WAIT_MS);
		await first;
		expect((await fetchAccountKeys(ORIGIN, 'eve', g as never))?.memo_key).toBe('BLTm');
	});

	// v1.24.2 — whoever asks (a chat send, Verify peer, a shared address, a
	// review, pairing): one failure is asked again, quietly, before the caller
	// hears of it. A node that was slow once is not an error on anyone's screen.
	it('a refused request (4xx) is not asked again: it would be refused the same way', async () => {
		const g = vi.fn(async () => new Response('{}', { status: 429 }));
		await expect(fetchAccountKeys(ORIGIN, 'lou', g as never)).rejects.toThrow(/429/);
		expect(g).toHaveBeenCalledTimes(1);
	});

	it('one failure is asked again quietly, and the caller only sees the answer', async () => {
		let n = 0;
		const g = vi.fn(async () =>
			++n === 1
				? new Response('{}', { status: 502 })
				: new Response(JSON.stringify(body), { status: 200 })
		);
		const p = fetchAccountKeys(ORIGIN, 'kim', g as never);
		await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_RETRY_WAIT_MS);
		expect((await p)?.memo_key).toBe('BLTm');
		expect(g).toHaveBeenCalledTimes(2);
	});
});

describe('fetchAccountKeysForSigning (posting an order, unlocking the active key)', () => {
	it('asks once more after a 502 before failing (and no more than that)', async () => {
		let n = 0;
		const g = vi.fn(async () =>
			++n === 1
				? new Response('{}', { status: 502 })
				: new Response(JSON.stringify(body), { status: 200 })
		);
		const p = fetchAccountKeysForSigning(ORIGIN, 'fay', g as never);
		await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_RETRY_WAIT_MS);
		expect((await p)?.memo_key).toBe('BLTm');
		expect(g).toHaveBeenCalledTimes(2);
	});

	it('asks once more after its own timeout', async () => {
		let n = 0;
		const g = vi.fn((_u: unknown, init?: RequestInit) =>
			++n === 1
				? new Promise<Response>((_, reject) =>
						init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
					)
				: Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
		);
		const p = fetchAccountKeysForSigning(ORIGIN, 'gus', g as never);
		await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_TIMEOUT_MS + ACCOUNT_KEYS_RETRY_WAIT_MS);
		expect((await p)?.memo_key).toBe('BLTm');
		expect(g).toHaveBeenCalledTimes(2);
	});

	it('gives up after the second failure, and does not retry "no such account"', async () => {
		const bad = vi.fn(async () => new Response('{}', { status: 502 }));
		const failed = expect(fetchAccountKeysForSigning(ORIGIN, 'hal', bad as never)).rejects.toThrow(
			/502/
		);
		await vi.advanceTimersByTimeAsync(ACCOUNT_KEYS_RETRY_WAIT_MS);
		await failed;
		expect(bad).toHaveBeenCalledTimes(2);
		const none = vi.fn(async () => new Response('{}', { status: 404 }));
		expect(await fetchAccountKeysForSigning(ORIGIN, 'ivy', none as never)).toBeNull();
		expect(none).toHaveBeenCalledTimes(1);
	});
});
