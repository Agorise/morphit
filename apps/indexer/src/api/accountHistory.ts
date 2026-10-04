/**
 * Morphit indexer — /v1/account/:account/history endpoint. Anchor.
 *
 *   GET /v1/account/:account/history?from=<seq>&limit=<n>
 *     → { entries: [ [seq, { block, trx_id, timestamp, op:[name,body] }], … ] }
 *     400 on a bad account / from / limit.
 *     413 (code "reply_too_large") if the page is larger than a reply of
 *         this `limit` may be (the RPC fetch guard's budget) — ask for fewer.
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
 * ops. History is public on-chain data, but the URL names the account, so
 * the answer is never stored (`no-store` from the security middleware,
 * VT3-6).
 */

import { Hono } from 'hono';
import { RpcReplyOverRequestBudgetError } from '@morphit/hidden-transport/rpc-fetch';

import type { BlurtClient } from '$blurt/client';
import type { AccountHistoryEntry } from '@morphit/indexer-client';
import { errorBody, isAccountName } from '$api/shared';
import { requestClient } from '$api/middleware/ratelimit';

/** The chain accepts up to 10_000 entries per call. */
const MAX_LIMIT = 10_000;
const DEFAULT_LIMIT = 1_000;

/**
 * VT5-2 — history entries this route has in flight, as a measure of memory
 * and upstream load. A 10,000-entry page can be ~35 MiB from the node and
 * ~130 MiB here while it is parsed and re-serialised; nothing used to bound
 * how many ran at once, and twelve took the process past 2 GB. A request
 * that would go over a cap is answered 503 `history_busy` (Retry-After)
 * before any RPC call:
 *   - per client, keyed exactly as the rate limiter keys requests;
 *   - for the SHARED key (our own proxy's address, standing for every Tor/I2P
 *     visitor) as a whole, so it is held to one client's share;
 *   - instance-wide.
 */
export const HISTORY_ENTRIES_PER_CLIENT = 10_000;
export const HISTORY_ENTRIES_SHARED = 10_000;
export const HISTORY_ENTRIES_GLOBAL = 20_000;
/** A page larger than this is never hedged (asked of two nodes at once): its
 *  reply may be tens of MiB. */
const HEDGE_MAX_LIMIT = 1_000;
const BUSY_RETRY_AFTER_S = 5;

interface AccountHistoryBody {
	readonly entries: readonly AccountHistoryEntry[];
}

export function accountHistoryRoute(blurt: BlurtClient): Hono {
	const app = new Hono();

	// Entries in flight: in total, for the shared key, per client.
	let inFlight = 0;
	let inFlightShared = 0;
	const perClient = new Map<string, number>();
	/** Take `entries` of the caps; the release function, or null when over. */
	const acquire = (key: string, shared: boolean, entries: number): (() => void) | null => {
		const held = perClient.get(key) ?? 0;
		if (inFlight + entries > HISTORY_ENTRIES_GLOBAL) return null;
		if (
			shared
				? inFlightShared + entries > HISTORY_ENTRIES_SHARED
				: held + entries > HISTORY_ENTRIES_PER_CLIENT
		) {
			return null;
		}
		inFlight += entries;
		if (shared) inFlightShared += entries;
		perClient.set(key, held + entries);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			inFlight -= entries;
			if (shared) inFlightShared -= entries;
			const n = (perClient.get(key) ?? entries) - entries;
			if (n <= 0) perClient.delete(key);
			else perClient.set(key, n);
		};
	};

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

		const client = requestClient(c);
		const release = acquire(client.key, client.shared, limit);
		if (release === null) {
			c.header('retry-after', String(BUSY_RETRY_AFTER_S));
			return c.json(
				{
					status: 'error',
					code: 'history_busy',
					message: 'Too many history reads in progress. Retry shortly.'
				},
				503
			);
		}

		let result: unknown;
		try {
			// A small page is hedged for a snappy interactive read; a large one
			// is not — its reply may be tens of MiB (VT5-2).
			result = await blurt.callCondenser('get_account_history', [account, from, limit], {
				userFacing: limit <= HEDGE_MAX_LIMIT
			});
		} catch (err) {
			// The page is larger than this request may return (the RPC fetch
			// guard sizes a history reply from its limit, and every node would
			// send the same): a distinct answer, so the browser asks again for
			// fewer entries. Never a shorter page — the browser reads a short page
			// as the start of history, which would silently cut the P&L export.
			release();
			if (err instanceof RpcReplyOverRequestBudgetError) {
				return c.json(
					errorBody('reply_too_large', 'this page is too large; ask for fewer entries'),
					413
				);
			}
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}

		if (!Array.isArray(result)) {
			release();
			return c.json(errorBody('internal', 'unexpected history shape from the Blurt network'), 502);
		}

		const body: AccountHistoryBody = { entries: result as readonly AccountHistoryEntry[] };
		// Held until the page is serialised: that is the other half of its cost.
		try {
			return c.json(body);
		} finally {
			release();
		}
	});

	return app;
}
