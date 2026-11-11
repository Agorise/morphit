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
 * `order_permlink` names the DISCUSSION the ack is for: the order's
 * permlink, '' for the order-less thread, or '*' for a legacy peer-wide ack.
 * A client evaluates unread against MAX(this thread's ack, the '*' ack).
 *   }
 *
 * Items sorted by last_read_at DESC (most recently read first).
 *
 * `last_read_at` is the ack as written, except (v1.24.1) an ack of a message's
 * fast copy, which is given as that message's block time: see the query.
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

		// v1.24.1 — a thread's ack that is a fast copy's signed time reads as
		// that message's block time. A device that read the message before its
		// block was applied (the fast path) acked the time it was shown with:
		// the sender's signed time, earlier than the block time its row carries
		// (chat_messages.sent_at, migration v74). Every other device of the
		// reader then compared that row against the ack and showed the thread
		// unread until it was opened there too. The ack is that copy's when a
		// message of the thread was signed at exactly the ack's time and landed
		// within 75 s of it (the client's 60 s expiry, and a little for the
		// stamp), and no message of the thread has the ack's time as its block
		// time: the signed time is a head block's time (the client builds the
		// expiry from it), so an ack of an earlier message's row can carry the
		// same instant, and must stay what it is. The earliest such message is
		// the one read — unless another message of the peer's lands in the same
		// stretch (after the ack, up to that message's block) signed at or after
		// the ack, or at an unknown time: one sent later than the message read,
		// or with it in the same head block, which the reader has not seen (a
		// message can miss a block and land with the next one). Then the ack
		// stays what it is: never hide a message to cure a phantom. A legacy peer-wide ack ('*') names no discussion a
		// message is in, so it is left as it is.
		const sql = `
			SELECT r.peer_account AS peer, r.order_permlink,
				COALESCE(
					(
						SELECT MIN(m.created_at)
						FROM chat_messages m
						WHERE LEAST(m.sender, m.recipient) = LEAST($1, r.peer_account)
							AND GREATEST(m.sender, m.recipient) = GREATEST($1, r.peer_account)
							AND m.created_at > r.last_read_at
							AND m.created_at <= r.last_read_at + INTERVAL '75 seconds'
							AND m.sent_at = r.last_read_at
							AND COALESCE(m.order_permlink, '') = r.order_permlink
							AND NOT EXISTS (
								SELECT 1
								FROM chat_messages u
								WHERE LEAST(u.sender, u.recipient) = LEAST($1, r.peer_account)
									AND GREATEST(u.sender, u.recipient) = GREATEST($1, r.peer_account)
									AND COALESCE(u.order_permlink, '') = r.order_permlink
									AND u.sender = r.peer_account
									AND u.id <> m.id
									AND u.created_at > r.last_read_at
									AND u.created_at <= m.created_at
									AND (u.sent_at IS NULL OR u.sent_at >= r.last_read_at)
							)
							AND NOT EXISTS (
								SELECT 1
								FROM chat_messages b
								WHERE LEAST(b.sender, b.recipient) = LEAST($1, r.peer_account)
									AND GREATEST(b.sender, b.recipient) = GREATEST($1, r.peer_account)
									AND b.created_at = r.last_read_at
									AND COALESCE(b.order_permlink, '') = r.order_permlink
							)
					),
					r.last_read_at
				) AS last_read_at
			FROM chat_read_state r
			WHERE r.reader_account = $1
			ORDER BY r.last_read_at DESC
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
