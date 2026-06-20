/**
 * Morphit indexer — /v1/account/:account/history endpoint. Anchor cp296.
 *
 *   GET /v1/account/:account/history?from=<seq>&limit=<n>
 *     → { entries: [ [seq, { block, trx_id, timestamp, op:[name,body] }], … ] }
 *     400 on a bad account / from / limit.
 *     502 (code "internal") if the chain RPC could not be reached or
 *         returned an unexpected shape.
 *
 * WHY THIS ENDPOINT EXISTS — PRIVACY (priority #1). The balance card's
 * P&L export and the block-explorer account page used to page through
 * Blurt `get_account_history` by talking to public RPC nodes DIRECTLY
 * from the browser — leaking the user's IP and exactly whose history
 * they're reading to third-party operators Morphit doesn't control, and
 * fragile against each node's shifting CORS config. This is the history
 * sibling of /v1/account/:account/balance: the read is relayed
 * SERVER-side across the full canonical pool (rpc-pool latency-aware
 * best-node + cooldown failover), so third parties only ever see the
 * INDEXER's request and the browser opens no cross-origin RPC connection.
 *
 * DELIBERATELY THIN. The browser keeps its own pagination, one-year
 * window, page-cap, and defensive per-entry parsing — it only swaps the
 * per-page SOURCE from direct-RPC to this endpoint (same philosophy as
 * the balance proxy: change the source, keep the frontend's logic). So
 * this route relays ONE page and returns the chain's array verbatim
 * (after an `Array.isArray` guard); it does not reshape heterogeneous
 * ops. History is public on-chain data → a short `public` cache lets one
 * upstream page serve many viewers and widens the privacy set.
 */

import { Hono } from 'hono';

import type { BlurtClient } from '$blurt/client';
import type { AccountHistoryEntry } from '@morphit/indexer-client';
import { errorBody, isAccountName } from '$api/shared';

/** Short public cache. The head page (`from=-1`) changes ~every 3s
 *  block; 5s fresh + 15s stale-while-revalidate keeps the list live
 *  while collapsing repeat reads. `public` is correct — account history
 *  is public chain data, not per-user-private. */
const HISTORY_CACHE_CONTROL = 'public, max-age=5, stale-while-revalidate=15';

/** The chain accepts up to 10_000 entries per call. */
const MAX_LIMIT = 10_000;
const DEFAULT_LIMIT = 1_000;

interface AccountHistoryBody {
	readonly entries: readonly AccountHistoryEntry[];
}

export function accountHistoryRoute(blurt: BlurtClient): Hono {
	const app = new Hono();

	app.get('/:account/history', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		// `from`: -1 = most recent (chain "head"); otherwise a sequence
		// number ≥ 0 to page backward from.
		let from = -1;
		const fromRaw = c.req.query('from');
		if (fromRaw !== undefined) {
			const n = Number(fromRaw);
			if (!Number.isInteger(n) || n < -1) {
				return c.json(errorBody('bad_request', 'invalid from'), 400);
			}
			from = n;
		}

		// `limit`: 1..10000, default 1000.
		let limit = DEFAULT_LIMIT;
		const limitRaw = c.req.query('limit');
		if (limitRaw !== undefined) {
			const n = Number(limitRaw);
			if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
				return c.json(errorBody('bad_request', 'invalid limit'), 400);
			}
			limit = n;
		}

		// get_account_history returns [from-limit+1 .. from] when from ≥ 0,
		// and ERRORS if limit > from+1 (can't ask for more entries than
		// exist up to `from`). Clamp so a near-start page is a valid call
		// rather than an upstream error — the browser already treats a
		// short page as "reached the start of history".
		if (from >= 0 && limit > from + 1) {
			limit = from + 1;
		}

		let result: unknown;
		try {
			// userFacing: true → hedged for a snappy interactive read.
			result = await blurt.callCondenser('get_account_history', [account, from, limit], {
				userFacing: true
			});
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}

		if (!Array.isArray(result)) {
			return c.json(
				errorBody('internal', 'unexpected history shape from the Blurt network'),
				502
			);
		}

		const body: AccountHistoryBody = { entries: result as readonly AccountHistoryEntry[] };
		c.header('Cache-Control', HISTORY_CACHE_CONTROL);
		return c.json(body);
	});

	return app;
}
