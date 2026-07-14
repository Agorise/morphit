/**
 * Handler: morphit_chat_v1
 *
 * Payload shape:
 *   {
 *     "recipient": string (blurt account name),
 *     "ciphertext": string (base64 opaque, 1..65536 bytes),
 *     "header": object (ECIES envelope header — ephemeral_pub,
 *               nonce, client_tag; opaque to indexer; see ADR-0015),
 *     "order_permlink"?: string (optional plaintext — when the
 *               sender is responding to a specific order the
 *               recipient has posted, naming it here bypasses
 *               the stranger-fee gate; see Q11 below)
 *   }
 *
 * Effect: record one chat message keyed on (sender, recipient,
 * source_trx_id). The indexer stores ciphertext unchanged —
 * only the two participants can decrypt with their X25519
 * chat-identity keys (deterministically derived from each
 * participant's posting key per ADR-0015).
 *
 * The indexer does NOT attempt to read or index the message
 * content. That would be both useless (it's encrypted) and a
 * privacy violation of the E2EE guarantee.
 *
 * Anti-spam gates (Finding H triad, all three layers shipped;
 * Q11 added an order-response bypass on layer 2):
 *
 * Layer 1 — block list. Before persisting a message, the
 * handler consults the `blocks` table. If the recipient has
 * previously posted a morphit_block_v1 op against the sender,
 * the message is rejected with `recipient_blocked_sender` and
 * NOT stored. The ciphertext is still public on-chain (anyone
 * scraping Blurt can see it) but Morphit's indexer won't serve
 * it to anyone — the blocked user never sees the message in
 * their inbox.  Block list is NEVER bypassed.
 *
 * Layer 2 — stranger-fee admission. First-contact messages
 * require either a prior exchange (recipient has replied, or
 * sender has a prior admitted message) or a paid
 * stranger-fee on file via morphit_stranger_fee_v1. Reject
 * reason: `stranger_fee_required`. Condition set is broad
 * enough to avoid breaking pairs who are already talking when
 * the gate first lands.
 *
 *   Q11 bypass: when the message payload carries a valid
 *   `order_permlink` field naming a real order owned by the
 *   recipient, the layer-2 gate is skipped.  Rationale:
 *   posting an order is consent to be contacted about it.
 *   The orderbook's "Message" CTA is a published, intentional
 *   invitation to reach out; charging a fee for accepting
 *   that invitation would be hostile UX.  Validation is
 *   strict: a malformed permlink (`order_permlink_bad_chars`)
 *   or one that doesn't exist / isn't owned by the recipient
 *   (`order_permlink_not_found`) rejects the entire message
 *   rather than falling back to the gate — better to surface
 *   the mismatch so the client can correct than to silently
 *   demand a fee.
 *
 * Layer 3 — rate limits. Two complementary caps, both gated on
 * "recipient has not replied":
 *   - recipient_fan_in_exceeded: > 20 unique new senders
 *     messaging this recipient in the last 24h with no reply.
 *   - sender_no_reply_cap_exceeded: > 50 messages from the same
 *     sender to this recipient with no reply, ever.
 * One reply from the recipient to the sender lifts both caps
 * for that pair forever. The values are deliberately permissive
 * — they catch flood-scale abuse, not routine usage.  Layer 3
 * is NOT bypassed by order_permlink — an attacker enumerating
 * active orders to send one unsolicited message per order is
 * still capped by the per-recipient fan-in budget.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { checkJsonbSize } from '$indexer/payloadSize';
import { validateChatOrderPermlink } from '$indexer/permlink';
import { logger } from '$log';
import { checkChatOrder } from '$indexer/chatGates';
import { enqueueChatPush } from '$indexer/chatPushEnqueue';

const log = logger('chat');

/** Opt-in per-message delivery tracing. OFF by default; enable with
 *  MORPHIT_CHAT_DEBUG=1 in the indexer's env, then read via
 *  `sudo docker logs <indexer-container>`. Logs METADATA ONLY (never
 *  ciphertext): sender, recipient, order_permlink, and the exact
 *  admission decision, so an operator can see precisely why a given
 *  message was persisted or dropped. */
