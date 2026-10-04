/**
 * One account-history page from the indexer: a page too large for a reply
 * (413) is asked again smaller; a busy indexer (503 history_busy, Retry-After)
 * is waited out a few times; nothing is ever read as "no more history".
 */
import { describe, expect, it } from 'vitest';

import { fetchAccountHistoryPage } from './accountHistoryPage';

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
const ok = (n: number): Reply => ({
	status: 200,
	body: { account: 'alice', entries: Array.from({ length: n }, (_, i) => [i, { op: ['x', {}] }]) }
});
const busy = (retryAfter?: string): Reply => ({
	status: 503,
	body: { status: 'error', code: 'history_busy', message: 'retry shortly' },
	headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter }
});

function server(replies: Reply[]) {
	const urls: string[] = [];
	const fetchImpl = (async (url: string) => {
		urls.push(url);
		const r = replies.shift() ?? ok(0);
		return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
	}) as unknown as typeof fetch;
	return { fetchImpl, urls };
}

async function read(replies: Reply[], limit = 50) {
	const s = server(replies);
	const waits: number[] = [];
	const r = await fetchAccountHistoryPage(
		'https://i.example',
		'alice',
		-1,
		limit,
		s.fetchImpl,
		false,
		async (ms) => {
			waits.push(ms);
		}
	);
	return { r, waits, urls: s.urls };
}

describe('fetchAccountHistoryPage', () => {
	it('waits Retry-After on history_busy and reads the same page again', async () => {
		const { r, waits, urls } = await read([busy('5'), busy('5'), ok(50)]);
		expect(r).toMatchObject({ kind: 'ok', limit: 50 });
		expect(r.kind === 'ok' && r.entries.length).toBe(50);
		expect(waits).toEqual([5_000, 5_000]);
		expect(new Set(urls).size).toBe(1);
	});
	it('a missing or absurd Retry-After is waited a bounded time', async () => {
		const { waits } = await read([busy(), busy('86400'), ok(1)]);
		expect(waits[0]).toBe(5_000);
		expect(waits[1]).toBeLessThanOrEqual(30_000);
	});
	it('still busy after a few tries: an error marked busy, not an empty page', async () => {
		const { r, urls } = await read(Array.from({ length: 20 }, () => busy('5')));
		expect(r).toMatchObject({ kind: 'error', busy: true });
		expect(urls.length).toBeLessThanOrEqual(5);
	});
	it('another 503 is an error at once (no waiting)', async () => {
		const { r, waits } = await read([
			{ status: 503, body: { status: 'error', code: 'internal', message: 'x' } }
		]);
		expect(r).toMatchObject({ kind: 'error', busy: false, tooLarge: false });
		expect(waits).toEqual([]);
	});
	it('busy while retrying a too-large page smaller: waits, then carries on smaller', async () => {
		const tooLarge: Reply = {
			status: 413,
			body: { status: 'error', code: 'reply_too_large', message: 'x' }
		};
		const { r, urls } = await read([tooLarge, busy('2'), ok(10)], 10_000);
		expect(r).toMatchObject({ kind: 'ok', limit: 1_000 });
		expect(urls.map((u) => new URL(u).searchParams.get('limit'))).toEqual([
			'10000',
			'1000',
			'1000'
		]);
	});
});
