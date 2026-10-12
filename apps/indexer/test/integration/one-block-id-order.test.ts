/**
 * Many rows in one block (one created_at) page and catch up completely, on
 * real Postgres.
 *
 * v1.21.6: these queries SELECT `id::text` and ORDER BY a bare `id` — which in
 * ORDER BY means the SELECT's text column, so a block's rows sorted as text
 * ("100" before "99") while the cursor (`id > $n`) compares numbers. A page
 * boundary inside a block then skipped rows: the chat history, both review
 * lists, and the chat stream's catch-up read after a reconnect.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { chatRoute } from '../../src/api/chat';
import { fetchSinceId } from '../../src/api/chatStream';
import { feedbackByAccountRoute } from '../../src/api/feedback';

describe.skipIf(!INTEGRATION_ENABLED)('one block, ids across 9→10 and 99→100', () => {
	let fx: IntegrationFixture;
	const chatIds: number[] = [];
	const AT = '2026-03-01T00:00:00Z';

	beforeAll(async () => {
		fx = await setupWithMigrations();
		for (let i = 0; i < 120; i++) {
			const r = await fx.db.query<{ id: string }>(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ($1, $2, 'c', '{}'::jsonb, $3, $4) RETURNING id::text`,
				[i % 2 ? 'dave' : 'erin', i % 2 ? 'erin' : 'dave', AT, `c${i}`]
			);
			chatIds.push(parseInt(r.rows[0]!.id, 10));
			await fx.db.query(
				`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
				 VALUES ($1, 'frank', 5, NULL, $2, $3)`,
				[`r${i}`, AT, `f${i}`]
			);
			await fx.db.query(
				`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
				 VALUES ('gina', $1, 5, NULL, $2, $3)`,
				[`s${i}`, AT, `g${i}`]
			);
		}
		// The rows must really cross 9→10 and 99→100 for this to test anything.
		expect(Math.min(...chatIds)).toBeLessThan(10);
		expect(Math.max(...chatIds)).toBeGreaterThanOrEqual(100);
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	async function walk<T>(
		get: (cursor: string | null) => Response | Promise<Response>,
		pick: (x: T) => string
	) {
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 100; i++) {
			const res = await get(cursor);
			expect(res.status).toBe(200);
			const page = (await res.json()) as { items: T[]; next_cursor: string | null };
			seen.push(...page.items.map(pick));
			if (page.next_cursor === null) return seen;
			cursor = page.next_cursor;
		}
		throw new Error('paging did not end');
	}
	const q = (c: string | null) => (c ? `&cursor=${encodeURIComponent(c)}` : '');

	it('chat history: every message once, in the order recorded', async () => {
		const app = chatRoute(fx.db);
		const seen = await walk<{ id: number }>(
			(c) => app.request(`/dave/erin?limit=7${q(c)}`),
			(m) => String(m.id)
		);
		expect(seen).toEqual(chatIds.map(String));
	});

	it('reviews received and reviews given: every review once', async () => {
		const app = feedbackByAccountRoute(fx.db);
		const got = await walk<{ source_trx_id: string }>(
			(c) => app.request(`/frank/feedback?limit=7${q(c)}`),
			(f) => f.source_trx_id
		);
		expect(got.sort()).toEqual(Array.from({ length: 120 }, (_, i) => `f${i}`).sort());
		const given = await walk<{ source_trx_id: string }>(
			(c) => app.request(`/gina/feedback-given?limit=7${q(c)}`),
			(f) => f.source_trx_id
		);
		expect(given.sort()).toEqual(Array.from({ length: 120 }, (_, i) => `g${i}`).sort());
	});

	it('chat stream catch-up after a reconnect: the next rows after the last one seen, in id order', async () => {
		const since = chatIds[4]!;
		const rows = await fetchSinceId(fx.db, { lo: 'dave', hi: 'erin' }, since);
		expect(rows.map((r) => Number(r.id))).toEqual(chatIds.slice(5));
	});
});
