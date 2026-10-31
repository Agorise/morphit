/**
 * Offline notices — the worker.
 *
 * Every 20 seconds: take the queued messages that are due (a UTC quarter hour
 * 10–60 minutes after the message, picked by the indexer) and,
 * for each, send "Someone just sent you a chat message on <site>" with a link
 * to her verified addresses — unless one of these says she does not need it:
 *
 *   - she has the site open (her browser said so within the last three
 *     minutes, a signed heartbeat kept in MEMORY only, never written down);
 *   - she has already answered that person, or read that thread;
 *   - she has blocked that person since the message;
 *   - she already had a notice about this thread and has not read it or
 *     written to that person since (one notice per thread until she looks);
 *   - that person is someone she has never written to and she already had a
 *     notice about them today (strangers earn one a day);
 *   - she reached today's limit of notices.
 *
 * A notice that reached none of her apps is tried again on the next UTC
 * quarter hour at least five minutes away, twice at most ({@link MAX_ATTEMPTS}
 * tries in all), and does not count as a notice she was given.
 * Also no notice from someone she has blocked since the message. Each address gets the link for the network she set it up
 * from (a Tor user gets the .onion). The Telegram bot is polled only while a
 * link code waits; a chat that sends wrong codes is ignored after a few, and
 * gets no answer to them.
 */

import { logger } from '$log';
import type { NotifyConfig } from './config.ts';
import { linkOriginFor, offeredChannels } from './config.ts';
import { dispatch, errorClass, withTimeout } from './dispatch.ts';
import type { DueNotice, OfflineNotifyStore } from './store.ts';
import { render } from './text.ts';
import { codeInTelegramText, pollTelegram, sendTelegram } from './channels/telegram.ts';
import { MatrixTimeoutError } from './channels/matrix.ts';
import { drainLeaves } from './leaves.ts';

const log = logger('offline-notify');

export const TICK_MS = 20_000;
export const PRESENCE_MS = 3 * 60_000;
export const RETRY_MS = 5 * 60_000;
/** Notices go out only on UTC quarter hours — the same marks the indexer's
 *  due times use (apps/indexer/src/indexer/offlineNoticeEnqueue.ts,
 *  OFFLINE_NOTICE_SLOT_MS), so a retry does not stand out from them either. */
export const SLOT_MS = 15 * 60_000;

/** The first quarter hour at least {@link RETRY_MS} from `now`. PURE. */
export function retryAt(now: number): Date {
	return new Date(Math.ceil((now + RETRY_MS) / SLOT_MS) * SLOT_MS);
}
export const MAX_ATTEMPTS = 3;
/**
 * A notice is sent only for a message the chain has (v1.21.14 full chat audit,
 * S-L8). It is queued from the FAST path, before the chain has the message —
 * and a message can be shown and announced that then never lands (the node
 * refused it after a peer had it, say). A notice 10-60 minutes later then
 * opened an empty thread. Its message must be stored by then: the durable lag
 * is about a minute. Not stored yet — an indexer catching up — and it waits,
 * up to NOT_STORED_GIVE_UP_MS after the message; after that it was never sent.
 * Any stored message in the thread she has not read or answered counts, not
 * only the one that queued the notice (store.unreadStoredFrom).
 */
export const NOT_STORED_GIVE_UP_MS = 3 * 3600_000;
/** One channel's send for one notice: past this it counts as failed, and the
 *  next notice goes on (one stuck server must not hold up everyone's notes). */
export const SEND_BUDGET_MS = 120_000;
const STRANGER_WINDOW_MS = 24 * 60 * 60_000;
/** Wrong Telegram codes a chat may send before it is ignored for a day. */
export const TELEGRAM_CHAT_TRIES = 5;
const TELEGRAM_IGNORE_MS = 24 * 60 * 60_000;

/** Who has the site open: account → last heartbeat (ms). Memory only. */
export class Presence {
	private readonly seen = new Map<string, number>();
	constructor(private readonly now: () => number = Date.now) {}
	mark(account: string): void {
		this.seen.set(account, this.now());
	}
	isHere(account: string): boolean {
		const t = this.seen.get(account);
		return t !== undefined && this.now() - t < PRESENCE_MS;
	}
	sweep(): void {
		const cutoff = this.now() - PRESENCE_MS;
		for (const [a, t] of this.seen) if (t < cutoff) this.seen.delete(a);
	}
}

