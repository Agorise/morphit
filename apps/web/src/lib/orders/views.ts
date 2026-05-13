/**
 * Morphit — order viewcount helpers (task #14).
 *
 * Thin wrappers over /v1/orders/:account/:permlink/view{,s}.
 *
 * `recordOrderView` is fire-and-forget — a failed POST must
 * never block navigation or surface as a user-visible error.
 * View counts are a soft metric; correctness here is "best
 * effort" by design.
 *
 * `fetchOrderViews` is request/response — owners call this on
 * the my/orders page to display the count.
 *
 * See apps/indexer/src/api/orderViews.ts (and orderViewsLogic.ts)
 * for the privacy-design rationale: counts are non-unique, no
 * per-viewer detail is tracked, the GET endpoint is public-
 * readable but the frontend only displays counts to the order's
 * author.
 */

import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
import type { OrderViewsResponse } from '@morphit/indexer-client';

/** Fire a view-count increment.  Non-blocking; errors are
 *  swallowed.  Caller can `await` for tests but production code
 *  should not — the result doesn't matter to the user flow.
 *
 *  Specifically returns Promise<void> rather than the count
 *  because consumers don't have a meaningful use for the post-
 *  increment value; the my/orders page does its own GET fetch
 *  on render. */
export async function recordOrderView(account: string, permlink: string): Promise<void> {
	try {
		const origin = resolveOrigin(MORPHIT_INDEXER_ORIGIN);
		const url = `${origin}/v1/orders/${encodeURIComponent(account)}/${encodeURIComponent(permlink)}/view`;
		await fetch(url, {
			method: 'POST',
			credentials: 'omit',
			headers: { Accept: 'application/json' }
		});
	} catch {
		// Swallow.  View-count failures must not affect anything
		// downstream.
	}
}

/** Fetch the current view count for an order.  Returns null on
 *  any error (network, 4xx, parse).  Owners use this on
 *  /my/orders; non-owners shouldn't call it (the frontend gates
 *  display by isAuthor — calling for a non-owned permlink would
 *  succeed against a public endpoint but display violates the
 *  privacy-by-display contract). */
export async function fetchOrderViews(
	account: string,
	permlink: string
): Promise<OrderViewsResponse | null> {
	try {
		const origin = resolveOrigin(MORPHIT_INDEXER_ORIGIN);
		const url = `${origin}/v1/orders/${encodeURIComponent(account)}/${encodeURIComponent(permlink)}/views`;
		const res = await fetch(url, {
			credentials: 'omit',
			headers: { Accept: 'application/json' }
		});
		if (!res.ok) return null;
		const body = (await res.json()) as unknown;
		if (
			typeof body !== 'object' ||
			body === null ||
			typeof (body as { count?: unknown }).count !== 'number'
		) {
			return null;
		}
		const count = (body as { count: number }).count;
		const updatedAt =
			typeof (body as { updated_at?: unknown }).updated_at === 'string'
				? (body as { updated_at: string }).updated_at
				: null;
		if (!Number.isFinite(count) || count < 0) return null;
		return { count, updated_at: updatedAt };
	} catch {
		return null;
	}
}
