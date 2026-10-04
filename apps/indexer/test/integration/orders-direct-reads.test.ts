/**
 * A page asks the indexer for the one order, the fee tier, or a batch of
 * counts it needs — not for the newest page of orders, on real
 * Postgres and wired exactly as main.ts mounts /v1/orders.
 *
 * Pages and the MCP read the newest 100 orders and searched them: an account
 * with more had live orders reported "not found" and was quoted a lower Sybil
 * tier than the indexer then charged (the fee was lost). /my/orders fetched
 * view counts and counterparties one order at a time, which alone used up a
 * shared-address visitor's rate limit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { orderByPermlinkRoute, ordersByAccountRoute } from '../../src/api/orders';
import { orderViewsRoute } from '../../src/api/orderViews';
import { orderCounterpartiesRoute } from '../../src/api/orderCounterparties';

const OPERATOR = 'operator';

describe.skipIf(!INTEGRATION_ENABLED)('direct order reads', () => {
	let fx: IntegrationFixture;
	let app: Hono;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		// 110 orders that count toward the tier: 105 live from two days ago and
		// 5 cancelled within the last day. Plus 40 old cancelled ones that don't.
		await fx.db.query(`
			INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                    status, created_at, updated_at, fee_status)
			SELECT 'alice', 'live-' || g, 'sell', 'BTC', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
			       'live', NOW() - interval '2 days', NOW() - interval '2 days' + (g || ' seconds')::interval, 'verified'
			  FROM generate_series(1, 105) g`);
		await fx.db.query(`
			INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                    status, created_at, updated_at, fee_status)
			SELECT 'alice', 'recent-' || g, 'sell', 'BTC', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
			       'cancelled', NOW() - interval '1 hour', NOW(), 'verified'
			  FROM generate_series(1, 5) g`);
		await fx.db.query(`
			INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                    status, created_at, updated_at, fee_status)
			SELECT 'alice', 'gone-' || g, 'sell', 'BTC', 'USD', '{"kind":"fixed","price":1}'::jsonb, ARRAY['cash'],
			       'cancelled', NOW() - interval '9 days', NOW() - interval '1 minute', 'verified'
			  FROM generate_series(1, 40) g`);
		await fx.db.query(
			`INSERT INTO order_views (permlink, count) VALUES ('alice/live-1', 7), ('alice/live-2', 3)`
		);
		const msg = (s: string, r: string, p: string | null, minAgo: number, i: number) =>
			fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, source_trx_id, created_at, order_permlink)
				 VALUES ($1, $2, 'x', '{}'::jsonb, $3, NOW() - ($4 || ' minutes')::interval, $5)`,
				[s, r, `t${i}`.padEnd(40, '0'), minAgo, p]
			);
		let i = 0;
		// bob: a conversation about live-1 that clears the review gate (2 each
		// way over 20 minutes); carol: one message about live-2.
		for (const m of [60, 50]) await msg('bob', 'alice', 'live-1', m, i++);
		for (const m of [55, 40]) await msg('alice', 'bob', null, m, i++);
		await msg('carol', 'alice', 'live-2', 5, i++);

		app = new Hono();
		const orders = new Hono();
		orders.route('/', ordersByAccountRoute(fx.db, OPERATOR));
		orders.route('/', orderViewsRoute(fx.db));
		orders.route('/', orderCounterpartiesRoute(fx.db));
		orders.route('/', orderByPermlinkRoute(fx.db, OPERATOR));
		app.route('/v1/orders', orders);
	}, 60_000);

	afterAll(async () => {
		await fx?.teardown();
	});

	const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
		const r = await app.request(path);
		return { status: r.status, body: (await r.json()) as Record<string, unknown> };
	};

	it('the Sybil tier counts every order that counts, not the newest page', async () => {
		const r = await get('/v1/orders/alice/sybil_tier');
		expect(r.status).toBe(200);
		expect(r.body.count).toBe(110);
		// ?at= applies the rule at that time: two days on, the recent cancelled
		// ones have left the 24-hour window and only the live ones count.
		const later = await get(
			`/v1/orders/alice/sybil_tier?at=${new Date(Date.now() + 2 * 86_400_000).toISOString()}`
		);
		expect(later.body.count).toBe(105);
		expect((await get('/v1/orders/alice/sybil_tier?at=yesterday')).status).toBe(400);
	});

	it('a live order past the newest 100 is found by its permlink', async () => {
		const page = await get('/v1/orders/alice?limit=100');
		const listed = (page.body.items as { permlink: string }[]).map((o) => o.permlink);
		expect(listed).not.toContain('live-1');
		const one = await get('/v1/orders/alice/live-1');
		expect(one.status).toBe(200);
		expect((one.body.item as { permlink: string; status: string }).status).toBe('live');
		expect((await get('/v1/orders/alice/no-such-order')).status).toBe(404);
	});

	it('an owner this instance blocked is hidden here too', async () => {
		await fx.db.query(
			`INSERT INTO operator_blocks (operator, blocked, state, since_block_num, since_trx_id,
			                             last_action_block_num, created_at, updated_at)
			 VALUES ($1, 'alice', 'blocked', 1, 't', 1, NOW(), NOW())`,
			[OPERATOR]
		);
		try {
			expect((await get('/v1/orders/alice/live-1')).status).toBe(404);
		} finally {
			await fx.db.query(`DELETE FROM operator_blocks WHERE blocked = 'alice'`);
		}
	});

	it('view counts for many orders in one request', async () => {
		const r = await get('/v1/orders/alice/view_counts?permlinks=live-1,live-2,live-3');
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ counts: { 'live-1': 7, 'live-2': 3, 'live-3': 0 } });
	});

	it('counterparty lists for many orders in one request, each as the single read gives it', async () => {
		const batch = await get('/v1/orders/alice/counterparty_lists?permlinks=live-1,live-2,live-3');
		expect(batch.status).toBe(200);
		const lists = batch.body.lists as Record<string, unknown>;
		for (const p of ['live-1', 'live-2', 'live-3']) {
			const single = await get(`/v1/orders/alice/${p}/counterparties`);
			expect(lists[p]).toEqual(single.body.items);
		}
		expect(lists['live-1']).toEqual([{ peer: 'bob', reviewable: true }]);
		expect(lists['live-2']).toEqual([{ peer: 'carol', reviewable: false }]);
	});
});
