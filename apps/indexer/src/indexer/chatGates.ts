/**
 * apps/indexer/src/indexer/chatGates.ts
 *
 * cp471 — shared chat admission checks, so the DURABLE handler (chat.ts) and
 * the FAST head-block tailer (headTailer.ts) evaluate order-tag validity
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

/**
 * cp472 — the PROVABLE-COUNTERPARTY bar, i.e. the `has_verified_chat` badge:
 * a substantiated two-way on-chain conversation between two accounts —
 * ≥2 morphit_chat_v1 EACH WAY, ≥15-minute span, and the sockpuppet detector
 * has NOT flagged the pair (suspicious_reciprocity).
 *
 * EXTRACTED (cp472) from handlers/feedback.ts, which has enforced exactly this
 * since cp420/cp421, so there is now ONE implementation. It gates:
 *
 *   • a REVIEW (feedback.ts) — you cannot review a ghost, and
 *   • the `counterparty` named in morphit_order_complete_v1 (orderComplete.ts).
 *
 * The second is why it moved here. Settlement is off-chain and undecidable, and
 * the payment proof lives in E2EE chat the indexer cannot read (the BLURT
 * transfer memo is a random opaque token BY DESIGN, so nothing on-chain links a
 * payment to an order). So the owner ASSERTS who they traded with. Unbounded,
 * that lets an owner name ANYONE — minting trade credit for a confederate and,
 * worse, publishing an unconsented claim that some stranger traded with them.
 * Requiring this bar means the named party must have provably held a sustained
 * two-way conversation with the owner first.
 *
 * Ken chose the STRICT bar (cp421) over a looser bidirectional-only check: it
 * costs some legitimate ultra-fast trades, but a sockpuppeteer has to fabricate
 * a sustained conversation rather than two throwaway messages.
 *
 * `asOf` bounds the evidence to the op's own block time, so a handler replaying
 * history can never see messages from that op's future.
 */
export async function hasVerifiedChat(
	db: ChatGateDb,
	args: { a: string; b: string; asOf: Date }
): Promise<boolean> {
	if (args.a === args.b) return false;
	const res = await db.query<{
		from_a: string;
		from_b: string;
		span_seconds: string | null;
		has_recip_flag: boolean;
	}>(
		`SELECT
		   COUNT(*) FILTER (WHERE sender = $1 AND recipient = $2) AS from_a,
		   COUNT(*) FILTER (WHERE sender = $2 AND recipient = $1) AS from_b,
		   EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))::text AS span_seconds,
		   EXISTS (
		     SELECT 1 FROM suspicious_reciprocity sr
		      WHERE sr.account_a = LEAST($1::text, $2::text)
		        AND sr.account_b = GREATEST($1::text, $2::text)
		   ) AS has_recip_flag
		 FROM chat_messages
		 WHERE (
		         (sender = $1 AND recipient = $2)
		      OR (sender = $2 AND recipient = $1)
		     )
		   AND created_at <= $3`,
		[args.a, args.b, args.asOf]
	);
	const r = res.rows[0];
	if (r === undefined) return false;
	const spanSec = r.span_seconds === null ? 0 : Number(r.span_seconds);
	return (
		Number(r.from_a) >= 2 &&
		Number(r.from_b) >= 2 &&
		Number.isFinite(spanSec) &&
		spanSec >= 15 * 60 &&
		r.has_recip_flag !== true
	);
}
