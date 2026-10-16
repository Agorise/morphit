/**
 * apps/indexer/src/indexer/offlineNoticeEnqueue.ts
 *
 * Settings → Offline Notifications: queue a chat message for the relay's
 * offline-notice worker (apps/relay/src/notify/worker.ts), which at the row's
 * due time — unless she has the site open, has replied or has read the
 * thread — sends "Someone just sent you a chat message on <site>" to the
 * addresses she verified.
 *
 * The due time ({@link offlineNoticeDueAt}) is a random 10–60 minutes after
 * the message, and always on a quarter hour (:00, :15, :30, :45 UTC) — the
 * same moments for every user and every message. The app that carries the
 * note (her mail provider, Telegram, a Matrix or XMPP server) sees when it
 * arrives; this way that moment does not point at one on-chain message.
 *
 * Called from enqueueChatPush, i.e. from the same three places as the Web Push
 * (the durable handler, the fast head tailer, a verified federation peer push)
 * and only AFTER their block-list gate: a sender she blocked never reaches it.
 *
 * Writes only for an account that has at least one VERIFIED address on this
 * instance (or one she is changing: the confirmed one she had keeps getting
 * notes until the new one is confirmed), and one row per thread: the primary key (account, sender, thread)
 * makes the second, third … message of a burst, and the second path's copy of
 * the same message, add no row — and keep the row's due time (its quarter
 * hour was drawn once). A later message moves the row's message time forward:
 * the relay asks "has she read or replied since?" from it, so a message that
 * came after she read or answered the first one is still announced. Nothing about the message is stored but its
 * on-chain-public metadata (who wrote to whom, which order, when).
 *
 * Non-fatal: a failure is logged without the account and swallowed. Inside a
 * transaction (`inTransaction`) the insert runs under its own savepoint, so a
 * failure rolls back only itself — never the block transaction, and never the
 * Web Push enqueued after it in the same transaction.
 */
import { randomInt } from 'node:crypto';
import { logger } from '$log';
import type { ChatPushDb } from '$indexer/chatPushEnqueue';

const log = logger('offline-notice-enqueue');

/** The shortest wait before a notice: she may be on the site already, or
 *  answer from another tab. */
export const OFFLINE_NOTICE_MIN_WAIT_MS = 10 * 60_000;
/** The longest wait. */
export const OFFLINE_NOTICE_MAX_WAIT_MS = 60 * 60_000;
/** Notices go out only on these shared marks (UTC quarter hours). */
export const OFFLINE_NOTICE_SLOT_MS = 15 * 60_000;

/** Older messages are never announced: a node catching up on blocks after an
 *  outage or a resync must not send a notice for every old message. */
export const OFFLINE_NOTICE_MAX_AGE_MS = 30 * 60_000;

export interface OfflineNoticeParams {
	readonly recipient: string;
	readonly sender: string;
	/** The thread's order permlink, or null/'' for the order-less thread. */
	readonly orderPermlink: string | null;
	/** Block time of the message. */
	readonly eventAt: Date;
}

/**
 * When the notice for a message sent at `eventAt` is due: one of the quarter
 * hours more than {@link OFFLINE_NOTICE_MIN_WAIT_MS} and at most
 * {@link OFFLINE_NOTICE_MAX_WAIT_MS} after it, picked at random (a
 * cryptographic random, so the pick cannot be predicted) — and never one
 * already past, so a message the node learns of late still waits for a
 * shared mark. `pick(n)` returns 0 … n-1; tests pass their own. PURE but for
 * the default `pick`.
 */
export function offlineNoticeDueAt(
	eventAt: Date,
	now: Date,
	pick: (n: number) => number = randomInt
): Date {
	const from = Math.max(eventAt.getTime() + OFFLINE_NOTICE_MIN_WAIT_MS, now.getTime());
	const to = eventAt.getTime() + OFFLINE_NOTICE_MAX_WAIT_MS;
	const first =
		Math.floor(from / OFFLINE_NOTICE_SLOT_MS) * OFFLINE_NOTICE_SLOT_MS + OFFLINE_NOTICE_SLOT_MS;
	const count = first > to ? 1 : Math.floor((to - first) / OFFLINE_NOTICE_SLOT_MS) + 1;
	const i = Math.min(Math.max(0, Math.floor(pick(count))), count - 1);
	return new Date(first + i * OFFLINE_NOTICE_SLOT_MS);
}

export async function enqueueOfflineNotice(
	db: ChatPushDb,
	p: OfflineNoticeParams,
	now: Date = new Date(),
	opts: { readonly inTransaction?: boolean } = {}
): Promise<void> {
	if (p.recipient === p.sender) return;
	if (now.getTime() - p.eventAt.getTime() > OFFLINE_NOTICE_MAX_AGE_MS) return;
	const dueAt = offlineNoticeDueAt(p.eventAt, now);
	const sp = opts.inTransaction === true;
	try {
		if (sp) await db.query('SAVEPOINT offline_notice_enqueue');
		await db.query(
			`INSERT INTO offline_notify_pending (account, sender, order_permlink, event_at, due_at)
			 SELECT $1, $2, $3, $4, $5
			  WHERE EXISTS (
			          SELECT 1 FROM offline_notify_channels
			           WHERE account = $1
			             AND (verified_at IS NOT NULL OR prev_verified_at IS NOT NULL)
			        )
			 ON CONFLICT (account, sender, order_permlink) DO UPDATE SET
			   event_at = GREATEST(offline_notify_pending.event_at, EXCLUDED.event_at)`,
			[p.recipient, p.sender, p.orderPermlink ?? '', p.eventAt, dueAt]
		);
		if (sp) await db.query('RELEASE SAVEPOINT offline_notice_enqueue');
	} catch (err) {
		if (sp) {
			await db
				.query('ROLLBACK TO SAVEPOINT offline_notice_enqueue')
				.then(() => db.query('RELEASE SAVEPOINT offline_notice_enqueue'))
				.catch(() => undefined);
		}
		log.warn('offline_notice_enqueue_failed', { err: String((err as Error)?.message ?? err) });
	}
}
