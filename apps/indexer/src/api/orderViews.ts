/**
 * Morphit indexer — /v1/orders/:account/:permlink/view{,s}
 * Hono routes.  Task #14.
 *
 * Pure handler logic lives in orderViewsLogic.ts so the smoke
 * runner can test it without Hono installed in the sandbox.
 * See that file's header for the full privacy-design rationale.
 */

import { Hono } from 'hono';
import type { Database } from '$db/pool';
import { incrementOrderView, readOrderViews } from '$api/orderViewsLogic';

export type { OrderViewsResponse, OrderViewIncrementResponse } from '$api/orderViewsLogic';

export function orderViewsRoute(db: Database): Hono {
	const app = new Hono();

	app.post('/:account/:permlink/view', async (c) => {
		const r = await incrementOrderView(db, c.req.param('account'), c.req.param('permlink'));
		c.header('Cache-Control', r.cacheControl);
		return c.json(r.body, r.status as 200 | 400 | 404);
	});

	app.get('/:account/:permlink/views', async (c) => {
		const r = await readOrderViews(db, c.req.param('account'), c.req.param('permlink'));
		c.header('Cache-Control', r.cacheControl);
		return c.json(r.body, r.status as 200 | 400);
	});

	return app;
}
