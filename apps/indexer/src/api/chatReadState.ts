/**
 * Morphit indexer — /v1/chat-read-state/:account endpoint.
 *
 * Returns every row the given account has written in
 * `chat_read_state` — i.e. the set of (peer, order_permlink, last_read_at) rows
 * the account has acknowledged reading.
 *
 * Used by the frontend inbox to compute per-peer unread status
 * server-authoritatively, replacing the Phase A localStorage-only
 * path. Clients still maintain a local copy of read-state for
 * offline-first UX; on load, the local copy is merged with this
 * response (server wins where they disagree, since the on-chain
 * state is durable and cross-device).
 *
 * Authentication: none. Every morphit_chat_read_v1 op is a public
 * on-chain event; this endpoint exposes the derived state just as
 * /v1/conversations exposes the derived chat-metadata state.
 *
 * Response shape (also exported as type from
 *   @morphit/indexer-client):
 *
 *   {
 *     account: string,
 *     items: [{ peer: string, order_permlink: string, last_read_at: string }]
 *
 * cp446 — `order_permlink` names the DISCUSSION the ack is for: the order's
 * permlink, '' for the order-less thread, or '*' for a legacy peer-wide ack.
 * A client evaluates unread against MAX(this thread's ack, the '*' ack).
 *   }
 *
 * Items sorted by last_read_at DESC (most recently read first).
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

/** Hard cap on rows returned. The typical user has tens of
 *  peers; 10k is an unreachable ceiling that still bounds the
 *  response under any reasonable adversarial input (e.g. a spammy
 *  account that ack'd against hundreds of sock peers). */
const MAX_ROWS = 10_000;

interface Row {
	peer: string;
	last_read_at: Date;
	order_permlink: string;
}

export function chatReadStateRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const sql = `
			SELECT peer_account AS peer, order_permlink, last_read_at
			FROM chat_read_state
			WHERE reader_account = $1
			ORDER BY last_read_at DESC
			LIMIT $2
		`;

		const result = await db.query<Row>(sql, [account, MAX_ROWS]);

		return c.json({
			account,
			items: result.rows.map((r) => ({
				peer: r.peer,
				order_permlink: r.order_permlink,
				last_read_at: r.last_read_at.toISOString()
			}))
		});
	});

	return app;
}
