/**
 * apps/indexer/src/indexer/chatPushEnqueue.ts
 *
 * shared chat Web Push enqueue, used by EVERY delivery route:
 *   • the DURABLE handler (chat.ts), ~irreversible;
 *   • the FAST head-block tailer (headTailer.ts: scanBlock, its rechecks and
 *     a parked first contact released by its fee);
 *   • a verified federation push and a local delivery
 *     (chatFastFederation.deliverVerifiedPush through
 *     federationChatFast.gatesFromDb, and a parked first contact released
 *     there).
 *
 * All set `source_trx_id` = the on-chain trx id; the partial UNIQUE
 * (account, source_trx_id) index (migration v43) makes every later insert a
 * no-op, so the recipient gets EXACTLY ONE notification — from whichever fast
 * route got there first, with the durable path as the reliable fallback for
 * any message no fast route delivered.
 *
 * SAFETY — BLOCK GATE. The CALLER must already have enforced the block list;
 * a blocked sender must NEVER reach here. Every call site does:
 *   • chat.ts drops "recipient blocked sender" (chat.DROP.blocked) before the
 *     enqueue;
 *   • headTailer.scanBlock and its recheck run recipientBlockedSender BEFORE
 *     emitting;
 *   • deliverVerifiedPush runs gates.recipientBlockedSender first.
 * This function does NOT re-check — it trusts that gate. The smoke
 * `chat-fast-notification-smoke` pins the durable and head-tailer call sites
 * so the gate can't be refactored out from under the enqueue.
 *
 * PRIVACY. Content is metadata-only: the title/body name the sender, never
 * the plaintext (which the indexer cannot read — chat is E2EE on chain).
 *
 * The Web Push part is a no-op when the recipient has no push subscription;
 * the offline-notice queue (offlineNoticeEnqueue.ts) is filled first, either way.
 */
import type pg from 'pg';
import { logger } from '$log';
import { localize, normalizeLocale } from '$indexer/pushLocalize';
import { enqueueOfflineNotice } from '$indexer/offlineNoticeEnqueue';
import { hasRecentOutboundChat } from '$indexer/recentOutboundChat';

const log = logger('chat-push-enqueue');

/** The minimal db surface both `Database` (pool.ts) and `pg.PoolClient`
 *  satisfy, so either path can call this with what it already holds. */
export interface ChatPushDb {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pg.QueryResult<R>>;
}

export interface ChatPushParams {
	/** Account the push targets (the message recipient). */
	readonly recipient: string;
	/** `db` is a client inside an open transaction (the durable handler's
	 *  block transaction): the offline-notice insert then gets a savepoint of
	 *  its own, so its failure cannot abort the transaction under the push. */
	readonly inTransaction?: boolean;
	/** The message sender — named in the notification body, and the chat peer
	 *  the click-through opens the conversation with. */
	readonly sender: string;
	/** The order this message is tagged with, or null. Non-null → an ORDER
	 *  signal (order title/body + deep-link to the order-scoped chat).
	 *  treats ANY present tag as an order signal in BOTH directions, matching
	 *  the fast path (which cannot cheaply re-derive order ownership). */
	readonly orderPermlink: string | null;
	/** The on-chain trx id — the dedup key shared by the fast + durable
	 *  enqueues of the SAME message. */
	readonly sourceTrxId: string;
	/** Block timestamp of the source op (push `event_at`). */
	readonly eventAt: Date;
}

/**
 * Until the recipient has written to the sender (a stored message, or a reply
 * this instance just relayed — recentOutboundChat), the sender's messages earn
 * ONE notification per NO_REPLY_PUSH_WINDOW_MS. A prior message from the same
 * sender inside the window (stored by the durable path) or a prior push for
 * the sender's thread (queued by any route; the relay keeps chat tombstones
 * for the whole window) counts. The messages are still delivered; only the
 * pushes are capped.
 *
 * What this does NOT bound is the number of senders. The durable handler's
 * fan-in cap admits at most 20 new unanswered senders a day per recipient
 * (order-contact bypass included), up to 50 unanswered messages each — so its
 * STORED messages earn at most 20 pushes a day. But a fast route pushes before
 * the durable handler has run, and the fast gate does not apply the fan-in cap
 * (fastNotifyBudget.ts: it meters per pair, not fan-in), so a 21st sender
 * writing about the recipient's live order still gets a push for a message
 * the durable path then refuses. Each such sender earns one push a day; the
 * number of senders is bounded only by what accounts cost.
 */
export const NO_REPLY_PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Is this sender still in the one-push-per-day-until-reply window?
 *
 * v1.21.14 (full chat audit):
 *   - S-M1: "has the recipient replied?" read only the DURABLE table, 45-63 s
 *     behind. A seller who had just answered a buyer through this instance got
 *     no notification for the buyer's next message. This instance's own relay
 *     log of the recipient's reply (recentOutboundChat) now counts too — the
 *     same first-hand record the fast gate trusts.
 *   - S-M2: an earlier push was matched by `LIKE '%/chat/<sender>%'`, so a push
 *     from "bobby" silenced the first message from "bob". The thread path is
 *     now matched exactly (`…/chat/<sender>` or `…/chat/<sender>?…`).
 *   - S-M3: chat tombstones are kept for the whole window (the relay prunes
 *     them after NO_REPLY_PUSH_WINDOW_MS, see pushQueueJanitor), so the cap
 *     lasts a day for messages that never reach the chain too, not an hour.
 */