/** The link in a notice. PURE. */
export function noticeLink(origin: string, locale: string, token: string): string {
	return `${origin}/${locale}/chat?n=${token}`;
}

export type Verdict =
	| 'sent'
	| 'here'
	| 'replied'
	| 'read'
	| 'stranger_quota'
	| 'already_noticed'
	| 'daily_cap'
	| 'no_channels'
	| 'blocked'
	/** The message never reached the chain (S-L8). */
	| 'not_on_chain'
	/** The message is not stored yet: asked again later, NOT as a retry of a
	 *  send (it keeps its daily-cap and stranger checks). */
	| 'wait'
	| 'failed'
	| 'retry'
	/** No app answered within its budget, none refused: the outcome is
	 *  awaited in the background (retried only if they all fail). */
	| 'late';

export class OfflineNotifyWorker {
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private tgOffset = 0;
	private tgPolling = false;
	private stopped = false;
	/** Telegram chats that sent wrong codes: chat id → tries, and since when. */
	private readonly tgTries = new Map<string, { n: number; since: number }>();

	constructor(
		private readonly cfg: NotifyConfig,
		private readonly store: OfflineNotifyStore,
		readonly presence: Presence,
		private readonly now: () => Date = () => new Date()
	) {}

	/** Runs whenever there is a store — with no channel offered it still
	 *  purges what has run its course, and sends nothing. */
	start(): void {
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** One round. Exported for tests; never throws. */
	async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const now = this.now();
			this.presence.sweep();
			await this.store.purge(now);
			const due = await this.store.takeDue(25, now);
			for (const n of due) {
				const v = await this.handle(n, now).catch((err) => {
					log.warn('notice_failed', { err: errorClass(err) });
					return 'failed' as Verdict;
				});
				// One notice's bookkeeping failing must not cost the rest of the batch.
				if (v === 'retry' || v === 'wait')
					await this.store
						.requeue(n, retryAt(now.getTime()), v === 'retry')
						.catch((err) => log.warn('notice_requeue_failed', { err: errorClass(err) }));
			}
			if (this.cfg.telegram && !this.tgPolling && (await this.store.telegramCodeWaiting(now))) {
				void this.pollTelegramWhileWaiting();
			}
			// Last, and one pass at most (leaves.ts): the notices never wait
			// for a homeserver that is slow to let the bot leave a room.
			await drainLeaves(this.store, this.cfg.matrix, this.cfg.policy, now);
		} catch (err) {
			log.warn('tick_failed', { err: errorClass(err) });
		} finally {
			this.running = false;
		}
	}

	/** Decide and, when needed, send one notice. */
	async handle(n: DueNotice, now: Date): Promise<Verdict> {
		if (this.presence.isHere(n.account)) return 'here';
		if (await this.store.repliedSince(n.account, n.sender, n.eventAt)) return 'replied';
		// Blocked after the message was queued: no notice, no link to it.
		if (await this.store.blocked(n.account, n.sender)) return 'blocked';
		if (!(await this.store.unreadStoredFrom(n.account, n.sender, n.orderPermlink)))
			return now.getTime() - n.eventAt.getTime() < NOT_STORED_GIVE_UP_MS ? 'wait' : 'not_on_chain';
		if (await this.store.readSince(n.account, n.sender, n.orderPermlink, n.eventAt)) return 'read';
		if (n.attempts === 0 && (await this.store.alreadyNoticed(n.account, n.sender, n.orderPermlink)))
			return 'already_noticed';
		// A retry is the same notice: the link its first try made must not
		// count it against the strangers' one a day.
		if (
			n.attempts === 0 &&
			!(await this.store.everWrote(n.account, n.sender)) &&
			(await this.store.noticedSince(
				n.account,
				n.sender,
				new Date(now.getTime() - STRANGER_WINDOW_MS)
			))
		) {
			return 'stranger_quota';
		}
		const { channels, locale } = await this.store.verifiedChannels(n.account);
		const usable = channels.filter((c) => offeredChannels(this.cfg).includes(c.channel));
		if (usable.length === 0 || this.cfg.linkOrigin === null) return 'no_channels';
		if (n.attempts === 0 && !(await this.store.takeDailySlot(n.account, now))) return 'daily_cap';

		const token = await this.store.createLink(n.account, n.sender, n.orderPermlink, now);
		const subject = render(locale, 'notice_subject', { site: this.cfg.siteName });
		let delivered = 0;
		const late: Array<Promise<boolean>> = [];
		for (const c of usable) {
			const origin = linkOriginFor(this.cfg, c.linkNet) ?? this.cfg.linkOrigin;
			const link = noticeLink(origin, locale, token);
			const msg = { subject, text: render(locale, 'notice', { site: this.cfg.siteName, link }) };
			const sending = dispatch(
				this.cfg,
				c.channel,
				c.address,
				msg,
				c.channel === 'matrix' ? { matrixRooms: this.store.matrixRoomBook() } : {}
			);
			try {
				await withTimeout(sending, SEND_BUDGET_MS, 'notice delivery');
				delivered++;
			} catch (err) {
				log.warn('notice_channel_failed', { channel: c.channel, err: errorClass(err) });
				// Past this round's budget (not a server that answered "too
				// slow"): it may still arrive.
				if (
					err instanceof Error &&
					err.name === 'TimeoutError' &&
					!(err instanceof MatrixTimeoutError)
				)
					late.push(
						sending.then(
							() => true,
							() => false
						)
					);
			}
		}
		if (delivered > 0) return 'sent';
		if (late.length > 0) {
			// A send past its budget may still arrive: retrying now could give her
			// the same notice twice. Wait for those; only if none got through is
			// it a failure (its link goes, and it is tried again).
			void Promise.all(late)
				.then(async (got) => {
					if (got.some(Boolean)) return;
					await this.store.dropLink(token);
					if (n.attempts + 1 < MAX_ATTEMPTS)
						await this.store.requeue(n, retryAt(this.now().getTime()));
				})
				.catch((err) => log.warn('notice_late_failed', { err: errorClass(err) }));
			return 'late';
		}
		// Nothing reached her: the link goes, so it does not count as a notice.
		await this.store.dropLink(token);
		return n.attempts + 1 < MAX_ATTEMPTS ? 'retry' : 'failed';
	}

	/** A chat that sent too many wrong codes today is not listened to. */
	private tgIgnored(chatId: string, nowMs: number): boolean {
		const t = this.tgTries.get(chatId);
		if (t === undefined) return false;
		if (nowMs - t.since > TELEGRAM_IGNORE_MS) {
			this.tgTries.delete(chatId);
			return false;
		}
		return t.n >= TELEGRAM_CHAT_TRIES;
	}

	private tgWrong(chatId: string, nowMs: number): void {
		const t = this.tgTries.get(chatId);
		if (t === undefined || nowMs - t.since > TELEGRAM_IGNORE_MS) {
			if (this.tgTries.size > 100_000) this.tgTries.clear();
			this.tgTries.set(chatId, { n: 1, since: nowMs });
		} else t.n++;
	}

	/**
	 * Long-poll the bot while a link code waits; link the chats that send one.
	 * Only a match is answered. A wrong code gets no answer (nothing to learn
	 * from, nothing to flood the bot's replies with) and counts against its
	 * chat; a message sent before the code existed never matches. Never throws:
	 * a database or network error waits and tries again.
	 */
	private async pollTelegramWhileWaiting(): Promise<void> {
		const tg = this.cfg.telegram;
		if (!tg) return;
		this.tgPolling = true;
		try {
			for (;;) {
				if (this.stopped) return;
				try {
					if (!(await this.store.telegramCodeWaiting(this.now()))) return;
					const updates = await pollTelegram(tg, this.cfg.policy, this.tgOffset, 20);
					for (const u of updates) {
						this.tgOffset = Math.max(this.tgOffset, u.updateId + 1);
						if (u.chatId === '') continue;
						const nowMs = this.now().getTime();
						if (this.tgIgnored(u.chatId, nowMs)) continue;
						const code = codeInTelegramText(u.text);
						if (code === null) continue;
						const linked = await this.store.linkTelegram(code, u.chatId, u.sentAt, this.now());
						if (linked === null) {
							this.tgWrong(u.chatId, nowMs);
							continue;
						}
						this.tgTries.delete(u.chatId);
						await sendTelegram(
							tg,
							this.cfg.policy,
							u.chatId,
							render(linked.locale, 'telegram_linked', { site: this.cfg.siteName })
						).catch((err) => log.warn('telegram_reply_failed', { err: errorClass(err) }));
					}
				} catch (err) {
					log.warn('telegram_poll_failed', { err: errorClass(err) });
					await new Promise((r) => setTimeout(r, 10_000).unref());
				}
			}
		} finally {
			this.tgPolling = false;
		}
	}
}
