/**
 * /v1/stats counts a trade once, and /v1/activity/volume an order (and its
 * volume) once, on real Postgres.
 *
 * A trade is reviewed by both sides, each review citing the same order. The
 * count took distinct (subject, order) pairs, so a trade reviewed both ways
 * counted twice (its own comment said once). One order traded with two
 * different people is still two trades.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { statsRoute } from '../../src/api/stats';
import { activityRoute } from '../../src/api/activity';

describe.skipIf(!INTEGRATION_ENABLED)('/v1/stats trade count', () => {
	let fx: IntegrationFixture;

	const review = (reviewer: string, subject: string, permlink: string, trx: string) =>
		fx.db.query(
			`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
			 VALUES ($1, $2, 5, $3, NOW(), $4)`,
			[reviewer, subject, permlink, trx]
		);
	const trades = async (): Promise<{ completed_total: number; completed_30d: number }> => {
		const app = statsRoute(fx.db, { disabledAssets: [] } as never);
		const body = (await (await app.request('/')).json()) as {
			trades: { completed_total: number; completed_30d: number };
		};
		return body.trades;
	};

	beforeAll(async () => {
		fx = await setupWithMigrations();
		// alice's order, traded with bob: both review each other.
		await review('bob', 'alice', 'order-a1', 't1');
		await review('alice', 'bob', 'order-a1', 't2');
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	it('a trade reviewed by both sides counts once', async () => {
		expect(await trades()).toEqual({ completed_total: 1, completed_30d: 1 });
	});

	it('the same order traded with another person is another trade', async () => {
		await review('carol', 'alice', 'order-a1', 't3');
		expect(await trades()).toEqual({ completed_total: 2, completed_30d: 2 });
	});
});

describe.skipIf(!INTEGRATION_ENABLED)('/v1/activity/volume', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, amount_min, amount_max, price_model,
			   payment_methods, status, created_at, updated_at, fee_status)
			 VALUES ('alice','order-a1','sell','BTC','USD',100,300,'{"kind":"spread","percent":0}'::jsonb,
			   ARRAY['cash'], 'live', NOW(), NOW(), 'verified')`
		);
		for (const [reviewer, trx] of [
			['bob', 't1'],
			['carol', 't2']
		]) {
			await fx.db.query(
				`INSERT INTO feedback (reviewer, subject, rating, order_permlink, created_at, source_trx_id)
				 VALUES ($1, 'alice', 5, 'order-a1', NOW() - interval '1 day', $2)`,
				[reviewer, trx]
			);
		}
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	it('one order reviewed by two buyers: one trade, one midpoint of volume', async () => {
		const body = (await (await activityRoute(fx.db).request('/volume')).json()) as {
			window_30d: Array<{ asset: string; trade_count: number; estimated_volume: number }>;
		};
		expect(body.window_30d).toEqual([{ asset: 'BTC', trade_count: 1, estimated_volume: 200 }]);
	});
});
