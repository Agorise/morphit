/**
 * (v1.18.0 deep-deep, L1) fetchChainTx must settle. It had no timeout, and the
 * chat sweep asks it before calling a send failed — a lookup that hung (an
 * ordinary thing on a Tor circuit) left the message "confirmed" for as long as
 * the request did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchChainTx } from './chainExplorer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('fetchChainTx is bounded', () => {
	it('a request that never answers ends as an error once its budget runs out', async () => {
		const seen: AbortSignal[] = [];
		const hang = vi.fn((_u: unknown, init?: RequestInit) => {
			if (init?.signal) seen.push(init.signal);
			return new Promise<Response>(() => undefined); // ignores the abort, too
		}) as unknown as typeof fetch;
		let settled: unknown = null;
		void fetchChainTx('https://idx.example', 'a'.repeat(40), hang, 5_000).then(
			(r) => (settled = r)
		);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(settled).toBeNull();
		await vi.advanceTimersByTimeAsync(2);
		expect(settled).toEqual({ kind: 'error', message: 'timed out' });
		expect(seen[0]?.aborted).toBe(true);
	});

	it('a body that stalls after the headers is bounded too', async () => {
		const stalled = vi.fn(async () => ({
			status: 200,
			ok: true,
			json: () => new Promise(() => undefined)
		})) as unknown as typeof fetch;
		let settled: unknown = null;
		void fetchChainTx('https://idx.example', 'b'.repeat(40), stalled, 5_000).then(
			(r) => (settled = r)
		);
		await vi.advanceTimersByTimeAsync(5_001);
		expect(settled).toEqual({ kind: 'error', message: 'timed out' });
	});

	it('a normal answer is unaffected', async () => {
		const ok = vi.fn(
			async () => new Response(JSON.stringify({ tx: { ref_block_num: 1 } }), { status: 200 })
		) as unknown as typeof fetch;
		await expect(fetchChainTx('https://idx.example', 'c'.repeat(40), ok, 5_000)).resolves.toEqual({
			kind: 'ok',
			tx: { ref_block_num: 1 }
		});
		const nf = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
		await expect(fetchChainTx('https://idx.example', 'c'.repeat(40), nf, 5_000)).resolves.toEqual({
			kind: 'not_found'
		});
	});
});
