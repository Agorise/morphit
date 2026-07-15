/**
 * apps/indexer/src/indexer/feedbackPushEnqueue.ts
 *
 * v1.5.5 — shared feedback Web Push enqueue, used by BOTH delivery paths:
 *   • the DURABLE handler (handlers/feedback.ts), ~irreversible, and
 *   • the FAST head-block tailer (chatHeadTailer.ts), ~5s after broadcast.
 *
 * Ken: "kentest2 left a 4-star feedback (with text in the textarea) for
 * kentest3, but kentest3 did not get a notification at all (let alone within 6
 * seconds like it should have)" → "yes, i want fastfeedback too."
 *
 * THE DEDUP KEY IS THE POINT. Before v1.5.5 the durable handler enqueued with
 * NO source_trx_id. Adding a fast path on top of that would have reproduced the
 * chat duplicate-notification bug exactly: two independent inserts, nothing to
 * conflict on, two notifications. Both paths now pass the on-chain trx id, and
 * the partial UNIQUE (account, source_trx_id) collapses them to exactly one —
 * fast when the tailer wins, durable as the reliable fallback for anything the
 * head tailer skipped (bounded scan / reorg).
 *
 * SAFETY — the CALLER gates. This function does not decide whether the feedback
 * is admissible; it only enqueues. The durable handler has already run full
 * admission by the time it calls here, and the fast tailer runs a strict SUBSET
 * of that admission before calling (see fastFeedbackAllowed).
 *
 * PRIVACY. Metadata only: the body names the reviewer and the star count, never
 * the comment text.
 *
 * No-op when the subject has no push subscription.
 */
import type pg from 'pg';
import { logger } from '$log';
import { localize, normalizeLocale } from '$indexer/pushLocalize';

const log = logger('feedback-push-enqueue');

/** The minimal db surface both `Database` (pool.ts) and `pg.PoolClient`
 *  satisfy, so either path can call this with what it already holds. */
export interface FeedbackPushDb {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pg.QueryResult<R>>;
}

export interface FeedbackPushParams {
	/** Account the push targets (the review's subject). */
	readonly subject: string;
	/** Who left the review — named in the notification body. */
	readonly reviewer: string;
	/** Stars left (1-5), for the localized body. */
	readonly rating: number;
	/** The on-chain trx id — the dedup key shared by the fast + durable
	 *  enqueues of the SAME review. */
	readonly sourceTrxId: string;
	/** Block timestamp of the source op (push `event_at`). */
	readonly eventAt: Date;
}

/**
 * Enqueue a feedback Web Push, dedup-keyed on the on-chain trx id. Non-fatal:
 * a failure is logged and swallowed (the feedback row is already stored).
 */
export async function enqueueFeedbackPush(
	db: FeedbackPushDb,
	params: FeedbackPushParams
): Promise<void> {
	try {
		// Never notify someone about their own review (defensive — the durable
		// handler rejects self-reviews long before it would reach here).
		if (params.subject === params.reviewer) return;

		const localeRow = await db.query<{ locale: string }>(
			`SELECT locale FROM push_subscriptions
			  WHERE account = $1
			  ORDER BY created_at DESC
			  LIMIT 1`,
			[params.subject]
		);
		// Skip enqueue when the subject has no push subscription at all. The
		// sender would drop the row anyway; enqueue-then-drop just wastes work
		// and pollutes operator metrics.
		if (localeRow.rowCount === 0) return;

		const locale = normalizeLocale(localeRow.rows[0]?.locale);
		const title = localize(locale, 'feedback_title');
		const body =
			params.rating === 1
				? localize(locale, 'feedback_body_one', params.reviewer, String(params.rating))
				: localize(locale, 'feedback_body_many', params.reviewer, String(params.rating));

		// Click-through: the canonical account-profile page is
		// /{locale}/@{account} (the [x+40][account=account] route), which renders
		// the reviews section anchored at #reviews-heading. BOTH the [lang]
		// segment and the `@` are required — cp82-B2 found `/profile/{subject}`
		// had no matching route at all, and cp470 found a locale-less, @-less
		// `/{subject}#reviews-heading` that still 404'd. Guarded by
		// push-clickpath-locale-smoke.
		const clickPath = `/${locale}/@${params.subject}#reviews-heading`;

		await db.query(
			`INSERT INTO push_pending
			   (account, category, title, body, click_path, event_at, source_trx_id)
			 VALUES ($1, 'feedback', $2, $3, $4, $5, $6)
			 ON CONFLICT (account, source_trx_id) WHERE source_trx_id IS NOT NULL DO NOTHING`,
			[params.subject, title, body, clickPath, params.eventAt, params.sourceTrxId]
		);
	} catch (err) {
		log.warn('push_enqueue_failed', {
			subject: params.subject,
			err: String((err as Error)?.message ?? err)
		});
	}
}
