// @vitest-environment jsdom
/**
 * The view counter's two calls against a stubbed fetch: the increment is a
 * JSON POST (the indexer refuses a write that is not `application/json`, the
 * kind a page on another origin can send without a preflight), and the batch
 * read keeps only well-formed counts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchOrderViewCounts, recordOrderView } from './views';

type Call = { url: string; init: RequestInit };

function stubFetch(body: unknown, status = 200): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('recordOrderView', () => {
	it('sends a JSON POST with a JSON body', async () => {
		const calls = stubFetch({ count: 3 });
		await recordOrderView('alice', 'ord-1');
		expect(calls).toHaveLength(1);
		const { url, init } = calls[0]!;
		expect(url).toMatch(/\/v1\/orders\/alice\/ord-1\/view$/);
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('omit');
		const headers = new Headers(init.headers);
		expect(headers.get('content-type')).toBe('application/json');
		expect(JSON.parse(String(init.body))).toEqual({});
	});
});

describe('fetchOrderViewCounts', () => {
	it('asks once for every permlink and keeps only valid counts', async () => {
		const calls = stubFetch({ counts: { a: 2, b: -5, c: 'x', d: 0 } });
		const r = await fetchOrderViewCounts('alice', ['a', 'b', 'c', 'd']);
		expect(calls).toHaveLength(1);
		const u = new URL(calls[0]!.url);
		expect(u.pathname).toBe('/v1/orders/alice/view_counts');
		expect(u.searchParams.get('permlinks')).toBe('a,b,c,d');
		expect(r).toEqual(
			new Map([
				['a', 2],
				['d', 0]
			])
		);
	});
	it('splits more than 100 permlinks into several requests', async () => {
		const calls = stubFetch({ counts: {} });
		const many = Array.from({ length: 150 }, (_, i) => `p${i}`);
		await fetchOrderViewCounts('alice', many);
		expect(calls).toHaveLength(2);
	});
	it('returns null when the read fails', async () => {
		stubFetch({ code: 'internal' }, 500);
		expect(await fetchOrderViewCounts('alice', ['a'])).toBeNull();
	});
});
