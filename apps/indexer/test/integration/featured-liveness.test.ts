/**
 * A featured slot goes to the best bid whose order can be shown, on
 * real Postgres.
 *
 * The strip took the top 3 active bids first and only then dropped those whose
 * order was cancelled, expired or blocked — so dead bids blanked paid slots
 * that live bids ranked just below should have filled, /featured/bids told
 * those live bidders they were not visible, and an order with no expiry
 * (expires_at NULL) was never featured at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { featuredRoute } from '../../src/api/featuredOrderbook';
import { featuredBidsRoute } from '../../src/api/featuredBids';

const OPERATOR = 'operator';

describe.skipIf(!INTEGRATION_ENABLED)('featured slots and order liveness', () => {
	let fx: IntegrationFixture;

	const order = (account: string, status: string, expires: string) =>
		fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, fee_status, fee_method, created_at, updated_at, expires_at)
			 VALUES ($1, 'o', 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], $2, 'verified', 'blurt',
			         NOW(), NOW(), ${expires})`,
			[account, status]
		);
	const bid = (bidder: string, perHour: number) =>
		fx.db.query(
			`INSERT INTO featured_slot_bids (bidder, order_permlink, hours_requested, blurt_paid, blurt_per_hour,
			                                 effective_at, expires_at, trx_id, block_num, block_time_at, cancelled)
			 VALUES ($1, 'o', 24, $2, $2, NOW() - interval '1 hour', NOW() + interval '23 hours', $3, 1,
			         NOW() - interval '1 hour', FALSE)`,
			[bidder, perHour, `t-${bidder}`.padEnd(40, '0')]
		);

	beforeAll(async () => {
		fx = await setupWithMigrations();
		await order('cancelled', 'cancelled', `NOW() + interval '2 days'`);
		await order('expired', 'live', `NOW() - interval '1 hour'`);
		await order('blocked', 'live', `NOW() + interval '2 days'`);
		await order('noexpiry', 'live', 'NULL');
		await order('fourth', 'live', `NOW() + interval '2 days'`);
		await order('fifth', 'live', `NOW() + interval '2 days'`);
		await order('sixth', 'live', `NOW() + interval '2 days'`);
		for (const [b, p] of [
			['cancelled', 100],
			['expired', 90],
			['blocked', 80],
			['noexpiry', 70],
			['fourth', 60],
			['fifth', 50],
			['sixth', 40]
		] as const)
			await bid(b, p);
		await fx.db.query(
			`INSERT INTO operator_blocks (operator, blocked, state, since_block_num, since_trx_id,
			                             last_action_block_num, created_at, updated_at)
			 VALUES ($1, 'blocked', 'blocked', 1, 't', 1, NOW(), NOW())`,
			[OPERATOR]
		);
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	it('the three slots go to the three best bids on showable orders', async () => {
		const res = await featuredRoute(fx.db, OPERATOR).request('/');
		const body = (await res.json()) as {
			featured: { order: { account: string; expires_at: string | null } }[];
		};
		expect(body.featured.map((f) => f.order.account)).toEqual(['noexpiry', 'fourth', 'fifth']);
		expect(body.featured[0]!.order.expires_at).toBeNull();
	});

	it('/featured/bids agrees with the strip', async () => {
		const visible = async (account: string): Promise<boolean> => {
			const res = await featuredBidsRoute(fx.db, OPERATOR).request(`/?account=${account}`);
			return ((await res.json()) as { bids: { is_visible: boolean }[] }).bids[0]!.is_visible;
		};
		expect(await visible('fifth')).toBe(true);
		expect(await visible('cancelled')).toBe(false);
		expect(await visible('blocked')).toBe(false);
		expect(await visible('sixth')).toBe(false);
	});
});
