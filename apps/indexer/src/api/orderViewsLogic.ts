/**
 * Morphit indexer — orderViews pure handlers.
 *
 * Hono-free implementation of the increment + read logic for
 * /v1/orders/:account/:permlink/view{,s} and the batch read
 * /v1/orders/:account/view_counts.  The routes in
 * orderViews.ts are a thin Hono adapter over these.
 *
 * What the counter is: one public, unauthenticated number per order.
 * Anyone may bump it (POST …/view) and anyone may read it (GET …/views);
 * the web app shows it only to the order's author, but that is a display
 * choice, not an access control. Because it is public, it keeps nothing
 * but the count: no viewer, no IP, and no time of any view (a last-view
 * time would let a reader line views up against outside events). Counts
 * are deliberately non-unique — a reload bumps it — so it stays a rough
 * signal of interest. Abuse limits are the API's ordinary per-client rate
 * limits; nothing here records who called.
 */

import type { Database } from '$db/pool';
import { isAccountName } from '$api/shared';

export interface OrderViewsResponse {
	count: number;
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
		`INSERT INTO order_views (permlink, count)
		 VALUES ($1, 1)
		 ON CONFLICT (permlink)
		 DO UPDATE SET count = order_views.count + 1
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
	const result = await db.query<{ count: string }>(
		'SELECT count FROM order_views WHERE permlink = $1',
		[key]
	);
	// No row reads as 0 rather than 404, so the answer is the same for an
	// order nobody viewed and one that does not exist.
	return {
		status: 200,
		body: { count: result.rows.length === 0 ? 0 : Number(result.rows[0]!.count) },
		// Replaced by `no-store` under /v1: the URL names an account (VT3-6).
		cacheControl: 'public, max-age=30'
	};
}

/** Most permlinks one batch read may name. */
export const MAX_VIEW_COUNT_BATCH = 100;

/** Batch read: the counts for several of one account's orders in one request
 *  (GET /v1/orders/:account/view_counts?permlinks=a,b,…). A page listing its
 *  author's orders asked once per order, and those requests alone used up a
 *  shared-address visitor's rate limit. An unknown or never-viewed permlink
 *  reads 0, as on the single read. */
export async function readOrderViewCounts(
	db: Database,
	account: string,
	permlinksCsv: string | undefined
): Promise<HandlerResult<{ counts: Record<string, number> } | ErrorBody>> {
	if (!isAccountName(account)) {
		return { status: 400, body: { error: 'invalid account' }, cacheControl: 'no-store' };
	}
	const permlinks = [...new Set((permlinksCsv ?? '').split(',').map((p) => p.trim()))].filter(
		(p) => p.length > 0
	);
	if (
		permlinks.length === 0 ||
		permlinks.length > MAX_VIEW_COUNT_BATCH ||
		!permlinks.every((p) => isValidPermlink(p))
	) {
		return { status: 400, body: { error: 'invalid permlinks' }, cacheControl: 'no-store' };
	}
	const result = await db.query<{ permlink: string; count: string }>(
		'SELECT permlink, count FROM order_views WHERE permlink = ANY($1::text[])',
		[permlinks.map((p) => `${account}/${p}`)]
	);
	const byKey = new Map(result.rows.map((r) => [r.permlink, Number(r.count)]));
	const counts: Record<string, number> = {};
	for (const p of permlinks) counts[p] = byKey.get(`${account}/${p}`) ?? 0;
	return { status: 200, body: { counts }, cacheControl: 'public, max-age=30' };
}

// Permlinks are operator-controlled but loosely formatted.
// Cap length and accept the same character set Blurt uses.
const PERMLINK_RE = /^[a-z0-9-]+$/;
function isValidPermlink(s: string | undefined): boolean {
	if (typeof s !== 'string') return false;
	if (s.length === 0 || s.length > 256) return false;
	return PERMLINK_RE.test(s);
}
