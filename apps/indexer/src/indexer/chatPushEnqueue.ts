/**
 * apps/indexer/src/indexer/chatPushEnqueue.ts
 *
 * cp471 — shared chat Web Push enqueue, used by BOTH delivery paths:
 *   • the DURABLE handler (chat.ts), ~irreversible, and
 *   • the FAST head-block tailer (headTailer.ts), ~5s after send.
 *
 * Both set `source_trx_id` = the on-chain trx id; the partial UNIQUE
 * (account, source_trx_id) index (migration v43) makes the SECOND insert a
 * no-op, so the recipient gets EXACTLY ONE notification — fast when the
 * tailer wins the race, with the durable path as the reliable fallback for
 * any message the head tailer skipped (bounded scan / reorg).
 *
 * SAFETY — BLOCK GATE. The CALLER must already have enforced the block list;
 * a blocked sender must NEVER reach here. Both call sites do:
 *   • chat.ts drops "recipient blocked sender" (chat.DROP.blocked) before the
 *     enqueue, and
 *   • headTailer.scanBlock runs recipientBlockedSender BEFORE emitting.
 * This function does NOT re-check — it trusts that gate. The smoke
 * `chat-fast-notification-smoke` pins BOTH call sites so the gate can't be
 * refactored out from under the enqueue.
 *
 * PRIVACY. Content is metadata-only: the title/body name the sender, never
 * the plaintext (which the indexer cannot read — chat is E2EE on chain).
 *
 * No-op when the recipient has no push subscription.
 */
import type pg from 'pg';
import { logger } from '$log';
import { localize, normalizeLocale } from '$indexer/pushLocalize';

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
	/** The message sender — named in the notification body, and the chat peer
	 *  the click-through opens the conversation with. */
	readonly sender: string;
	/** The order this message is tagged with, or null. Non-null → an ORDER
	 *  signal (order title/body + deep-link to the order-scoped chat). cp471
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
 * Enqueue a chat Web Push, dedup-keyed on the on-chain trx id. Non-fatal:
 * a failure is logged and swallowed (the message is already stored/emitted).
 */
export async function enqueueChatPush(db: ChatPushDb, params: ChatPushParams): Promise<void> {
	try {
		// Never notify someone about their own message (defensive — the durable
		// handler already rejects self-chat long before it would reach here; the
		// fast tailer does not pre-filter it).
		if (params.recipient === params.sender) return;
		const localeRow = await db.query<{ locale: string }>(
			`SELECT locale FROM push_subscriptions
			  WHERE account = $1
			  ORDER BY created_at DESC
			  LIMIT 1`,
			[params.recipient]
		);
		// Skip enqueue when the recipient has no push subscription at all.
		if (localeRow.rowCount === 0) return;

		const locale = normalizeLocale(localeRow.rows[0]?.locale);
		const isOrderSignal =
			typeof params.orderPermlink === 'string' && params.orderPermlink.length > 0;
		const category = isOrderSignal ? 'order' : 'chat';
		// Order signal → deep-link to the order-scoped chat with the sender
		// (cp471). Plain chat → the chat list. Both localized; the [lang] segment
		// + the ?order query survive sanitizeClickPath (same-origin pathname +
		// search). Guarded by handler-push-click-path-route-smoke.
		const clickPath = isOrderSignal
			? `/${locale}/chat/${params.sender}?order=${params.orderPermlink}`
			: `/${locale}/chat`;
		const title = isOrderSignal ? localize(locale, 'order_title') : localize(locale, 'chat_title');
		const body = isOrderSignal
			? localize(locale, 'order_body', params.sender)
			: localize(locale, 'chat_body', params.sender);
		// cp450 dedup tag: order signals share the in-page trade tag so the
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
		log.warn('push_enqueue_failed', {
			recipient: params.recipient,
			err: String((err as Error)?.message ?? err)
		});
	}
}
