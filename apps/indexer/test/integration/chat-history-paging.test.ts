/**
 * /v1/chat/:a/:b pages back to the first message, on real Postgres, for the
 * whole pair and for one thread (`order=`).
 *
 * v1.21.6: the web app reads a conversation's whole history page by page
 * (scrolling back, and the PDF export). Every message must come back exactly
 * once, including several in one block (same created_at), and a thread's pages
 * must hold that thread's messages only — `order=` with no value is the thread
 * that cites no order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { chatRoute } from '../../src/api/chat';

describe.skipIf(!INTEGRATION_ENABLED)('/v1/chat history paging', () => {
	let fx: IntegrationFixture;
	/** id → thread ('' = no order), for every message alice and bob exchanged. */
	const pair = new Map<number, string>();

	beforeAll(async () => {
		fx = await setupWithMigrations();
		// 230 messages between alice and bob over three threads, three to a
		// block (same second), the oldest about order-a, then order-b, the
		// order-less thread throughout; plus carol's, which never show.
		const threads = ['order-a', 'order-b', ''];
		for (let i = 0; i < 230; i++) {
			const thread = i < 120 ? (i % 4 === 0 ? '' : 'order-a') : threads[1 + (i % 2)]!;
			const at = new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 3) * 1000);
			const r = await fx.db.query<{ id: string }>(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
				 VALUES ($1, $2, 'c', '{}'::jsonb, $3, $4, $5) RETURNING id::text`,
				[
					i % 2 ? 'alice' : 'bob',
					i % 2 ? 'bob' : 'alice',
					at,
					`t${i}`,
					thread === '' ? null : thread
				]
			);
			pair.set(parseInt(r.rows[0]!.id, 10), thread);
		}
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
			 VALUES ('carol', 'alice', 'c', '{}'::jsonb, NOW(), 'tc', 'order-a')`
		);
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	type Page = {
		items: { id: number; order_permlink: string | null }[];
		next_cursor: string | null;
	};
	async function walk(query: string): Promise<Page['items']> {
		const app = chatRoute(fx.db);
		const seen: Page['items'] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 100; i++) {
			const res = await app.request(
				`/bob/alice?limit=7${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
			);
			expect(res.status).toBe(200);
			const page = (await res.json()) as Page;
			seen.push(...page.items);
			if (page.next_cursor === null) return seen;
			cursor = page.next_cursor;
		}
		throw new Error('paging did not end');
	}
	const ids = (items: Page['items']) => items.map((m) => m.id).sort((x, y) => x - y);
	const idsOf = (thread: string | null) =>
		[...pair].filter(([, t]) => thread === null || t === thread).map(([id]) => id);

	it('the whole pair, every message once', async () => {
		const seen = await walk('');
		expect(ids(seen)).toEqual(idsOf(null).sort((x, y) => x - y));
		expect(seen.length).toBe(230);
	});

	it('one order thread, its messages only', async () => {
		for (const order of ['order-a', 'order-b']) {
			const seen = await walk(`&order=${order}`);
			expect(ids(seen), order).toEqual(idsOf(order).sort((x, y) => x - y));
			expect(new Set(seen.map((m) => m.order_permlink))).toEqual(new Set([order]));
		}
	});

	it('order= with no value is the thread that cites no order', async () => {
		const seen = await walk('&order=');
		expect(ids(seen)).toEqual(idsOf('').sort((x, y) => x - y));
		expect(new Set(seen.map((m) => m.order_permlink))).toEqual(new Set([null]));
	});

	it('refuses an order that is not a permlink', async () => {
		const app = chatRoute(fx.db);
		for (const bad of ['Order-A', 'a_b', 'a--b', '-a', 'x'.repeat(257)]) {
			const res = await app.request(`/bob/alice?order=${encodeURIComponent(bad)}`);
			expect(res.status, bad).toBe(400);
		}
	});

	it('a page far back reads only that page from the index, not every newer message', async () => {
		// 200 000 messages between mallory and mallet, one a second.
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink)
			 SELECT CASE WHEN g % 2 = 0 THEN 'mallory' ELSE 'mallet' END,
			        CASE WHEN g % 2 = 0 THEN 'mallet' ELSE 'mallory' END,
			        'c', '{}'::jsonb, TIMESTAMPTZ '2026-02-01 00:00:00+00' + g * INTERVAL '1 second', 'deep' || g, NULL
			   FROM generate_series(1, 200000) g`
		);
		await fx.db.query('ANALYZE chat_messages');
		// The route's own query for a page near the first message.
		const seen: { sql: string; params: unknown[] }[] = [];
		const spy = {
			query: (sql: string, params: unknown[]) => {
				seen.push({ sql, params });
				return fx.db.query(sql, params);
			}
		} as unknown as typeof fx.db;
		const cursor = Buffer.from(
			JSON.stringify({ c: new Date(Date.UTC(2026, 1, 1) + 300_000).toISOString(), i: 0 })
		).toString('base64url');
		const res = await chatRoute(spy).request(`/mallory/mallet?limit=100&cursor=${cursor}`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(100);
		const q = seen.at(-1)!;
		const plan = await fx.db.query<{ 'QUERY PLAN': unknown }>(
			`EXPLAIN (ANALYZE, FORMAT JSON) ${q.sql}`,
			q.params
		);
		let removed = 0;
		let read = 0;
		const walkPlan = (n: Record<string, unknown>) => {
			removed += Number(n['Rows Removed by Filter'] ?? 0);
			if (String(n['Node Type']).includes('Scan')) read += Number(n['Actual Rows'] ?? 0);
			for (const c of (n['Plans'] as Record<string, unknown>[] | undefined) ?? []) walkPlan(c);
		};
		walkPlan((plan.rows[0]!['QUERY PLAN'] as { Plan: Record<string, unknown> }[])[0]!.Plan);
		expect(removed + read).toBeLessThan(1_000);
	});
});
