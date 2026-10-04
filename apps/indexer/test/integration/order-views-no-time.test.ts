/**
 * The public order view counter keeps and serves the count only.
 *
 * GET /v1/orders/:account/:permlink/views is unauthenticated, so any time it
 * served — or the table kept — would let anyone line views up against outside
 * events. This runs the real handlers against Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { incrementOrderView, readOrderViews } from '../../src/api/orderViewsLogic';

describe.skipIf(!INTEGRATION_ENABLED)('order view counter keeps no time', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, amount_min, amount_max,
			                     price_model, payment_methods, status, created_at, updated_at)
			 VALUES ('alice', 'o1', 'sell', 'BTC', 'USD', 1, 2, '{"kind":"spread","percent":0}', '{cash}',
			         'live', now(), now())`
		);
	});

	afterAll(async () => {
		await fx?.teardown();
	});

	it('serves only the count, and stores no view time', async () => {
		for (let i = 0; i < 3; i++) {
			const r = await incrementOrderView(fx.db, 'alice', 'o1');
			expect(r.status).toBe(200);
		}
		const read = await readOrderViews(fx.db, 'alice', 'o1');
		expect(read.body).toEqual({ count: 3 });
		const unseen = await readOrderViews(fx.db, 'alice', 'never-viewed');
		expect(unseen.body).toEqual({ count: 0 });

		const rows = await fx.db.query(`SELECT permlink, count, updated_at FROM order_views`);
		expect(rows.rows).toEqual([{ permlink: 'alice/o1', count: '3', updated_at: null }]);
	});
});
