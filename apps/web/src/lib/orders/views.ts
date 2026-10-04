/**
 * Morphit — order viewcount helpers (task #14).
 *
 * Thin wrappers over POST /v1/orders/:account/:permlink/view and the batch
 * read GET /v1/orders/:account/view_counts.
 *
 * `recordOrderView` is fire-and-forget — a failed POST must
 * never block navigation or surface as a user-visible error.
 * View counts are a soft metric; correctness here is "best
 * effort" by design.
 *
 * `fetchOrderViewCounts` reads the counts of a page of orders in one
 * request (my/orders).
 *
 * See apps/indexer/src/api/orderViews.ts (and orderViewsLogic.ts):
 * counts are non-unique, no viewer and no time of any view is stored,
 * and the GET endpoints are public. The web app shows a count only to
 * the order's author.
 */

import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';
import type { OrderViewCountsResponse } from '@morphit/indexer-client';

/** Most permlinks the indexer accepts in one view_counts request. */
const VIEW_COUNTS_BATCH = 100;

/** Fire a view-count increment.  Non-blocking; errors are
 *  swallowed.  Caller can `await` for tests but production code
 *  should not — the result doesn't matter to the user flow.
 *
 *  Specifically returns Promise<void> rather than the count
 *  because consumers don't have a meaningful use for the post-
 *  increment value; the my/orders page reads the counts itself. */
export async function recordOrderView(account: string, permlink: string): Promise<void> {
	try {
		// Root-absolute path + new URL() → discards any path on the
		// configured origin and resolves to `<origin>/v1/...`. Do NOT
		// string-concatenate onto resolveOrigin(...) — that would retain
		// a path prefix and break colocated single-host deploys.
		const url = new URL(
			`/v1/orders/${encodeURIComponent(account)}/${encodeURIComponent(permlink)}/view`,
			resolveOrigin(MORPHIT_INDEXER_ORIGIN)
		).href;
		// A JSON body and content type: the indexer refuses any other write
		// (a form-encoded or bodyless POST is what a page on another origin
		// can send without a preflight).
		await fetchWithTimeout(url, {
			method: 'POST',
			credentials: 'omit',
			headers: { Accept: 'application/json', 'content-type': 'application/json' },
			body: '{}'
		});
	} catch {
		// Swallow.  View-count failures must not affect anything
		// downstream.
	}
}

/** The view counts of several of one account's orders, in as few requests
 *  as the indexer's batch limit allows (one per 100 permlinks). A permlink
 *  whose count is missing or malformed is left out of the map. Returns null
 *  when any request fails, so the caller keeps what it showed before. */
export async function fetchOrderViewCounts(
	account: string,
	permlinks: readonly string[]
): Promise<Map<string, number> | null> {
	const out = new Map<string, number>();
	const unique = [...new Set(permlinks)];
	try {
		for (let i = 0; i < unique.length; i += VIEW_COUNTS_BATCH) {
			const chunk = unique.slice(i, i + VIEW_COUNTS_BATCH);
			const url = new URL(
				`/v1/orders/${encodeURIComponent(account)}/view_counts`,
				resolveOrigin(MORPHIT_INDEXER_ORIGIN)
			);
			url.searchParams.set('permlinks', chunk.join(','));
			const res = await fetchWithTimeout(url.href, {
				credentials: 'omit',
				headers: { Accept: 'application/json' }
			});
			if (!res.ok) return null;
			const body = (await res.json()) as Partial<OrderViewCountsResponse> | null;
			const counts = body?.counts;
			if (typeof counts !== 'object' || counts === null) return null;
			for (const p of chunk) {
				const n = (counts as Record<string, unknown>)[p];
				if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out.set(p, n);
			}
		}
		return out;
	} catch {
		return null;
	}
}
