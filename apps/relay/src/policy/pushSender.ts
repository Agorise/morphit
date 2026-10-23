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
 *   - We never log subscription endpoints, and no account names.
 *
 * Where it sends: only to an endpoint that passes isAllowedPushEndpoint
 * (https, a browser push service or an operator-added host), and only to
 * a public address — the https agent resolves the name, refuses any
 * non-public answer and connects to the address it checked
 * (policy/pushEndpoint.ts). A stored row that fails the policy (one
 * taken before it existed) is deleted without being contacted.
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
import { PUSH_PRUNE_INTERVAL_MS, prunePushTombstones } from './pushQueueJanitor.ts';
import { isAllowedPushEndpoint, pushAgent } from './pushEndpoint.ts';

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
	notification_id: string | null; // shared dedup tag id (or null)
}

export interface PushSendTickResult {
	readonly attempted: number;
	readonly delivered: number;
	readonly droppedExpired: number;
	readonly droppedNoSubscriptions: number;
	readonly subscriptionsDeleted: number;
}

// The tombstone retention, the prune interval and the prune itself live in
// pushQueueJanitor.ts, so a relay with push OFF prunes by the same rule (v1.18.0).

/**
 * Rows being sent at once, across overlapping passes (v1.21.14 full chat audit,
 * S-L7). The queue was worked one row at a time and, within a row, one device
 * at a time, each with up to SEND_TIMEOUT_MS to answer — so ONE stalled push
 * service delayed every notification queued behind it, and a pass that hit one
 * did not end until it timed out. Now a row's devices are pushed side by side,
 * rows are pushed side by side, and the next pass starts on time while a slow
 * one is still waiting, skipping the rows it holds.
 */
export const PUSH_ROWS_IN_FLIGHT = 32;

/** Passes running at once. A pass waiting on a slow push service no longer
 *  holds the next one back, but a stalled DATABASE would otherwise start a new
 *  pass — and a new query — every poll interval without end (independent
 *  review of the audit fixes, finding 10). */
export const PUSH_PASSES_IN_FLIGHT = 4;

/** How long a finished row is remembered against a stale read: longer than
 *  any one query can take to come back. */
export const PUSH_DONE_MEMORY_MS = 5 * 60_000;

/** How long one push service may take to answer. They answer in well under a
 *  second; this only bounds a stalled one, which no longer holds anyone else. */
export const SEND_TIMEOUT_MS = 15_000;

