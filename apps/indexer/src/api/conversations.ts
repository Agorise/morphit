/**
 * Morphit indexer — /v1/conversations/:account endpoint.
 *
 * Lists the conversations an account is party to, most recent
 * first. Each item:
 *
 *   {
 *     peer: string,
 *     last_message_at: ISO string,
 *     message_count: number,
 *     has_user_sent: boolean,
 *     order: { permlink, account, side, asset, fiat_currency,
 *              amount_min, amount_max, status } | null
 *       // the order THIS THREAD is about, for the frontend's
 *       // "RE: <linked title> (Live)" subline. null when the thread
 *       // cites no order — that thread gets no subline at all.
 *   }
 *
 * cp446 — one item per DISCUSSION, not per person. The same peer appears once
 * per order they have talked to you about, plus once more for any order-less
 * thread, exactly like an email inbox. `peer` alone is therefore NOT a unique
 * key for an item; `(peer, order?.permlink ?? null)` is.
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

/**
 * Cap on rows returned. cp446 changed what a row IS: it used to be one per PEER,
 * it is now one per DISCUSSION (peer + order). A trader with many threads against
 * the same counterparty therefore consumes more of this budget than before.
 *
 * Left at 200 deliberately rather than raised on a hunch: the subquery orders by
 * `last_message_at DESC` before the LIMIT, so what a user loses at the cap is the
 * oldest threads, not whole peers at random. If real inboxes start hitting it,
 * the fix is pagination, not a bigger number.
 */
const MAX_CONVERSATIONS = 200;

interface ConversationRow {
	peer: string;
	last_message_at: Date;
	message_count: string; // bigint → string
	has_user_sent: boolean;
	// The order this conversation is most recently about (from the
	// latest message carrying an order_permlink), or all-null when
	// the conversation references no order / the order row is gone.
	order_permlink: string | null;
	order_account: string | null;
	order_side: string | null;
	order_asset: string | null;
	order_fiat_currency: string | null;
	order_amount_min: string | null; // NUMERIC::text
	order_amount_max: string | null; // NUMERIC::text
	/** 'live' | 'cancelled' | 'expired' — orders.status (schema.sql:87). Ken:
	 *  the inbox card shows it beside "RE: <title>" so an old thread declares
	 *  up-front whether the order still exists. */
	order_status: string | null;
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
		// The LATERAL finds, per conversation, the MOST RECENT message
		// that carried a plaintext `order_permlink` — so the "RE:" line
		// tracks whatever order the two parties last referenced. The
		// message's RECIPIENT is the order owner: chat.ts's op
		// validator only accepts an `order_permlink` that names an
		// order owned by the recipient, so `orders` joins on
		// (recipient, permlink). The join tolerates a since-cancelled
		// or expired order (those rows persist); it yields all-null
		// only if the conversation references no order or the order
		// row is truly gone. `order_permlink IS NOT NULL` uses the
		// chat_messages (order_permlink, created_at DESC, sender)
		// index (migration 25); the outer GROUP BY reuses the
		// sender/recipient indexes.
		// cp446 (Ken) — the inbox works like an email inbox: ONE CARD PER
		// DISCUSSION, not one per person. Two threads with the same peer about two
		// different orders are two different conversations, and a thread with no
		// order is its own. So we group by (peer, order_permlink) rather than by
		// peer, and a NULL permlink is a group in its own right — Postgres GROUP BY
		// treats NULLs as equal, which is exactly what we want here.
		//
		// The order owner is whichever party actually owns an order with that
		// permlink. The previous query assumed `m.recipient` was the owner, which
		// holds for the first message of a thread but not for the replies.
		const sql = `
			SELECT
				g.peer,
				g.last_message_at,
				g.message_count,
				g.has_user_sent,
				o.permlink          AS order_permlink,
				o.account           AS order_account,
				o.side              AS order_side,
				o.asset             AS order_asset,
				o.fiat_currency     AS order_fiat_currency,
				o.amount_min::text  AS order_amount_min,
				o.amount_max::text  AS order_amount_max,
				o.status            AS order_status
			FROM (
				SELECT
					CASE WHEN sender = $1 THEN recipient ELSE sender END AS peer,
					order_permlink,
					MAX(created_at) AS last_message_at,
					COUNT(*)::text AS message_count,
					BOOL_OR(sender = $1) AS has_user_sent
				FROM chat_messages
				WHERE sender = $1 OR recipient = $1
				GROUP BY peer, order_permlink
				ORDER BY last_message_at DESC
				LIMIT $2
			) g
			LEFT JOIN LATERAL (
				SELECT ord.*
				FROM orders ord
				WHERE g.order_permlink IS NOT NULL
					AND ord.permlink = g.order_permlink
					AND ord.account IN ($1, g.peer)
				ORDER BY (ord.account = g.peer) DESC
				LIMIT 1
			) o ON TRUE
			ORDER BY g.last_message_at DESC
		`;

		const result = await db.query<ConversationRow>(sql, [account, MAX_CONVERSATIONS]);

		return c.json({
			account,
			items: result.rows.map((r) => ({
				peer: r.peer,
				last_message_at: r.last_message_at.toISOString(),
				message_count: parseInt(r.message_count, 10),
				has_user_sent: r.has_user_sent,
				// Present only when the JOIN found a live order row for
				// the latest order-carrying message. amount_min/max are
				// fiat NUMERIC → ::text → Number (matches src/api/orders.ts).
				order:
					r.order_permlink !== null && r.order_account !== null
						? {
								permlink: r.order_permlink,
								account: r.order_account,
								side: r.order_side ?? 'buy',
								asset: r.order_asset ?? '',
								fiat_currency: r.order_fiat_currency ?? '',
								amount_min: r.order_amount_min === null ? null : Number(r.order_amount_min),
								amount_max: r.order_amount_max === null ? null : Number(r.order_amount_max),
								status: r.order_status ?? 'live'
							}
						: null
			}))
		});
	});

	return app;
}