const CHAT_DEBUG = process.env.MORPHIT_CHAT_DEBUG === '1';
function chatDbg(event: string, data: Record<string, unknown>): void {
	if (CHAT_DEBUG) log.info(event, data);
}

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
/** Hard cap on ciphertext envelope size.
 *
 *  UX budget: chat messages are capped at 256 code points of
 *  plaintext (enforced in the compose UI). Worst-case
 *  expansion is all-4-byte-codepoint emoji plaintext:
 *    256 codepoints × 4 bytes/cp = 1024 plaintext bytes
 *    + 16-byte ChaCha20-Poly1305 tag = 1040 ciphertext bytes
 *    base64-encoded ≈ 1388 chars
 *
 *  We cap at 1536 — comfortably absorbs the worst-case 1388
 *  plus headroom for any future protocol addition (extra MAC,
 *  envelope field). A ciphertext > 1536 chars is either a bug
 *  or an attempt to smuggle more data than the product is
 *  designed for. We reject here.
 *
 *  History: previously 1024, which was set with bad math —
 *  a 256-codepoint emoji-heavy message could be rejected
 *  even though the composer accepted it. Discovered during
 *  the chat audit. */
const MAX_CIPHERTEXT_CHARS = 1536;

/** Base64 well-formedness: multiple-of-4 length, at most 2 trailing '='.
 *  Shared by the main ciphertext and the cp406 self-copy checks. */
const CHAT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Finding H layer 3 — per-recipient rate limits to deter
 *  coordinated spam. Two rules, both evaluated BEFORE INSERT so
 *  blocked messages never touch chat_messages.
 *
 *  Both rules have a "without a reply" escape hatch: once the
 *  recipient has sent anything back to the sender, the
 *  relationship is presumed-consensual and neither limit
 *  applies going forward. That's the design contract — a real
 *  conversation partner isn't throttled, only strangers whom
 *  the recipient has not engaged with.
 *
 *  Values tuned permissively. The goal is to catch flood-scale
 *  abuse (sybil fans, spam-bot runs), not to throttle normal
 *  chat usage. A legitimate user asking a question, getting no
 *  reply, and following up once or twice is well within these
 *  budgets. */

/** Max unique new senders (i.e. senders the recipient has not
 *  replied to) allowed in a rolling 24h window per recipient. */
const FAN_IN_UNIQUE_SENDERS_24H = 20;

/** Max messages a single sender can send to a single recipient
 *  who has not replied, over ALL time. Once the recipient
 *  replies once, this cap lifts. */
