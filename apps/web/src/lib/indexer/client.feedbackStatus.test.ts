// @vitest-environment jsdom
/**
 * getFeedbackStatus: what the indexer did with one review
 * (GET /v1/feedback/status), asked with exactly the review's names — and,
 * for a review that cites no order, without an order_permlink at all (the
 * indexer reads an absent one as "no order").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getFeedbackStatus } from './client';

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

describe('getFeedbackStatus', () => {
	it('names the reviewer, the subject and the cited order', async () => {
		stub(200, { state: 'refused', reason: 'order_permlink_not_found_or_unverified' });
		const r = await getFeedbackStatus({
			reviewer: 'dave',
			subject: 'erin',
			order_permlink: 'order-q4k8wz2m7rtd'
		});
		expect(r.ok && r.data).toEqual({
			state: 'refused',
			reason: 'order_permlink_not_found_or_unverified'
		});
		const u = new URL(calls[0]!);
		expect(u.pathname).toBe('/v1/feedback/status');
		expect(Object.fromEntries(u.searchParams)).toEqual({
			reviewer: 'dave',
			subject: 'erin',
			order_permlink: 'order-q4k8wz2m7rtd'
		});
	});

	it('leaves order_permlink out for a review that cites no order', async () => {
		stub(200, { state: 'unknown' });
		await getFeedbackStatus({ reviewer: 'alice', subject: 'bob' });
		expect(new URL(calls[0]!).searchParams.has('order_permlink')).toBe(false);
	});

	it('a failed read is an error, not a state', async () => {
		stub(400, { code: 'bad_request', message: 'invalid reviewer' });
		const r = await getFeedbackStatus({ reviewer: 'X', subject: 'bob' });
		expect(r.ok).toBe(false);
	});
});
