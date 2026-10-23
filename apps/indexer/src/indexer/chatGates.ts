/**
 * apps/indexer/src/indexer/chatGates.ts
 *
 * shared chat admission checks, so the DURABLE handler (chat.ts) and
 * the FAST head-block tailer (headTailer.ts) evaluate order-tag validity
 * and prior-exchange IDENTICALLY and can never drift apart. Divergence here
 * would be a security bug (the stranger-fee bypass and the fast-notify gate
 * both hang off these), so there is exactly ONE implementation.
 */
import type pg from 'pg';
import { reciprocityEverHeld } from '$indexer/signals';

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
 * The stranger-fee bypass AND the fast-notify "order signal" are
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
		  -- When BOTH hold an order under this permlink, the recipient's is the
		  -- one that matters (the bypass is for orders the recipient owns). A
		  -- bare LIMIT 1 returned whichever row the scan met first, so the
		  -- verdict could differ between nodes.
		  ORDER BY (account = $2) DESC
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
 * to, this sender). A later change uses this as the SAFE fast-notify gate.
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
 * Is this sender already ADMITTED to write to this recipient without a reply?
 * The durable stranger-fee gate admits a first-contact message when the sender
 * paid the stranger fee for this recipient, or already has an admitted message
 * to them (handlers/chat.ts, layer 2). The fast-notify gate needs the same
 * answer (v1.21.14 full chat audit, S-H3): a paid first contact — the "new
 * chatroom request" the fee exists to let through — reached the inbox only at
 * durable time, 45-63 s late.
 */
export async function senderAdmittedWithoutReply(
	db: ChatGateDb,
	args: { recipient: string; sender: string }
): Promise<boolean> {
	const res = await db.query<{ admitted: boolean }>(
		`SELECT EXISTS (
		   SELECT 1 FROM chat_messages WHERE sender = $2 AND recipient = $1
		 ) OR EXISTS (
		   SELECT 1 FROM stranger_fees WHERE sender = $2 AND recipient = $1
		 ) AS admitted`,
		[args.recipient, args.sender]
	);
	return res.rows[0]?.admitted === true;
}

/**
 * the PROVABLE-COUNTERPARTY bar, i.e. the `has_verified_chat` badge:
 * a substantiated two-way on-chain conversation between two accounts —
 * ≥2 morphit_chat_v1 EACH WAY, ≥15-minute span, and the pair has never shown
 * the suspicious-reciprocity pattern (Signal B) up to `asOf`.
 *
 * EXTRACTED from handlers/feedback.ts, which has enforced exactly this
 * since an earlier release, so there is now ONE implementation. It gates:
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
 * The project chose the STRICT bar over a looser bidirectional-only check: it
 * costs some legitimate ultra-fast trades, but a sockpuppeteer has to fabricate
 * a sustained conversation rather than two throwaway messages.
 *
 * `asOf` bounds the evidence to the op's own block time, so a handler replaying
 * history can never see messages from that op's future.
 *
 * The reciprocity part is computed from the chain-derived feedback rows up to
 * `asOf` (signals.reciprocityEverHeld). It used to read the
 * `suspicious_reciprocity` table, which an hourly wall-clock detector filled:
 * whether a review was admitted then depended on whether this node's detector
 * had happened to run, so identical chains gave different reviews and trade
 * credits on different nodes.
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
	}>(
		`SELECT
		   COUNT(*) FILTER (WHERE sender = $1 AND recipient = $2) AS from_a,
		   COUNT(*) FILTER (WHERE sender = $2 AND recipient = $1) AS from_b,
		   EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))::text AS span_seconds
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
	const conversation =
		Number(r.from_a) >= 2 &&
		Number(r.from_b) >= 2 &&
		Number.isFinite(spanSec) &&
		spanSec >= 15 * 60;
	if (!conversation) return false;
	return !(await reciprocityEverHeld(db, { a: args.a, b: args.b, asOf: args.asOf }));
}

/** Max unique new senders (i.e. senders the recipient has not
 *  replied to) allowed in a rolling 24h window per recipient. */