const PER_PAIR_NO_REPLY_CAP = 50;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: unknown }).code === '23505'
	);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) return { ok: false, reason: 'payload_not_object' };

	const recipient = ctx.payload.recipient;
	if (typeof recipient !== 'string' || !ACCOUNT_NAME_RE.test(recipient)) {
		return { ok: false, reason: 'recipient_invalid' };
	}
	if (recipient === ctx.signer) return { ok: false, reason: 'self_chat' };

	const ciphertext = ctx.payload.ciphertext;
	if (typeof ciphertext !== 'string') return { ok: false, reason: 'ciphertext_not_string' };
	if (ciphertext.length < 1) return { ok: false, reason: 'ciphertext_empty' };
	if (ciphertext.length > MAX_CIPHERTEXT_CHARS) {
		return { ok: false, reason: 'ciphertext_too_long' };
	}
	// Basic base64 sanity — full RFC validation not worth the cost;
	// the DR decrypt on the recipient's side will fail loudly on
	// malformed input.  The regex enforces:
	//   - charset is base64 (A-Z a-z 0-9 + /)
	//   - length is a multiple of 4 (real base64 always is)
	//   - at most 2 trailing '=' padding chars (real base64
	//     never has more — `'a===='` is malformed even though the
	//     character set is fine).
	// Rejecting at intake keeps demonstrably-malformed ciphertext
	// out of the DB; legitimate clients always produce conformant
	// output.
	if (!CHAT_BASE64_RE.test(ciphertext)) {
		return { ok: false, reason: 'ciphertext_not_base64' };
	}

	if (!isPlainObject(ctx.payload.header)) {
		return { ok: false, reason: 'header_not_object' };
	}
	const headerSize = checkJsonbSize(ctx.payload.header);
	if (!headerSize.ok) {
		return { ok: false, reason: 'header_too_large' };
	}

	// cp406 — OPTIONAL sender self-copy (ChatEnvelopeWire.selfCiphertext): a
	// second ciphertext of the SAME plaintext, decryptable only by the sender,
	// so they can reread their own history from chain (keep-history mode). It
	// lives in the otherwise-opaque header, but we bound it EXACTLY like the
	// main ciphertext so it can't smuggle past the 256-codepoint message budget
	// or bloat the chain. self_ciphertext and self_nonce are a pair — both
	// present or both absent. (PFS "destroy" mode simply omits both.)
	const hdr = ctx.payload.header as Record<string, unknown>;
	const selfCiphertext = hdr.self_ciphertext;
	const selfNonce = hdr.self_nonce;
	if ((selfCiphertext !== undefined) !== (selfNonce !== undefined)) {
		return { ok: false, reason: 'self_copy_incomplete' };
	}
	if (selfCiphertext !== undefined) {
		if (typeof selfCiphertext !== 'string' || typeof selfNonce !== 'string') {
			return { ok: false, reason: 'self_copy_not_string' };
		}
		if (selfCiphertext.length < 1 || selfCiphertext.length > MAX_CIPHERTEXT_CHARS) {
			return { ok: false, reason: 'self_ciphertext_too_long' };
		}
		if (!CHAT_BASE64_RE.test(selfCiphertext) || !CHAT_BASE64_RE.test(selfNonce)) {
			return { ok: false, reason: 'self_copy_not_base64' };
		}
	}

	// Finding H layer 1: block list. If the recipient has blocked
	// the sender, reject without persisting the ciphertext. The
	// query hits the `blocks` table's primary key (blocker,
	// blocked) so it's O(1) — cheaper than the INSERT we'd skip.
	// Uses `state = 'blocked'` to ignore unblocked rows (kept for
	// audit; those represent a user who chose to reverse).
	//
	// Block-check fires FIRST, before any Q11 order_permlink
	// validation, because block is the strongest gate and must
	// short-circuit everything else.  A blocked sender cannot
	// invoke the order-response bypass to push through.
	const blockCheck = await client.query<{ exists: boolean }>(
		`SELECT EXISTS (
		   SELECT 1 FROM blocks
		    WHERE blocker = $1 AND blocked = $2 AND state = 'blocked'
		 ) AS exists`,
		[recipient, ctx.signer]
	);
	if (blockCheck.rows[0]?.exists) {
		chatDbg('chat.DROP.blocked', { sender: ctx.signer, recipient });
		return { ok: false, reason: 'recipient_blocked_sender' };
	}

	// Optional plaintext `order_permlink` field — Q11.  When the
	// sender is responding to a specific order the recipient has
	// posted, they include the order's permlink here.  The
	// indexer uses this to bypass the stranger-fee gate ONLY: a
	// posted order is consent to be contacted about it, so the
	// fee shouldn't apply.  Block list (above) and rate limits
	// (below) still apply unconditionally.
	//
	// Validation rules (must all pass when the field is present):
	//   1. Must be a string matching the order-permlink regex.
	//      Anything else -> reject the whole message with
	//      `order_permlink_bad_chars` so a malformed claim can't
	//      slip through.  The same regex shape that order.ts
	//      enforces (lowercase alphanum + dashes, 3..256 chars).
	//   2. The named order must exist in the indexer's `orders`
	//      table AND be owned by the message recipient.  We do
	//      this DB lookup unconditionally when the field is set;
	//      a 404-equivalent (no row) -> reject with
	//      `order_permlink_not_found`, NOT a fall-through to the
	//      gate.  Reason: a sender who claimed a permlink and
	//      then is silently treated as a stranger would be
	//      confusing.  Better to surface "your claimed order
	//      does not exist" so the client can correct.
	//   3. The field is plaintext on chain.  A passive observer
	//      can see "user A messaged user B about user B's order
	//      X" — but they can already see this from public chain
	//      reads (the order op IS public; the chat's chain
	//      transaction is also public).  No new metadata leaks.
	let orderResponseBypass = false;
	const claimedPermlink = ctx.payload.order_permlink;
	if (claimedPermlink !== undefined && claimedPermlink !== null) {
		const permlinkFail = validateChatOrderPermlink(claimedPermlink);
		if (permlinkFail) return { ok: false, reason: permlinkFail };
		// cp446 — `order_permlink` does TWO jobs, and conflating them was a bug.
		//
		//   1. THREAD TAG. The inbox groups conversations by (peer, order), like an
		//      email inbox, and the transcript is scoped to one thread. Every
		//      message in a discussion must carry the tag, INCLUDING the order
		//      owner's replies and everything said after the order is cancelled.
		//
		//   2. STRANGER-FEE BYPASS PROOF. "A posted order is consent to be
		//      contacted about it" — but only while it is actually posted, and only
		//      for the person who posted it.
		//
		// The old code granted (1) and (2) together, or rejected the message
		// outright. That meant the ORDER OWNER could not reply in their own thread
		// (they are not the recipient of their own order), and nobody could speak
		// in a thread once the order was cancelled or expired — which is precisely
		// the "(Cancelled)" thread the inbox now shows.
		//
		// So: the tag is kept whenever the permlink names a real order belonging to
		// ONE OF THE TWO PARTIES (a client can never tag a stranger's order, or
		// invent one). The BYPASS is granted on exactly the conditions it always
		// was — recipient owns it, status='live', not past expires_at. A stranger
		// citing a cancelled order therefore still gets no bypass and still falls
		// to the stranger-fee gate below; only people who were already allowed to
		// talk to each other gain anything here.
		const orderCheck = await checkChatOrder(client, {
			// validateChatOrderPermlink above already rejected any non-string.
			permlink: claimedPermlink as string,
			recipient,
			signer: ctx.signer,
			blockTime: ctx.blockTime
		});
		if (!orderCheck.found) {
			// The permlink names no order owned by either party: it is either
			// invented or points at a third party's listing. Reject, exactly as
			// before — a tag must never be a free-text field on chain.
			//
			// BATCH19A-chat-1 (2026-05-02 audit): the pre-cp440 query did not filter
			// by status, so a cancelled order's permlink could be replayed
			// indefinitely to bypass the stranger-fee gate. That filter now lives on
			// the BYPASS decision below, where it belongs, and the gate itself is
			// unchanged: a stranger with a cancelled permlink is still stopped.
			return { ok: false, reason: 'order_permlink_not_found' };
		}
		// Bypass ONLY when the recipient owns a live, unexpired order. Identical to
		// the previous condition — deliberately so.
		// cp471: the order-tag query + this bypass are now the shared
		// `checkChatOrder` (chatGates.ts) so the fast notification path
		// evaluates order validity identically. Bypass ONLY when the
		// recipient owns a live, unexpired order — deliberately unchanged.
		orderResponseBypass = orderCheck.ownedByRecipient && orderCheck.live;
		chatDbg('chat.orderCheck', {
			sender: ctx.signer,
			recipient,
			claimedPermlink,
			ownerIsRecipient: orderCheck.ownedByRecipient,
			orderLive: orderCheck.live,
			bypass: orderResponseBypass
		});
	}

	// Finding H layer 2: stranger-fee gate. First-contact
	// messages require either a prior exchange (recipient has
	// replied, or sender has a prior admitted message) or a
	// paid stranger-fee on file for the pair. The three
	// admission conditions are evaluated in one round-trip;
	// any of them passing is enough.
	//
	// Why three conditions:
	//   1. recipient → sender ever: proves the pair is a
	//      real conversation (recipient actively engaged).
	//   2. sender → recipient prior admitted message: the
	//      sender has already successfully admitted (either
	//      by paying, being pre-existing, or slipping through
	//      before layer 2 landed). Don't retro-gate them.
	//   3. stranger_fees row: the sender paid the fee for
	//      this recipient.
	//
	// Condition 2 makes the gate compatible with the deploy
	// path: when layer 2 first ships, pairs that already have
	// an in-flight conversation stay unbroken — the sender's
	// prior message satisfies condition 2, and the next
	// message through goes in fine.
	//
	// Q11 bypass: when `orderResponseBypass` was set above (the
	// message carried a valid order_permlink naming a real
	// order owned by the recipient), we skip the stranger-fee
	// query entirely.  Posting an order is consent to be
	// contacted about it; charging a stranger fee for that
	// response would be hostile UX.  The block list is already
	// enforced above this point and is NOT bypassed; the rate
	// limits below ARE still evaluated so an attacker can't
	// enumerate active orders to amplify their spam budget.
	//
	// BATCH14-1 audit clarification: the bypass shaves the
	// per-sender stranger fee but does NOT change the per-
	// recipient ceiling.  The fan-in cap (FAN_IN_UNIQUE_SENDERS_24H
	// = 20 unique new senders per recipient per 24h with no
	// reply) and the per-pair cap (PER_PAIR_NO_REPLY_CAP = 50
	// messages per (sender, recipient) pair with no reply)
	// apply uniformly regardless of whether each individual
	// message used the bypass.  An attacker spawning sock
	// accounts to abuse the bypass therefore tops out at 20
	// distinct sock accounts per victim per 24h before the
	// rate limit shuts the spam down.  The cost of 20 sock
	// accounts (~$4 in account-creation fees) is weighed
	// against the marginal spam value; the economics still
	// favor the defender.  See the Part 14 audit (Q11 STRIDE
	// + attack tree analysis) for the full reasoning.
	if (!orderResponseBypass) {
		const admitCheck = await client.query<{ admitted: boolean }>(
			`SELECT EXISTS (
			   SELECT 1 FROM chat_messages
			    WHERE (sender = $1 AND recipient = $2)  -- recipient→sender reply
			       OR (sender = $2 AND recipient = $1)  -- sender→recipient prior
			 ) OR EXISTS (
			   SELECT 1 FROM stranger_fees
			    WHERE sender = $2 AND recipient = $1
			 ) AS admitted`,
			[recipient, ctx.signer]
		);
		if (!admitCheck.rows[0]?.admitted) {
			chatDbg('chat.DROP.strangerGate', { sender: ctx.signer, recipient });
			return { ok: false, reason: 'stranger_fee_required' };
		}
		chatDbg('chat.admit.strangerGatePassed', { sender: ctx.signer, recipient });
	}

	// Finding H layer 3: fan-in and per-sender rate limits.
	// Both limits ONLY apply when the recipient has not yet
	// replied to the sender. One reply lifts both caps for the
	// pair forever.
	//
	// Computed in a single round-trip. Postgres evaluates both
	// expressions against the chat_messages_recipient_idx /
	// chat_messages_sender_idx composites with little overhead.
	// At production scale (millions of messages) we'd revisit
	// with a materialized counter table, but at Morphit's
	// current scale this is cheap.
	//
	// The fan-in subquery EXCLUDES senders the recipient has
	// blocked (security finding S5). Without that exclusion, a
	// Sybil burst that lands then gets blocked still consumes
	// the recipient's fan-in budget for 24h, locking out new
	// legitimate senders during the rolling window. Excluding
	// blocked rows means the cap reflects "potentially-
	// legitimate new conversations" rather than "any new
	// conversations including ones already shut down." The
	// blocks-table lookup is a primary-key hit (blocker,
	// blocked), so the cost is negligible.
	const limits = await client.query<{
		unique_fan_in: string; // BIGINT
		per_pair_count: string | null; // BIGINT, NULL when recipient has replied
	}>(
		`SELECT
		   (
		     -- Count distinct senders (incl. this one) in the last
		     -- 24h whom the recipient has never replied to AND has
		     -- not blocked.
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
		[recipient, ctx.signer, ctx.blockTime]
	);
	const row = limits.rows[0];
	if (row) {
		const fanIn = Number(row.unique_fan_in);
		if (Number.isFinite(fanIn) && fanIn > FAN_IN_UNIQUE_SENDERS_24H) {
			chatDbg('chat.DROP.fanIn', { sender: ctx.signer, recipient, fanIn });
			return { ok: false, reason: 'recipient_fan_in_exceeded' };
		}
		if (row.per_pair_count !== null) {
			const perPair = Number(row.per_pair_count);
			// perPair is the count BEFORE this new message. We
			// reject when accepting this would push the count
			// past the cap — i.e. when already ≥ cap.
			if (Number.isFinite(perPair) && perPair >= PER_PAIR_NO_REPLY_CAP) {
				chatDbg('chat.DROP.perPairCap', { sender: ctx.signer, recipient, perPair });
				return { ok: false, reason: 'sender_no_reply_cap_exceeded' };
			}
		}
	}
	chatDbg('chat.ADMITTED', {
		sender: ctx.signer,
		recipient,
		order: claimedPermlink ?? null,
		bypass: orderResponseBypass
	});

	try {
		const insertRes = await client.query<{ id: string }>(
			`INSERT INTO chat_messages (
				sender, recipient, ciphertext, header, created_at, source_trx_id, order_permlink
			) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
			RETURNING id::text`,
			[
				ctx.signer,
				recipient,
				ciphertext,
				headerSize.serialized,
				ctx.blockTime,
				ctx.trxId,
				// Store the tag whenever `claimedPermlink` survived the
				// validation above. By this point a non-null value has been
				// confirmed to name a real order owned by ONE OF THE TWO
				// PARTIES (orderCheck's `account IN (recipient, signer)`,
				// line 307) — so it is a legitimate thread tag for THIS
				// conversation no matter which party owns the order.
				// `orderResponseBypass` stays narrow: it governs ONLY the
				// stranger-fee gate (recipient owns a live, unexpired order).
				// It must NOT gate storage — doing so stripped the order
				// OWNER's own replies of their tag, splitting the thread into
				// a phantom null "RE: -" card the other party never sees.
				//
				// >>> THREADING MODEL INV-5 (server tag point). Read
				// >>> docs/CHAT-THREADING-MODEL.md before touching this line.
				// >>> Guarded by chat-order-tag-storage-smoke (tamper-tested).
				claimedPermlink ?? null
			]
		);
		// Bus emit: canonical pair (lo, hi) so subscribers can
		// filter without a DB lookup.
		//
		// BATCH19A-chat-2: chat_messages.id is BIGSERIAL (BIGINT,
		// max 2^63), but we narrow to JS `number` here for the SSE
		// marker.  JS Number loses integer precision past 2^53,
		// which is academic at Morphit's scale (would take ~24,000
		// years at 1M messages/day).  The marker is opaque to
		// subscribers — they only use it to detect "this
		// conversation has new content" — so eventual precision
		// loss would degrade to a stale SSE notification, not data
		// corruption.  If we ever approach the limit (we won't),
		// migrate to a string-typed marker end-to-end.
		const inserted = insertRes.rows[0];
		if (inserted !== undefined) {
			const lo = ctx.signer < recipient ? ctx.signer : recipient;
			const hi = ctx.signer < recipient ? recipient : ctx.signer;
			ctx.recordChatChange({
				lo,
				hi,
				messageId: parseInt(inserted.id, 10)
			});
		}

		// ─── Web Push enqueue (Part 122 cp13; localized cp14) ──
		// Notify `recipient` of an inbound message.  When the
		// message carries a validated `order_permlink`, this is
		// a trade signal — route under category='order'.
		// Otherwise it's general chat traffic.
		//
		// Payload deliberately summary-only — never include the
		// plaintext.  Chat is E2EE on chain; the indexer doesn't
		// have the keys to decrypt anyway.  Non-fatal on enqueue
		// failure: the message is already stored.
		// cp471 — enqueue the chat Web Push through the shared, dedup-aware
		// helper (chatPushEnqueue.ts). source_trx_id = the on-chain trx id, so
		// this durable enqueue and the fast head-block enqueue collapse to
		// exactly ONE notification (fast when the tailer wins). Order signal =
		// a valid order tag is present (both directions). Non-fatal on failure.
		await enqueueChatPush(client, {
			recipient,
			sender: ctx.signer,
			orderPermlink: typeof claimedPermlink === 'string' ? claimedPermlink : null,
			sourceTrxId: ctx.trxId,
			eventAt: ctx.blockTime
		});
	} catch (err) {
		if (isUniqueViolation(err)) {
			return { ok: false, reason: 'duplicate_message' };
		}
		throw err;
	}

	return { ok: true };
};

export default handle;
