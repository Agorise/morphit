/**
 * Morphit indexer — /v1/conversations/:account endpoint.
 *
 * Lists the conversations an account is party to, most recent
 * first. Each item:
 *
 *   {
 *     peer: string,
 *     last_message_at: ISO string,
 *     message_count: number
 *   }
 *
 * Unread tracking is NOT on the server. Clients maintain their
 * own last-seen markers (localStorage) against the list returned
 * here. This keeps the endpoint stateless and avoids putting
 * per-user state in the indexer.
 *
 * Authentication: none. The endpoint reveals whom an account has
 * chatted with and when — metadata that is already public on chain
 * (the `morphit_chat_v1` op has sender + recipient in the clear).
 * Exposing this metadata via an endpoint is equivalent to
 * exposing the on-chain data, just faster to query.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

const MAX_CONVERSATIONS = 200;

interface ConversationRow {
	peer: string;
	last_message_at: Date;
	message_count: string; // bigint → string
	has_user_sent: boolean;
}

export function conversationsRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		// Group by the "other party" — sender when the query account
		// is the recipient, recipient when the query account is the
		// sender. The CASE expression canonicalizes.
		//
		// `has_user_sent` aggregates whether any row in the group
		// had the query account as sender (i.e. the user has
		// replied at least once). Drives the frontend's
		// "Requests" vs "Messages" tab split for Finding H layer 2:
		// inbound-only conversations (has_user_sent=false) are
		// strangers who paid the fee and are awaiting engagement.
		//
		// Indexes: chat_messages already has indexes on sender and
		// recipient (from the per-conversation endpoint), so the
		// WHERE sender=$1 OR recipient=$1 can use index scans. The
		// GROUP BY happens after filtering.
		const sql = `
			SELECT
				CASE WHEN sender = $1 THEN recipient ELSE sender END AS peer,
				MAX(created_at) AS last_message_at,
				COUNT(*)::text AS message_count,
				BOOL_OR(sender = $1) AS has_user_sent
			FROM chat_messages
			WHERE sender = $1 OR recipient = $1
			GROUP BY peer
			ORDER BY last_message_at DESC
			LIMIT $2
		`;

		const result = await db.query<ConversationRow>(sql, [account, MAX_CONVERSATIONS]);

		return c.json({
			account,
			items: result.rows.map((r) => ({
				peer: r.peer,
				last_message_at: r.last_message_at.toISOString(),
				message_count: parseInt(r.message_count, 10),
				has_user_sent: r.has_user_sent
			}))
		});
	});

	return app;
}
