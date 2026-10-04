/**
 * Morphit indexer — /v1/orders/:account/:permlink/view{,s} and
 * /v1/orders/:account/view_counts Hono routes.
 *
 * Pure handler logic lives in orderViewsLogic.ts, whose header
 * describes what the counter keeps and who can read it.
 */

import { Hono } from 'hono';
import type { Database } from '$db/pool';
import { incrementOrderView, readOrderViewCounts, readOrderViews } from '$api/orderViewsLogic';

export type { OrderViewsResponse, OrderViewIncrementResponse } from '$api/orderViewsLogic';

export function orderViewsRoute(db: Database): Hono {
	const app = new Hono();

	app.post('/:account/:permlink/view', async (c) => {
		const r = await incrementOrderView(db, c.req.param('account'), c.req.param('permlink'));
		c.header('Cache-Control', r.cacheControl);
		return c.json(r.body, r.status as 200 | 400 | 404);
	});

	app.get('/:account/view_counts', async (c) => {
		const r = await readOrderViewCounts(db, c.req.param('account'), c.req.query('permlinks'));
		c.header('Cache-Control', r.cacheControl);
		return c.json(r.body, r.status as 200 | 400);
	});

	app.get('/:account/:permlink/views', async (c) => {
		const r = await readOrderViews(db, c.req.param('account'), c.req.param('permlink'));
		c.header('Cache-Control', r.cacheControl);
		return c.json(r.body, r.status as 200 | 400);
	});

	return app;
}
