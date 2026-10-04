/**
 * Push that is off ON PURPOSE: telling the browser why, and keeping the queue
 * bounded while nothing sends from it.
 *
 * v1.18.0. A hidden-only relay turns Web Push off (F32), because every browser
 * push service is a clearnet host. On every existing tor-only node that has two
 * consequences nobody had followed through:
 *
 *   - users who subscribed while push worked keep their subscriptions, so the
 *     indexer keeps queueing a push for each of their notifications, and with
 *     no sender running nothing retires or prunes a row: `push_pending` grows
 *     for as long as the node runs;
 *   - the browser is told "the operator has not enabled push yet", which is
 *     false and invites the user to ask for something that will not come.
 *
 * The SQL itself is proven against a real Postgres in the indexer's
 * integration suite (push-queue-janitor.test.ts). These pin the relay's side:
 * what the endpoints answer, and that the janitor runs.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { PushEndpoints } from '../src/api/push.ts';
import type { Limiter } from '../src/middleware/ratelimit.ts';
import type { PushSubscriptionStore } from '../src/policy/pushSubscriptions.ts';
import type { BlurtClient } from '../src/blurt/client.ts';
import {
	PushQueueJanitor,
	PUSH_TOMBSTONE_RETENTION_SECONDS
} from '../src/policy/pushQueueJanitor.ts';

const allow = { allow: () => true } as unknown as Limiter;
const app = (reason: 'hidden_only' | null): Hono => {
	const a = new Hono();
	new PushEndpoints(
		false,
		undefined,
		allow,
		allow,
		{} as PushSubscriptionStore,
		{} as BlurtClient,
		true,
		true,
		[],
		reason
	).register(a);
	return a;
};
const post = () =>
	({ method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }) as const;

describe('what a relay with push off answers', () => {
	it.each([
		['GET', '/v1/push/vapid-public-key'],
		['POST', '/v1/push/subscribe']
	])(
		'hidden-only: %s %s says push is off BECAUSE the relay is hidden-only',
		async (method, path) => {
			const res = await app('hidden_only').request(path, method === 'GET' ? {} : post());
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ status: 'push_disabled', reason: 'hidden_only' });
		}
	);

	/**
	 * v1.18.0 review (W4). Unsubscribe used to answer 503 as well — so on every
	 * tor-only node, which turns push off on upgrade, a user could not remove the
	 * stored link between their account and their device's push endpoint, no
	 * sender ever ran to prune it, and it would start delivering again, with no
	 * word to anyone, if push were ever turned back on. Removing a row contacts
	 * no push service; it is the user's to ask for.
	 */
	it('hidden-only: unsubscribe still DELETES the subscription', async () => {
		const deleted: [string, string][] = [];
		const a = new Hono();
		new PushEndpoints(
			false,
			undefined,
			allow,
			allow,
			{
				delete: async (account: string, endpoint: string) => {
					deleted.push([account, endpoint]);
				}
			} as unknown as PushSubscriptionStore,
			{} as BlurtClient,
			true,
			false,
			[],
			'hidden_only'
		).register(a);
		const res = await a.request('/v1/push/unsubscribe', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ account: 'alice', endpoint: 'https://push.example/alice' })
		});
		expect(res.status).toBe(200);
		expect(deleted, 'the subscription row was left in place').toEqual([
			['alice', 'https://push.example/alice']
		]);
	});

	it('off for the old reasons: exactly the old body, so older browsers read it as before', async () => {
		const res = await app(null).request('/v1/push/vapid-public-key');
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ status: 'push_disabled' });
	});
});

describe('the janitor that runs when the sender does not', () => {
	afterEach(() => vi.useRealTimers());

	/** A database that records what it was asked and answers a row count. */
	const recordingDb = () => {
		const calls: { text: string; params: unknown[] }[] = [];
		return {
			calls,
			db: {
				query: async (text: string, params: unknown[] = []) => {
					calls.push({ text, params });
					return { rowCount: 2 };
				}
			}
		};
	};

	it('retires by the relay’s own max age, then prunes by the tombstone retention', async () => {
		const { db, calls } = recordingDb();
		const r = await new PushQueueJanitor(db, 1234).runOnce();
		expect(r).toEqual({ retired: 2, pruned: 2 });
		expect(calls).toHaveLength(2);
		// Retire first, so a row it retires is a tombstone before any prune runs.
		expect(calls[0]!.text).toMatch(/UPDATE push_pending\s+SET sent_at = NOW\(\)/);
		expect(calls[0]!.params).toEqual([1234]);
		expect(calls[1]!.text).toMatch(/DELETE FROM push_pending/);
		expect(calls[1]!.params).toEqual([PUSH_TOMBSTONE_RETENTION_SECONDS]);
	});

	it('runs at once on start — a relay restarting into push-off may already hold a backlog', async () => {
		const { db, calls } = recordingDb();
		const j = new PushQueueJanitor(db, 3600, undefined, undefined, 60_000);
		j.start();
		await vi.waitFor(() => expect(calls.length).toBe(2));
		j.stop();
	});

	it('and again every interval, until stopped', async () => {
		vi.useFakeTimers();
		const { db, calls } = recordingDb();
		const j = new PushQueueJanitor(db, 3600, undefined, undefined, 1_000);
		j.start();
		await vi.advanceTimersByTimeAsync(3_050);
		expect(calls.length).toBe(8); // at start, then three intervals, two queries each
		j.stop();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls.length).toBe(8);
	});

	it('a database error is reported, not thrown into the process', async () => {
		const errors: unknown[] = [];
		const j = new PushQueueJanitor(
			{
				query: async () => {
					throw new Error('connection refused');
				}
			},
			3600,
			undefined,
			(e) => errors.push(e),
			60_000
		);
		j.start();
		await vi.waitFor(() => expect(errors).toHaveLength(1));
		j.stop();
	});
});
