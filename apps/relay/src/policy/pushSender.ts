/**
 * Morphit relay — Web Push delivery sender.
 *
 * Drains the `push_pending` queue every config.pushPollIntervalMs.
 * For each row:
 *   1. SELECT the row + JOIN against push_subscriptions to find all
 *      live devices for the account.
 *   2. For each device, build a payload (the title/body/click_path
 *      are pre-localized at indexer enqueue time) and call
 *      webpush.sendNotification().  The web-push library handles
 *      VAPID JWT signing and RFC 8291 payload encryption.
 *   3. On 2xx: markDelivery() on the subscription, DELETE the
 *      pending row (it was for this account; we've fanned it out).
 *   4. On 410 Gone / 404: DELETE the subscription.  The pending row
 *      is dropped too — that device is gone, retrying won't help.
 *   5. On 429 / 5xx: recordFailure() bumps the counter.  When it
 *      crosses pushMaxConsecutiveFailures, the subscription is
 *      DELETED (presumed dead).  The pending row is retained for
 *      the next tick to try the user's OTHER devices.
 *
 * Privacy invariants:
 *   - The web-push library encrypts the payload (E2E vs. the push
 *     service per RFC 8291).  We never log payload content.
 *   - We never log subscription endpoints in full — only the prefix
 *     (e.g. "fcm.googleapis.com").
 *   - We never log IPs.  This module makes outbound HTTPS calls to
 *     the push service; from the push service's perspective, the
 *     relay's egress IP is the "user" — the user's IP is never
 *     correlated with the push delivery.
 *
 * Failure model mirrors the queue drainer: poison rows that
 * consistently fail are bounded by pushMaxAgeSeconds (dropped
 * after the deadline elapses).
 */

import webpush from 'web-push';
import type { Config } from '$config';
import type { Database } from '$db/pool';
import type { PushSubscriptionStore, PushSubscription } from './pushSubscriptions.ts';
import { logger } from '$log';

const log = logger('relay-push-sender');

/** Notification categories accepted by the queue; mirrors the
 *  schema CHECK constraint. */
export type PushCategory = 'order' | 'chat' | 'feedback';

interface PendingRow {
	id: string; // BIGSERIAL — pg returns as string
	account: string;
	category: PushCategory;
	title: string;
	body: string;
	click_path: string | null;
	event_at: Date;
	enqueued_at: Date;
}

export interface PushSendTickResult {
	readonly attempted: number;
	readonly delivered: number;
	readonly droppedExpired: number;
	readonly droppedNoSubscriptions: number;
	readonly subscriptionsDeleted: number;
}

export class PushSender {
	private abort = new AbortController();
	private runningLoop: Promise<void> | null = null;

	constructor(
		private readonly config: Config,
		private readonly db: Database,
		private readonly subs: PushSubscriptionStore
	) {
		if (!config.pushEnabled) {
			throw new Error('PushSender constructed but pushEnabled=false');
		}
		// Configure web-push with the operator's VAPID details once.
		// We've already validated pushEnabled, so all three fields
		// are defined.
		webpush.setVapidDetails(
			config.vapidSubject!,
			config.vapidPublicKey!,
			config.vapidPrivateKey!
		);
	}

	/** Begin polling.  Idempotent — second call is a no-op while a
	 *  loop is still running. */
	start(): void {
		if (this.runningLoop !== null) {
			log.warn('start called while already running');
			return;
		}
		this.runningLoop = this.loop();
	}

	/** Signal the loop to stop and await the in-flight tick. */
	async stop(): Promise<void> {
		this.abort.abort();
		const loop = this.runningLoop;
		this.runningLoop = null;
		if (loop) await loop;
	}

	private async loop(): Promise<void> {
		while (!this.abort.signal.aborted) {
			try {
				const r = await this.tick();
				if (r.attempted > 0 || r.delivered > 0) {
					log.info('tick', {
						attempted: r.attempted,
						delivered: r.delivered,
						dropped_expired: r.droppedExpired,
						dropped_no_subs: r.droppedNoSubscriptions,
						subs_deleted: r.subscriptionsDeleted
					});
				}
			} catch (err) {
				log.error('tick_failed', {}, err as Error);
			}
			await delay(this.config.pushPollIntervalMs, this.abort.signal);
		}
	}