export class PushSender {
	private abort = new AbortController();
	private runningLoop: Promise<void> | null = null;
	/** Rows a pass is sending right now; the next pass leaves them alone. */
	private readonly inFlight = new Set<string>();
	/** Passes still running (the loop does not wait for them; stop() does). */
	private readonly passes = new Set<Promise<unknown>>();
	/** Rows a pass finished lately (id → when). A pass whose query started
	 *  before another pass marked a row sent can still read it as unsent; this
	 *  keeps such a stale read from sending it twice (independent review 2,
	 *  finding 8). Kept PUSH_DONE_MEMORY_MS. */
	private readonly recentlyDone = new Map<string, number>();

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
		await Promise.allSettled([...this.passes]);
	}

	private async loop(): Promise<void> {
		// v1.5.5 — the tombstone pruner rides this loop rather than a second
		// timer: it must not run every tick (that would be a DELETE scan every
		// few seconds for nothing), and it must not be forgotten either, or
		// push_pending grows without bound now that rows are retained instead
		// of deleted. Throttled to its own interval below.
		let lastPruneMs = 0;
		while (!this.abort.signal.aborted) {
			try {
				// NOT awaited (S-L7): a pass waiting on a stalled push service must
				// not hold back rows queued after it. The next pass skips the rows
				// this one holds (`inFlight`). At most PUSH_PASSES_IN_FLIGHT at once.
				const pass = (
					this.passes.size >= PUSH_PASSES_IN_FLIGHT ? Promise.resolve(null) : this.tick()
				).then(
					(r) => {
						if (r !== null && (r.attempted > 0 || r.delivered > 0)) {
							log.info('tick', {
								attempted: r.attempted,
								delivered: r.delivered,
								dropped_expired: r.droppedExpired,
								dropped_no_subs: r.droppedNoSubscriptions,
								subs_deleted: r.subscriptionsDeleted
							});
						}
					},
					(err: unknown) => log.error('tick_failed', {}, err as Error)
				);
				this.passes.add(pass);
				void pass.finally(() => this.passes.delete(pass));
				const now = Date.now();
				if (now - lastPruneMs >= PUSH_PRUNE_INTERVAL_MS) {
					lastPruneMs = now;
					await this.prune();
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
		// Rows an earlier pass is still sending are skipped (S-L7).
		const room = Math.min(this.config.pushBatchSize, PUSH_ROWS_IN_FLIGHT - this.inFlight.size);
		if (room <= 0) return out;
		const result = await this.db.query<PendingRow>(
			`SELECT id, account, category, title, body, click_path,
			        event_at, enqueued_at, notification_id
			   FROM push_pending
			  WHERE sent_at IS NULL
			    AND NOT (id = ANY($2::bigint[]))
			  ORDER BY enqueued_at ASC
			  LIMIT $1`,
			[room, [...this.inFlight]]
		);

		const maxAgeMs = this.config.pushMaxAgeSeconds * 1000;
		const now = Date.now();

		const doneSince = Date.now() - PUSH_DONE_MEMORY_MS;
		for (const [id, at] of this.recentlyDone) if (at < doneSince) this.recentlyDone.delete(id);
		const rows = result.rows.filter(
			(row) => !this.inFlight.has(String(row.id)) && !this.recentlyDone.has(String(row.id))
		);
		for (const row of rows) this.inFlight.add(String(row.id));
		await Promise.all(
			rows.map(async (row) => {
				try {
					await this.sendRow(row, out, now, maxAgeMs);
					// Remembered as done only once it IS done (review B, F6): a pass
					// that threw before sending (a database blip) left the row unsent,
					// and remembering it then held it back for PUSH_DONE_MEMORY_MS —
					// a chat push five minutes late. Now the next pass retries it.
					this.recentlyDone.set(String(row.id), Date.now());
				} finally {
					this.inFlight.delete(String(row.id));
				}
			})
		);
		return out;
	}

	/** Push one queued row to every device of its account, side by side. */
	private async sendRow(
		row: PendingRow,
		out: { -readonly [K in keyof PushSendTickResult]: number },
		now: number,
		maxAgeMs: number
	): Promise<void> {
		{
			out.attempted++;

			// Drop expired rows — pushing stale notifications is
			// worse than not pushing.
			const ageMs = now - row.event_at.getTime();
			if (ageMs > maxAgeMs) {
				out.droppedExpired++;
				await this.markSent(row.id);
				return;
			}

			// Fetch the account's devices that HAVEN'T opted out of this
			// category — the per-category Settings toggle is applied here.
			// A device that muted `row.category` is skipped.
			const devices = await this.subs.listByAccount(row.account, row.category);
			if (devices.length === 0) {
				// No subscribed devices for this category — nothing to deliver.
				out.droppedNoSubscriptions++;
				await this.markSent(row.id);
				return;
			}

			// Build the payload once.  The web-push library will
			// encrypt one copy per recipient (per RFC 8291).
			const payload = JSON.stringify({
				title: row.title,
				body: row.body,
				category: row.category,
				clickPath: row.click_path,
				// eventId doubles as the SW's notification tag id
				// (`morphit-<category>-<eventId>`). When the indexer set a
				// shared `notification_id` (an order signal, matching the
				// in-page notificationTag), use it so the two notifications
				// collapse to one; otherwise fall back to the queue-row id
				// (per-event dedup for pushes with no in-page twin)..
				eventId: row.notification_id ?? row.id,
				eventAt: row.event_at.toISOString()
			});

			// Fan out.  We update subscription state per-device;
			// at the end, we always retire the pending row (stamp
			// sent_at — see markSent; the indexer enqueued it once; we
			// don't retry once we've attempted delivery to all of the
			// user's devices).
			let anySubDeleted = false;
			// Every device at once (S-L7): one slow device no longer delays the
			// others. The outcomes are then recorded in turn, as before.
			const outcomes = await Promise.all(devices.map((dev) => this.sendOne(dev, payload)));
			for (const [i, dev] of devices.entries()) {
				const sendOutcome = outcomes[i];
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

			// Retire the row.  We've fanned out to every device we knew
			// about at this moment.  If pushes failed, the user simply
			// doesn't see them — durably retrying after fan-out invites
			// duplicates.
			await this.markSent(row.id);

			if (anySubDeleted) {
				log.info('subscriptions_pruned', {});
			}
		}
	}

	/**
	 * v1.5.5 — retire a row by STAMPING `sent_at`, never by deleting it.
	 *
	 * This is the whole duplicate-notification fix. The fast head-block tailer
	 * and the durable chat handler both enqueue the SAME message keyed on its
	 * on-chain trx id, and `ON CONFLICT (account, source_trx_id) DO NOTHING`
	 * is what collapses them to one push. But this worker used to DELETE the
	 * row the moment it delivered it (~5s), and the durable enqueue arrives
	 * ~60s later — by which time there was nothing left to conflict with, so
	 * it inserted and the user got a SECOND notification. The dedup could only
	 * ever have worked if the durable insert lost a race it wins by ~55s.
	 *
	 * Keeping the row makes it a tombstone: the dedup key stays live until the
	 * pruner reclaims it, long after the durable path has been and gone. The
	 * partial index `push_pending_unsent_idx` keeps the claim query off the
	 * retained rows.
	 */
	private async markSent(id: number | string): Promise<void> {
		await this.db.query(`UPDATE push_pending SET sent_at = NOW() WHERE id = $1`, [id]);
	}

	/**
	 * v1.5.5 — reclaim retired rows once they're older than the dedup window.
	 *
	 * The retention must comfortably outlive the gap between the fast enqueue
	 * and the durable one (~60s in practice, and far more when the indexer is
	 * catching up), or the duplicate comes straight back. An hour is ~60x the
	 * observed gap and still bounds the table. Chat and order tombstones are
	 * kept 24 h (pushQueueJanitor.CHAT_PUSH_TOMBSTONE_RETENTION_SECONDS): the
	 * indexer's one-push-a-day-until-reply cap reads them (v1.21.14, S-M3).
	 */
	async prune(): Promise<number> {
		// rv2-11: the retention is never shorter than the push max age.
		const n = await prunePushTombstones(this.db, this.config.pushMaxAgeSeconds);
		if (n > 0) log.info('push_pending_pruned', { rows: n });
		return n;
	}

	private async sendOne(
		dev: PushSubscription,
		payload: string
	): Promise<'delivered' | 'gone' | 'transient_failure'> {
		// Never contact an endpoint outside the policy; drop the row instead.
		if (!isAllowedPushEndpoint(dev.endpoint, this.config.pushExtraHosts ?? [])) {
			log.warn('push_endpoint_not_allowed_dropped', {});
			return 'gone';
		}
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
					urgency: 'normal',
					// Public addresses only, connection pinned to the
					// address that was checked (pushEndpoint.ts).
					agent: pushAgent(),
					// A push service answers in well under this; a
					// stalled one holds only its own device (S-L7).
					timeout: SEND_TIMEOUT_MS
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
			// The name resolves to a non-public address: never deliverable.
			if ((err as { code?: string })?.code === 'EPUSHPRIVATE') {
				log.warn('push_endpoint_private_dropped', {});
				return 'gone';
			}
			// Don't log the full err object — it may contain
			// endpoint URL + payload preview.  Just the status.
			log.warn('push_failed', { status: status ?? 'no_status' });
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
