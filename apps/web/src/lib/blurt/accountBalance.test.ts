/*
 * Morphit frontend — fetchAccountBalance cache-mode tests.
 *
 * Regression guard for the balance-staleness bug: the wallet card's
 * manual refresh button performs a HARD refresh, which must reach the
 * network past every cache layer (browser, service worker, reverse
 * proxy). That guarantee lives in the `noCache` argument here:
 *
 *   • noCache=true  → a unique `?_cb=` URL + `cache: 'no-store'`, so the
 *                     request can never be answered from any cache.
 *   • noCache=false → the normal short-cached path used by the silent
 *                     5s poll, where the indexer's `Cache-Control`
 *                     governs freshness.
 *
 * If either contract regresses, the manual refresh quietly starts
 * serving a stale balance again — exactly the bug this guards.
 */

import { describe, it, expect, vi } from 'vitest';

import { fetchAccountBalance } from './accountBalance';

/** A non-2xx response is enough: fetchAccountBalance records the
 *  request (URL + cache option) before it ever inspects the body. */
function stubResponse(): Response {
	return new Response('{"error":"stub"}', {
		status: 502,
		headers: { 'content-type': 'application/json' }
	});
}

describe('fetchAccountBalance — cache mode', () => {
	it('noCache=true forces a cache-busted, no-store request (hard refresh)', async () => {
		const spy = vi.fn(async () => stubResponse());
		await fetchAccountBalance(
			'https://idx.example',
			'kentest3',
			spy as unknown as typeof fetch,
			true
		);
		expect(spy).toHaveBeenCalledTimes(1);
		const [url, opts] = spy.mock.calls[0] as unknown as [string, RequestInit];
		expect(String(url)).toContain('/v1/account/kentest3/balance');
		expect(String(url)).toContain('?_cb=');
		expect(opts.cache).toBe('no-store');
	});

	it('noCache=false uses the normal short-cached path (silent poll)', async () => {
		const spy = vi.fn(async () => stubResponse());
		await fetchAccountBalance('https://idx.example', 'kentest3', spy as unknown as typeof fetch);
		const [url, opts] = spy.mock.calls[0] as unknown as [string, RequestInit];
		expect(String(url)).not.toContain('?_cb=');
		expect(opts.cache).toBe('default');
	});

	it('account names with reserved characters stay URL-encoded under cache-bust', async () => {
		const spy = vi.fn(async () => stubResponse());
		await fetchAccountBalance(
			'https://idx.example',
			'a b',
			spy as unknown as typeof fetch,
			true
		);
		const [url] = spy.mock.calls[0] as unknown as [string, RequestInit];
		expect(String(url)).toContain('/v1/account/a%20b/balance?_cb=');
	});
});
