/**
 * Keep `push_pending` bounded when nothing is sending from it.
 *
 * WHY THIS EXISTS (v1.18.0). The indexer queues a push for every notification
 * to an account that has a push subscription. The relay's sender drains the
 * queue, expires what is too old to be worth sending, and prunes what it has
 * retired. All three of those happen inside the sender's loop, and the sender
 * only exists when push is enabled.
 *
 * So a relay with push OFF and subscriptions still on file grows the table
 * forever. There was always one way to get there: an operator whose VAPID key
 * stops validating after users subscribed. v1.18.0 made it the ordinary state
 * of every existing tor-only node. A hidden-only relay turns push off (F32),
 * because a browser's push service is a clearnet host. Every subscription taken
 * before the upgrade keeps the indexer queueing, and nothing ever retires a row.
 *
 * The janitor applies the sender's OWN rules without sending anything:
 *   - a row older than `pushMaxAgeSeconds` is retired, exactly as the sender
 *     retires a row too stale to push;
 *   - a retired row is pruned after the same tombstone retention.
 * The table is then bounded by the same window it is bounded by when push works.
 * Subscriptions are left alone: push can come back (a corrected key, a relay
 * that is no longer hidden-only), and those users should not have to subscribe
 * again.
 *
 * No aliases and no logger in the functions: they take the narrowest database
 * shape, so the integration suite can run them against a real Postgres.
 */

/** How long a retired row stays as its own dedup tombstone before it is pruned.
 *  Must comfortably exceed the fast→durable gap (~60s normally, much more while
 *  the indexer catches up) or duplicate notifications return. One hour is about
 *  60x the observed gap and still bounds the table. (v1.5.5) */
export const PUSH_TOMBSTONE_RETENTION_SECONDS = 3600;

/**
 * The retention actually applied: never shorter than the push max age
 * (v1.18.0 deep-deep, rv2-11).
 *
 * A tombstone is what makes a late durable enqueue of an already-pushed
 * notification land on a conflict. Once it is pruned, the same notification
 * can be queued again — and it is pushed again unless it is by then older than
 * `MORPHIT_RELAY_PUSH_MAX_AGE_SECONDS` and so retired as stale. With the fixed
 * one-hour retention and a max age raised above an hour, a durable lag over an
 * hour brought duplicate pushes back. Keeping every tombstone for at least the
 * max age closes that: anything re-queued after its tombstone is gone is too
 * old to send.
 */
export function pushTombstoneRetentionSeconds(maxAgeSeconds: number): number {
	return Math.max(PUSH_TOMBSTONE_RETENTION_SECONDS, Math.ceil(maxAgeSeconds));
}

/** How often retiring and pruning run. Far cheaper than the retention window
 *  is long, so this keeps the table bounded without a DELETE scan per tick. */
export const PUSH_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export interface PushQueueDb {
	query(text: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

/** Delete retired rows older than the tombstone retention — which is never
 *  shorter than `maxAgeSeconds` (rv2-11). Returns how many. */
export async function prunePushTombstones(db: PushQueueDb, maxAgeSeconds: number): Promise<number> {
	const res = await db.query(
		`DELETE FROM push_pending
		  WHERE sent_at IS NOT NULL
		    AND sent_at < NOW() - ($1::int * INTERVAL '1 second')`,
		[pushTombstoneRetentionSeconds(maxAgeSeconds)]
	);
	return res.rowCount ?? 0;
}

/** Retire unsent rows whose event is older than `maxAgeSeconds` — the same
 *  judgement the sender makes per row ("pushing stale notifications is worse
 *  than not pushing"), made in one statement. Retiring rather than deleting
 *  keeps the row as a dedup tombstone for its retention window, as the sender
 *  does, so a durable enqueue arriving late still lands on a conflict. */
export async function retireExpiredPushes(db: PushQueueDb, maxAgeSeconds: number): Promise<number> {
	const res = await db.query(
		`UPDATE push_pending
		    SET sent_at = NOW()
		  WHERE sent_at IS NULL
		    AND event_at < NOW() - ($1::int * INTERVAL '1 second')`,
		[maxAgeSeconds]
	);
	return res.rowCount ?? 0;
}

/** Runs both on an interval, for a relay whose sender is not running. */
export class PushQueueJanitor {
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly db: PushQueueDb,
		private readonly maxAgeSeconds: number,
		private readonly onRun: (r: { retired: number; pruned: number }) => void = () => undefined,
		private readonly onError: (err: unknown) => void = () => undefined,
		private readonly intervalMs: number = PUSH_PRUNE_INTERVAL_MS
	) {}

	async runOnce(): Promise<{ retired: number; pruned: number }> {
		const retired = await retireExpiredPushes(this.db, this.maxAgeSeconds);
		const pruned = await prunePushTombstones(this.db, this.maxAgeSeconds);
		return { retired, pruned };
	}

	/** Runs once at once (a relay that restarts into push-off may already hold
	 *  a backlog), then every interval. Idempotent. */
	start(): void {
		if (this.timer !== null) return;
		const run = (): void => {
			this.runOnce().then(this.onRun, this.onError);
		};
		run();
		this.timer = setInterval(run, this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}
}
