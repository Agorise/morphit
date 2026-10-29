/**
 * A trade counts for BOTH people, on real Postgres (v1.21.17).
 *
 * The maintainer filled a buyer's order (sent the BLURT; the buyer marked the
 * order complete naming him). His profile's "Trade history" was empty — it
 * listed only completed orders HE had posted — and "Last trade" read "3mo ago",
 * the day he last POSTED an order. The buyer's read "6d ago", the day the
 * buyer posted the order, not the day they traded.
 *
 *   - GET /v1/accounts/:account/trades lists completed orders on either side
 *     (posted by the account, or naming it as the counterparty), newest first,
 *     and only completed ones;
 *   - the feedback summary's last_traded_at is the newest completed trade on
 *     either side or review received — never an order merely posted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import {
	accountTradesRoute,
	orderByPermlinkRoute,
	ordersByAccountRoute
} from '../../src/api/orders';
import { feedbackByAccountRoute } from '../../src/api/feedback';

const OPERATOR = 'operator';

describe.skipIf(!INTEGRATION_ENABLED)('trades on both sides, and the last trade', () => {
	let fx: IntegrationFixture;
	let app: Hono;

	const order = (
		account: string,
		permlink: string,
		status: string,
		created: string,
		updated: string,
		counterparty: string | null = null,
		// when it was completed; by default its last change
		completed: string = updated
	) =>
		fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, created_at, updated_at, fee_status, completed_counterparty, completed_at)
			 VALUES ($1, $2, 'buy', 'BLURT', 'BRL', '{"kind":"spread","spread":0}'::jsonb, ARRAY['pay_xmr','pay_btc'],
			         $3, $4, $5, 'verified', $6, CASE WHEN $3 = 'completed' THEN $7::timestamptz END)`,
			[account, permlink, status, created, updated, counterparty, completed]
		);

	beforeAll(async () => {
		fx = await setupWithMigrations();
		// The buyer's order, posted on the 19th, completed on the 26th naming the seller.
		await order(
			'bob',
			'order-bob1',
			'completed',
			'2026-10-19T23:33:57Z',
			'2026-10-26T18:08:45Z',
			'alice'
		);
		// The seller's own orders: posted in July, never traded (live, past expiry).
		await order(
			'alice',
			'order-kegpcdnqr7tu',
			'live',
			'2026-07-28T18:47:30Z',
			'2026-07-28T18:47:30Z'
		);
		// An older completed order the seller posted himself.
		await order(
			'alice',
			'order-old',
			'completed',
			'2026-05-01T00:00:00Z',
			'2026-05-02T00:00:00Z',
			'carol'
		);
		// Someone else's trade that names neither.
		await order(
			'dave',
			'order-x',
			'completed',
			'2026-10-20T00:00:00Z',
			'2026-10-21T00:00:00Z',
			'erin'
		);
		// A blocked owner's completed trade with the seller: hidden here.
		await order(
			'mallory',
			'order-m',
			'completed',
			'2026-10-01T00:00:00Z',
			'2026-10-02T00:00:00Z',
			'alice'
		);
		await fx.db.query(
			`INSERT INTO operator_blocks (operator, blocked, state, since_block_num, since_trx_id,
			                             last_action_block_num, created_at, updated_at)
			 VALUES ($1, 'mallory', 'blocked', 1, 't', 1, NOW(), NOW())`,
			[OPERATOR]
		);

		app = new Hono();
		const orders = new Hono();
		orders.route('/', ordersByAccountRoute(fx.db, OPERATOR));
		orders.route('/', orderByPermlinkRoute(fx.db, OPERATOR));
		app.route('/v1/orders', orders);
		const accounts = new Hono();
		accounts.route('/', feedbackByAccountRoute(fx.db));
		accounts.route('/', accountTradesRoute(fx.db, OPERATOR));
		app.route('/v1/accounts', accounts);
	}, 60_000);

	afterAll(async () => {
		await fx?.teardown();
	});

	const trades = async (account: string): Promise<string[]> => {
		const r = await app.request(`/v1/accounts/${account}/trades`);
		expect(r.status).toBe(200);
		const body = (await r.json()) as { items: { account: string; permlink: string }[] };
		return body.items.map((o) => `${o.account}/${o.permlink}`);
	};
	const lastTrade = async (account: string): Promise<string | null> => {
		const r = await app.request(`/v1/accounts/${account}/feedback`);
		expect(r.status).toBe(200);
		return ((await r.json()) as { summary: { last_traded_at: string | null } }).summary
			.last_traded_at;
	};

	it('the seller sees the trade he filled on the buyer’s order, newest first; never a live order', async () => {
		expect(await trades('alice')).toEqual(['bob/order-bob1', 'alice/order-old']);
	});
	it('the buyer sees it too', async () => {
		expect(await trades('bob')).toEqual(['bob/order-bob1']);
	});
	it('an account with no trade gets an empty list; a bad name is refused', async () => {
		expect(await trades('nobody')).toEqual([]);
		expect((await app.request('/v1/accounts/BAD!/trades')).status).toBe(400);
		expect((await app.request('/v1/accounts/alice/trades?cursor=x')).status).toBe(400);
	});
	it('an order whose permlink is "trades" is still that order', async () => {
		await order('zed', 'trades', 'completed', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
		const r = await app.request('/v1/orders/zed/trades');
		expect(r.status).toBe(200);
		expect(((await r.json()) as { item: { permlink: string } }).item.permlink).toBe('trades');
	});
	it('an account blocked here has no trades listed, as on every other read', async () => {
		// Not even on an unblocked owner's order that names it.
		await order(
			'dave',
			'order-names-mallory',
			'completed',
			'2026-10-03T00:00:00Z',
			'2026-10-04T00:00:00Z',
			'mallory'
		);
		expect(await trades('mallory')).toEqual([]);
		expect(await trades('dave')).toContain('dave/order-names-mallory');
	});
	it('last trade is the completion, on either side — not the day an order was posted', async () => {
		expect(await lastTrade('alice')).toBe('2026-10-26T18:08:45.000Z');
		expect(await lastTrade('bob')).toBe('2026-10-26T18:08:45.000Z');
		// Only posted orders, no trade: no last trade.
		await order('fresh', 'order-f', 'live', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z');
		expect(await lastTrade('fresh')).toBeNull();
	});
	it('the trade time is the completion: a later change to the order (a fee re-check, the partner named later) moves neither the list nor the last trade', async () => {
		// Completed on the 10th, changed again on the 27th.
		await order(
			'gina',
			'order-g-early',
			'completed',
			'2026-10-01T00:00:00Z',
			'2026-10-27T11:00:00Z',
			'hank',
			'2026-10-10T00:00:00Z'
		);
		await order(
			'gina',
			'order-g-late',
			'completed',
			'2026-10-01T00:00:00Z',
			'2026-10-15T00:00:00Z',
			'hank'
		);
		expect(await trades('hank')).toEqual(['gina/order-g-late', 'gina/order-g-early']);
		expect(await lastTrade('hank')).toBe('2026-10-15T00:00:00.000Z');
		const r = await app.request('/v1/accounts/hank/trades');
		const items = ((await r.json()) as { items: { permlink: string; completed_at?: string }[] })
			.items;
		expect(items.find((o) => o.permlink === 'order-g-early')?.completed_at).toBe(
			'2026-10-10T00:00:00.000Z'
		);
		// A live order carries no completion time.
		const live = await app.request('/v1/orders/alice/order-kegpcdnqr7tu');
		expect(((await live.json()) as { item: Record<string, unknown> }).item).not.toHaveProperty(
			'completed_at'
		);
	});
	it('a review received counts as trade activity when it is newer', async () => {
		await fx.db.query(
			`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
			 VALUES ('carol', 'alice', 5, 'order-old', '2026-10-27T00:00:00Z', $1)`,
			['f'.repeat(40)]
		);
		expect(await lastTrade('alice')).toBe('2026-10-27T00:00:00.000Z');
	});
});