async function quietUntilReply(db: ChatPushDb, p: ChatPushParams): Promise<boolean> {
	if (hasRecentOutboundChat(p.recipient, p.sender)) return false;
	const since = new Date(p.eventAt.getTime() - NO_REPLY_PUSH_WINDOW_MS);
	const r = await db.query<{ quiet: boolean }>(
		`SELECT NOT EXISTS (
		          SELECT 1 FROM chat_messages WHERE sender = $1 AND recipient = $2
		        )
		    AND (EXISTS (
		          SELECT 1 FROM chat_messages
		           WHERE sender = $2 AND recipient = $1
		             AND created_at > $3 AND created_at <= $4
		             AND source_trx_id IS DISTINCT FROM $5
		        )
		     OR EXISTS (
		          SELECT 1 FROM push_pending
		           WHERE account = $1 AND event_at > $3
		             AND (click_path LIKE '%/chat/' || $2
		                  OR click_path LIKE '%/chat/' || $2 || '?%')
		             AND source_trx_id IS DISTINCT FROM $5
		        )) AS quiet`,
		[p.recipient, p.sender, since, p.eventAt, p.sourceTrxId]
	);
	return r.rows[0]?.quiet === true;
}

/**
 * Enqueue a chat Web Push, dedup-keyed on the on-chain trx id. Non-fatal:
 * a failure is logged and swallowed (the message is already stored/emitted).
 */
export async function enqueueChatPush(db: ChatPushDb, params: ChatPushParams): Promise<void> {
	try {
		// Never notify someone about their own message (defensive — the durable
		// handler already rejects self-chat long before it would reach here; the
		// fast tailer does not pre-filter it).
		if (params.recipient === params.sender) return;
		// Settings → Offline Notifications: queued whether or not this account
		// has a browser subscribed (it is for when she is away from every
		// browser). Behind the same block-list gate as the push.
		await enqueueOfflineNotice(
			db,
			{
				recipient: params.recipient,
				sender: params.sender,
				orderPermlink: params.orderPermlink,
				eventAt: params.eventAt
			},
			new Date(),
			{ inTransaction: params.inTransaction === true }
		);
		const localeRow = await db.query<{ locale: string }>(
			`SELECT locale FROM push_subscriptions
			  WHERE account = $1
			  ORDER BY created_at DESC
			  LIMIT 1`,
			[params.recipient]
		);
		// Skip enqueue when the recipient has no push subscription at all.
		if (localeRow.rowCount === 0) return;
		if (await quietUntilReply(db, params)) return;

		const locale = normalizeLocale(localeRow.rows[0]?.locale);
		const isOrderSignal =
			typeof params.orderPermlink === 'string' && params.orderPermlink.length > 0;
		const category = isOrderSignal ? 'order' : 'chat';
		// Both deep-link to the thread with the sender; the order signal adds the
		// ?order scope. Localized; the [lang] segment + the ?order query survive
		// sanitizeClickPath (same-origin pathname + search). Guarded by
		// handler-push-click-path-route-smoke.
		//
		// v1.7.5 — plain chat used to point at `/${locale}/chat` (the LIST), and
		// that one missing path segment was half of the ~1-minute dark badge.
		// The service worker recovers the thread for the in-page fast badge by
		// PARSING this path (`chatThreadFromClickPath` reads `…/chat/<peer>`), so
		// a path with no peer means the SW posts CHAT_PUSH with no peer, the page's
		// `if (data.peer)` guard fails, and neither the archived-thread resurrect
		// nor `emitFastPush` ever runs — leaving the badge dark until the durable
		// poll catches up ~60s later. Naming the peer here is also just better:
		// tapping a chat notification now opens the conversation instead of the
		// list. `/[lang]/chat/[peer=account]` handles a null-order thread already.
		const clickPath = isOrderSignal
			? `/${locale}/chat/${params.sender}?order=${params.orderPermlink}`
			: `/${locale}/chat/${params.sender}`;
		const title = isOrderSignal ? localize(locale, 'order_title') : localize(locale, 'chat_title');
		const body = isOrderSignal
			? localize(locale, 'order_body', params.sender)
			: localize(locale, 'chat_body', params.sender);
		// dedup tag: order signals share the in-page trade tag so the
		// browser collapses the push and its in-page twin; plain chat has no
		// in-page twin → NULL (the sender falls back to the queue-row id).
		const notificationId = isOrderSignal ? `morphit-trade-${params.orderPermlink}` : null;

		// source_trx_id + ON CONFLICT (matching the v43 partial unique index)
		// is the whole dedup: whichever path inserts first wins; the other is a
		// no-op, so the recipient gets exactly one push.
		await db.query(
			`INSERT INTO push_pending
			   (account, category, title, body, click_path, event_at, notification_id, source_trx_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 ON CONFLICT (account, source_trx_id) WHERE source_trx_id IS NOT NULL DO NOTHING`,
			[
				params.recipient,
				category,
				title,
				body,
				clickPath,
				params.eventAt,
				notificationId,
				params.sourceTrxId
			]
		);
	} catch (err) {
		// No account names in the log (v1.21.14 full chat audit, S-L6).
		log.warn('push_enqueue_failed', { err: String((err as Error)?.message ?? err) });
	}
}
