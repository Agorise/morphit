/**
 * apps/indexer/src/indexer/chatGates.ts
 *
 * cp471 — shared chat admission checks, so the DURABLE handler (chat.ts) and
 * the FAST head-block tailer (chatHeadTailer.ts) evaluate order-tag validity
 * and prior-exchange IDENTICALLY and can never drift apart. Divergence here
 * would be a security bug (the stranger-fee bypass and the fast-notify gate
 * both hang off these), so there is exactly ONE implementation.
 */
import type pg from 'pg';

/** The minimal db surface both `Database` (pool.ts) and `pg.PoolClient`
 *  satisfy. */
export interface ChatGateDb {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pg.QueryResult<R>>;
}

export interface ChatOrderCheck {
	/** True iff `permlink` names a real order owned by ONE OF THE TWO PARTIES
	 *  (recipient or signer). A tag naming no such order is invalid — the
	 *  durable handler rejects the message with `order_permlink_not_found`,
	 *  and the fast path must NOT notify for it. */
	readonly found: boolean;
	/** True iff that order is status='live' and not past expires_at as of
	 *  `blockTime`. Only meaningful when `found`. */
	readonly live: boolean;
	/** True iff that order is owned by the RECIPIENT (not the signer). Only
	 *  meaningful when `found`. */
	readonly ownedByRecipient: boolean;
}

/**
 * The order-tag check shared by chat.ts (durable, ~line 302) and the fast
 * tailer. Mirrors the durable query exactly: an order at `permlink` owned by
 * either party, with a computed `live` flag.
 *
 * The stranger-fee bypass AND the cp471 fast-notify "order signal" are
 * `found && ownedByRecipient && live` — computed by the caller from this.
 */
export async function checkChatOrder(
	db: ChatGateDb,
	args: { permlink: string; recipient: string; signer: string; blockTime: Date }
): Promise<ChatOrderCheck> {
	const res = await db.query<{ account: string; live: boolean }>(
		`SELECT account,
		        (status = 'live' AND (expires_at IS NULL OR expires_at > $3)) AS live
		   FROM orders
		  WHERE permlink = $1
		    AND account IN ($2, $4)
		  LIMIT 1`,
		[args.permlink, args.recipient, args.blockTime, args.signer]
	);
	const ord = res.rows[0];
	if (ord === undefined) return { found: false, live: false, ownedByRecipient: false };
	return {
		found: true,
		live: ord.live === true,
		ownedByRecipient: ord.account === args.recipient
	};
}

/**
 * True iff the RECIPIENT has previously sent the SENDER a message — i.e. a
 * genuine TWO-WAY conversation (the recipient replied to, or first reached out
 * to, this sender). cp471 uses this as the SAFE fast-notify gate.
 *
 * DIRECTIONAL on purpose. An earlier bidirectional "any prior message between
 * the pair" check was unsafe: a one-way spammer's OWN prior messages counted,
 * so they could keep fast-notifying a recipient who never replied — right past
 * the durable path's sender-no-reply cap (chat.ts sender_no_reply_cap) and
 * fan-in cap (recipient_fan_in_exceeded), which the fast path does not run.
 * Requiring a reply FROM the recipient means an unengaged / one-way sender is
 * never fast-notified; their messages fall to the gated durable path. Only
 * admitted messages are stored, so a hit is a real prior reply.
 *
 * (Residual, documented: a contact the recipient HAS replied to could still
 * fast-notify during a flood the durable would cap — but the recipient can
 * block them, the block gate holds on the fast path, and the durable still
 * caps persistence. This narrow case is accepted over duplicating the stateful
 * fan-in / no-reply counters on the fast path.)
 *
 * Uses the LEAST/GREATEST(sender,recipient) pair index to narrow to the pair,
 * then filters to the recipient→sender direction.
 */
export async function recipientHasReplied(
	db: ChatGateDb,
	args: { recipient: string; sender: string }
): Promise<boolean> {
	const res = await db.query<{ exists: boolean }>(
		`SELECT EXISTS (
		   SELECT 1 FROM chat_messages
		    WHERE LEAST(sender, recipient) = LEAST($1, $2)
		      AND GREATEST(sender, recipient) = GREATEST($1, $2)
		      AND sender = $1
		 ) AS exists`,
		[args.recipient, args.sender]
	);
	return res.rows[0]?.exists === true;
}