	/** One pass through the queue.  Public for tests + smokes. */
	async tick(): Promise<PushSendTickResult> {
		const out: { -readonly [K in keyof PushSendTickResult]: number } = {
			attempted: 0,
			delivered: 0,
			droppedExpired: 0,
			droppedNoSubscriptions: 0,
			subscriptionsDeleted: 0
		};

		// Drain at most `pushBatchSize` rows per tick.  Order by
		// enqueued_at so older events go first; the worker is FIFO.
		const result = await this.db.query<PendingRow>(
			`SELECT id, account, category, title, body, click_path,
			        event_at, enqueued_at
			   FROM push_pending
			  ORDER BY enqueued_at ASC
			  LIMIT $1`,
			[this.config.pushBatchSize]
		);

		const maxAgeMs = this.config.pushMaxAgeSeconds * 1000;
		const now = Date.now();

		for (const row of result.rows) {
			out.attempted++;

			// Drop expired rows — pushing stale notifications is
			// worse than not pushing.
			const ageMs = now - row.event_at.getTime();
			if (ageMs > maxAgeMs) {
				out.droppedExpired++;
				await this.db.query(`DELETE FROM push_pending WHERE id = $1`, [row.id]);
				continue;
			}

			// Fetch all devices for the target account.
			const devices = await this.subs.listByAccount(row.account);
			if (devices.length === 0) {
				// No subscribed devices — drop the row, nothing to do.
				out.droppedNoSubscriptions++;
				await this.db.query(`DELETE FROM push_pending WHERE id = $1`, [row.id]);
				continue;
			}

			// Build the payload once.  The web-push library will
			// encrypt one copy per recipient (per RFC 8291).
			const payload = JSON.stringify({
				title: row.title,
				body: row.body,
				category: row.category,
				clickPath: row.click_path,
				// Provide an event_id so the SW can deduplicate
				// re-deliveries across devices on the same user.
				eventId: row.id,
				eventAt: row.event_at.toISOString()
			});

			// Fan out.  We update subscription state per-device;
			// at the end, we always delete the pending row (the
			// indexer enqueued it once; we don't retry once we've
			// attempted delivery to all of the user's devices).
			let anySubDeleted = false;
			for (const dev of devices) {
				const sendOutcome = await this.sendOne(dev, payload);
				if (sendOutcome === 'delivered') {
					out.delivered++;
					await this.subs.markDelivery(dev.account, dev.endpoint);
				} else if (sendOutcome === 'gone') {
					await this.subs.delete(dev.account, dev.endpoint);
					out.subscriptionsDeleted++;
					anySubDeleted = true;
				} else {
					// transient failure
					const newCount = await this.subs.recordFailure(dev.account, dev.endpoint);
					if (newCount >= this.config.pushMaxConsecutiveFailures) {
						await this.subs.delete(dev.account, dev.endpoint);
						out.subscriptionsDeleted++;
						anySubDeleted = true;
					}
				}
			}

			// Drop the pending row.  We've fanned out to every
			// device we knew about at this moment.  If pushes
			// failed, the user simply doesn't see them — durably
			// retrying after fan-out invites duplicates.
			await this.db.query(`DELETE FROM push_pending WHERE id = $1`, [row.id]);

			if (anySubDeleted) {
				log.info('subscriptions_pruned', { account: row.account });
			}
		}

		return out;
	}

	private async sendOne(
		dev: PushSubscription,
		payload: string
	): Promise<'delivered' | 'gone' | 'transient_failure'> {
		try {
			await webpush.sendNotification(
				{
					endpoint: dev.endpoint,
					keys: { p256dh: dev.p256dh, auth: dev.auth }
				},
				payload,
				{
					// VAPID details set at constructor time.
					// TTL: push service can hold the push for this
					// long if the device is offline.  4 hours is a
					// reasonable middle ground — long enough to
					// catch the user when they wake up, short
					// enough to drop truly stale alerts.
					TTL: 4 * 3600,
					// Use 'normal' urgency for everything; trade
					// events aren't life-safety, so we don't want
					// to wake sleeping phones via 'high'.
					urgency: 'normal'
				}
			);
			return 'delivered';
		} catch (err: unknown) {
			// web-push throws an object with statusCode for HTTP errors
			const status = (err as { statusCode?: number })?.statusCode;
			if (status === 404 || status === 410) {
				// Subscription is gone — delete it.
				return 'gone';
			}
			// Don't log the full err object — it may contain
			// endpoint URL + payload preview.  Just the status.
			log.warn('push_failed', {
				account: dev.account,
				status: status ?? 'no_status'
			});
			return 'transient_failure';
		}
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const id = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(id);
				resolve();
			},
			{ once: true }
		);
	});
}
