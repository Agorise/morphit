// @vitest-environment jsdom
/**
 * The order reads a page needs one of: a single order by account + permlink,
 * the Sybil tier the indexer charges by, and the batch counterparty lists —
 * each one request to the indexer's own endpoint, so an account with more
 * orders than one page is quoted and found correctly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { findOrder, getOrderCounterpartyLists, getSybilTier } from './client';

const calls: string[] = [];
function stub(status: number, body: unknown): void {
	calls.length = 0;
	vi.stubGlobal('fetch', async (url: string) => {
		calls.push(String(url));
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	});
}
afterEach(() => vi.unstubAllGlobals());

describe('getSybilTier', () => {
	it('asks the indexer for its own count', async () => {
		stub(200, { account: 'alice', at: '2026-10-02T00:00:00.000Z', count: 5 });
		const r = await getSybilTier('alice');
		expect(r.ok && r.data.count).toBe(5);
		expect(new URL(calls[0]!).pathname).toBe('/v1/orders/alice/sybil_tier');
	});
	it('a failed read is an error, not a zero', async () => {
		stub(500, { code: 'internal', message: 'boom' });
		const r = await getSybilTier('alice');
		expect(r.ok).toBe(false);
	});
});

describe('findOrder', () => {
	it('reads one order directly', async () => {
		stub(200, { item: { account: 'alice', permlink: 'old-1', status: 'live' } });
		const o = await findOrder('alice', 'old-1');
		expect(o?.permlink).toBe('old-1');
		expect(new URL(calls[0]!).pathname).toBe('/v1/orders/alice/old-1');
	});
	it('null when the indexer has no such order, undefined when the read failed', async () => {
		stub(404, { code: 'not_found', message: 'order not found' });
		expect(await findOrder('alice', 'gone')).toBeNull();
		stub(503, { code: 'service_starting', message: 'syncing' });
		expect(await findOrder('alice', 'x')).toBeUndefined();
	});
});

describe('getOrderCounterpartyLists', () => {
	it('one request for several orders', async () => {
		stub(200, { owner: 'alice', lists: { a: [{ peer: 'bob', reviewable: true }], b: [] } });
		const r = await getOrderCounterpartyLists('alice', ['a', 'b']);
		expect(calls).toHaveLength(1);
		const u = new URL(calls[0]!);
		expect(u.pathname).toBe('/v1/orders/alice/counterparty_lists');
		expect(u.searchParams.get('permlinks')).toBe('a,b');
		expect(r.ok && r.data.lists.a?.[0]?.peer).toBe('bob');
	});
});

describe('getAccountOrderPages', () => {
	it('follows the cursor until the last page', async () => {
		const pages = [
			{ items: [{ permlink: 'a' }], next_cursor: 'c1' },
			{ items: [{ permlink: 'b' }], next_cursor: null }
		];
		const urls: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			urls.push(String(url));
			return new Response(JSON.stringify(pages[urls.length - 1]), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		});
		const { getAccountOrderPages } = await import('./client');
		const r = await getAccountOrderPages('alice');
		expect(r?.items.map((o) => o.permlink)).toEqual(['a', 'b']);
		expect(r?.complete).toBe(true);
		expect(new URL(urls[1]!).searchParams.get('cursor')).toBe('c1');
	});
	it('stops at maxPages and says so', async () => {
		vi.stubGlobal(
			'fetch',
			async () =>
				new Response(JSON.stringify({ items: [{ permlink: 'x' }], next_cursor: 'more' }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		const { getAccountOrderPages } = await import('./client');
		const r = await getAccountOrderPages('alice', { maxPages: 3 });
		expect(r?.items).toHaveLength(3);
		expect(r?.complete).toBe(false);
	});
});
