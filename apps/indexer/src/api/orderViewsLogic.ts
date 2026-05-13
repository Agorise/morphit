/**
 * Morphit indexer — orderViews pure handlers.
 *
 * Hono-free implementation of the increment + read logic for
 * /v1/orders/:account/:permlink/view{,s}.  The routes in
 * orderViews.ts are a thin Hono adapter over these.
 *
 * Splitting them out lets the smoke test the privacy- and
 * correctness-relevant logic without needing Hono installed in
 * the smoke sandbox.
 *
 * See orderViews.ts for the full privacy-design rationale.
 */

import type { Database } from '$db/pool';
import { isAccountName } from '$api/shared';

export interface OrderViewsResponse {
	count: number;
	updated_at: string | null;
}

export interface OrderViewIncrementResponse {
	count: number;
}

/** Pure handler result — what the route returns when called.
 *  The Hono adapter unpacks status/body into c.json() and sets
 *  the cacheControl header. */
export interface HandlerResult<B> {
	status: number;
	body: B;
	cacheControl: string;
}

type ErrorBody = { error: string };

/** Increment-handler logic. */
export async function incrementOrderView(
	db: Database,
	account: string,
	permlink: string
): Promise<HandlerResult<OrderViewIncrementResponse | ErrorBody>> {
	if (!isAccountName(account)) {
		return {
			status: 400,
			body: { error: 'invalid account' },
			cacheControl: 'no-store'
		};
	}
	if (!isValidPermlink(permlink)) {
		return {
			status: 400,
			body: { error: 'invalid permlink' },
			cacheControl: 'no-store'
		};
	}

	const exists = await db.query<{ exists: boolean }>(
		'SELECT EXISTS(SELECT 1 FROM orders WHERE account = $1 AND permlink = $2) AS exists',
		[account, permlink]
	);
	if (!exists.rows[0]?.exists) {
		return {
			status: 404,
			body: { error: 'order not found' },
			cacheControl: 'no-store'
		};
	}

	const key = `${account}/${permlink}`;
	const result = await db.query<{ count: string }>(
		`INSERT INTO order_views (permlink, count, updated_at)
		 VALUES ($1, 1, now())
		 ON CONFLICT (permlink)
		 DO UPDATE SET count = order_views.count + 1, updated_at = now()
		 RETURNING count`,
		[key]
	);

	return {
		status: 200,
		body: { count: Number(result.rows[0]!.count) },
		cacheControl: 'no-store'
	};
}

/** Read-handler logic. */
export async function readOrderViews(
	db: Database,
	account: string,
	permlink: string
): Promise<HandlerResult<OrderViewsResponse | ErrorBody>> {
	if (!isAccountName(account)) {
		return {
			status: 400,
			body: { error: 'invalid account' },
			cacheControl: 'no-store'
		};
	}
	if (!isValidPermlink(permlink)) {
		return {
			status: 400,
			body: { error: 'invalid permlink' },
			cacheControl: 'no-store'
		};
	}

	const key = `${account}/${permlink}`;
	const result = await db.query<{
		count: string;
		updated_at: string;
	}>('SELECT count, updated_at FROM order_views WHERE permlink = $1', [key]);
	if (result.rows.length === 0) {
		// Privacy: don't 404, return 0.  See header note in
		// orderViews.ts.
		return {
			status: 200,
			body: { count: 0, updated_at: null },
			cacheControl: 'public, max-age=30'
		};
	}

	return {
		status: 200,
		body: {
			count: Number(result.rows[0]!.count),
			updated_at: result.rows[0]!.updated_at
		},
		cacheControl: 'public, max-age=30'
	};
}

// Permlinks are operator-controlled but loosely formatted.
// Cap length and accept the same character set Blurt uses.
const PERMLINK_RE = /^[a-z0-9-]+$/;
function isValidPermlink(s: string | undefined): boolean {
	if (typeof s !== 'string') return false;
	if (s.length === 0 || s.length > 256) return false;
	return PERMLINK_RE.test(s);
}