export const FAN_IN_UNIQUE_SENDERS_24H = 20;

/** Max messages a single sender can send to a single recipient
 *  who has not replied, over ALL time. Once the recipient
 *  replies once, this cap lifts. */
export const PER_PAIR_NO_REPLY_CAP = 50;

/** What the no-reply caps count, as of `at`. */
export interface NoReplyLimits {
	/** Distinct senders (this one included) in the last 24 h the recipient has
	 *  never replied to and has not blocked. */
	readonly fanIn: number;
	/** Messages from this sender to the recipient, or null when the recipient
	 *  has replied (both caps lift for the pair). */
	readonly perPair: number | null;
}

/**
 * Finding H layer 3: fan-in and per-sender rate limits, counted in one round
 * trip. ONE implementation for the durable handler (handlers/chat.ts) and the
 * fast-notify gate (fastNotifyGate.ts), so the fast path can never announce a
 * message the durable path refuses for these caps.
 *
 * Every chat_messages predicate is a `sender = … AND recipient = …` or
 * `recipient = … AND created_at > …` lookup, served by chat_messages_sender_idx
 * (sender, recipient, created_at) and chat_messages_recipient_idx (recipient,
 * created_at) — migration v66.
 *
 * The fan-in count EXCLUDES senders the recipient has blocked (security finding
 * S5): a Sybil burst that lands then gets blocked must not keep consuming the
 * recipient's fan-in budget for 24h, locking out new legitimate senders.
 */
export async function noReplyLimits(
	db: ChatGateDb,
	args: { recipient: string; sender: string; at: Date }
): Promise<NoReplyLimits> {
	const res = await db.query<{
		unique_fan_in: string; // BIGINT
		per_pair_count: string | null; // BIGINT, NULL when recipient has replied
	}>(
		`SELECT
		   (
		     SELECT COUNT(DISTINCT s)::bigint FROM (
		       SELECT sender AS s FROM chat_messages
		        WHERE recipient = $1
		          AND created_at > $3::timestamptz - INTERVAL '24 hours'
		       UNION
		       SELECT $2::text AS s
		     ) candidates
		     WHERE NOT EXISTS (
		       SELECT 1 FROM chat_messages r
		        WHERE r.sender = $1 AND r.recipient = candidates.s
		     )
		     AND NOT EXISTS (
		       SELECT 1 FROM blocks b
		        WHERE b.blocker = $1 AND b.blocked = candidates.s
		          AND b.state = 'blocked'
		     )
		   ) AS unique_fan_in,
		   CASE
		     WHEN EXISTS (
		       SELECT 1 FROM chat_messages
		        WHERE sender = $1 AND recipient = $2
		     ) THEN NULL
		     ELSE (
		       SELECT COUNT(*)::bigint FROM chat_messages
		        WHERE sender = $2 AND recipient = $1
		     )
		   END AS per_pair_count`,
		[args.recipient, args.sender, args.at]
	);
	const row = res.rows[0];
	const fanIn = Number(row?.unique_fan_in ?? 0);
	const perPair =
		row?.per_pair_count === null || row === undefined ? null : Number(row.per_pair_count);
	return {
		fanIn: Number.isFinite(fanIn) ? fanIn : 0,
		perPair: perPair === null || !Number.isFinite(perPair) ? null : perPair
	};
}

/** The refusal the caps give, or null. `perPair` is the count BEFORE this
 *  message: refused when accepting it would go past the cap. */
export function noReplyLimitRefusal(
	l: NoReplyLimits
): 'recipient_fan_in_exceeded' | 'sender_no_reply_cap_exceeded' | null {
	if (l.fanIn > FAN_IN_UNIQUE_SENDERS_24H) return 'recipient_fan_in_exceeded';
	if (l.perPair !== null && l.perPair >= PER_PAIR_NO_REPLY_CAP)
		return 'sender_no_reply_cap_exceeded';
	return null;
}
