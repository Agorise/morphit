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
import { localize, normalizeLocale } from '$indexer/pushLocalize';

const log = logger('chat');

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
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) {
		return { ok: false, reason: 'ciphertext_not_base64' };
	}

	if (!isPlainObject(ctx.payload.header)) {
		return { ok: false, reason: 'header_not_object' };
	}
	const headerSize = checkJsonbSize(ctx.payload.header);
	if (!headerSize.ok) {
		return { ok: false, reason: 'header_too_large' };
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
		const orderCheck = await client.query<{ exists: boolean }>(
			`SELECT EXISTS (
			   SELECT 1 FROM orders
			    WHERE account = $1 AND permlink = $2
			      AND status = 'live'
			      AND (expires_at IS NULL OR expires_at > $3)
			 ) AS exists`,
			[recipient, claimedPermlink, ctx.blockTime]
		);
		if (!orderCheck.rows[0]?.exists) {
			// Either the order doesn't exist at all, or it was
			// cancelled, or its expires_at has passed.  In all
			// cases reject — "consent to be contacted about this
			// order" ends when the order is withdrawn or expired.
			// The user can still pay the stranger fee to message
			// the recipient about something else.
			//
			// BATCH19A-chat-1 (2026-05-02 audit): the previous
			// version of this query did not filter by status,
			// which meant a cancelled/expired order's permlink
			// could be replayed indefinitely by stalkers to
			// bypass the stranger-fee gate.  Block-list and
			// rate-limit (layers 1+3) caught the abuse
			// downstream, but the bypass itself was a real
			// budget escalation.
			//
			// BATCH19A-order-2 follow-on: also filter by
			// expires_at because no sweep job currently flips
			// status='live' → 'expired' when expires_at passes,
			// and a status-only filter would still admit
			// past-expires_at orders.
			return { ok: false, reason: 'order_permlink_not_found' };
		}
		// Order is real and is owned by the message recipient.
		// Bypass the stranger-fee gate below for this message.
		// We do NOT bypass the block list (already enforced
		// above) and we do NOT bypass the rate limits (still
		// evaluated below).
		orderResponseBypass = true;
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
			return { ok: false, reason: 'stranger_fee_required' };
		}
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
			return { ok: false, reason: 'recipient_fan_in_exceeded' };
		}
		if (row.per_pair_count !== null) {
			const perPair = Number(row.per_pair_count);
			// perPair is the count BEFORE this new message. We
			// reject when accepting this would push the count
			// past the cap — i.e. when already ≥ cap.
			if (Number.isFinite(perPair) && perPair >= PER_PAIR_NO_REPLY_CAP) {
				return { ok: false, reason: 'sender_no_reply_cap_exceeded' };
			}
		}
	}

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
				// Store ONLY when the field validated above; null
				// otherwise.  We re-use `claimedPermlink` (the
				// sender's claim) rather than re-deriving — the
				// validator either rejected or set
				// `orderResponseBypass`, so by this point we know
				// the value, if non-null, points to a real order
				// owned by `recipient`.
				orderResponseBypass ? (claimedPermlink as string) : null
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
		const isOrderSignal = orderResponseBypass === true && typeof claimedPermlink === 'string';
		const pushCategory = isOrderSignal ? 'order' : 'chat';
		// Click-through targets:
		//   - order signal: canonical order URL is /{account}/{permlink}
		//     per apps/web/src/routes/[lang]/[x+40][account=account]/
		//     [permlink=permlink]/+page.svelte (SEO-routes spec line ~198).
		//     The locale prefix is added on the client side by the
		//     SvelteKit router resolving the user's `[lang]` segment;
		//     we emit the locale-less canonical here.
		//   - plain chat: /chat is the chat-list landing
		//     (apps/web/src/routes/[lang]/chat/+page.svelte).
		//
		// Both flow through sanitizeClickPath in the service worker
		// (cp81-D22b) before clients.openWindow() is called, so any
		// malformed path falls back to '/' safely.
		//
		// cp82-B1 audit: prior version emitted `/order/${recipient}/
		// ${permlink}` which had no matching route; the SW gate
		// sanitized the cross-origin risk but the user landed on a
		// 404.  Fixed to the canonical SEO-routes pattern.
		const pushClickPath =
			isOrderSignal && typeof claimedPermlink === 'string'
				? `/${recipient}/${claimedPermlink}`
				: '/chat';
		try {
			const localeRow = await client.query<{ locale: string }>(
				`SELECT locale FROM push_subscriptions
				  WHERE account = $1
				  ORDER BY created_at DESC
				  LIMIT 1`,
				[recipient]
			);
			// DD-meta-cp1718-1: skip enqueue when no push
			// subscription exists.  See feedback.ts + featureBid.ts
			// for the same guard.
			if (localeRow.rowCount === 0) {
				// no-op; user has no push subs.
			} else {
				const locale = normalizeLocale(localeRow.rows[0]?.locale);
				const titleStr = isOrderSignal
					? localize(locale, 'order_title')
					: localize(locale, 'chat_title');
				const bodyStr = isOrderSignal
					? localize(locale, 'order_body', ctx.signer)
					: localize(locale, 'chat_body', ctx.signer);
				await client.query(
					`INSERT INTO push_pending
					   (account, category, title, body, click_path, event_at)
					 VALUES ($1, $2, $3, $4, $5, $6)`,
					[recipient, pushCategory, titleStr, bodyStr, pushClickPath, ctx.blockTime]
				);
			}
		} catch (err) {
			log.warn('push_enqueue_failed', {
				recipient,
				err: String((err as Error)?.message ?? err)
			});
		}
	} catch (err) {
		if (isUniqueViolation(err)) {
			return { ok: false, reason: 'duplicate_message' };
		}
		throw err;
	}

	return { ok: true };
};

export default handle;
