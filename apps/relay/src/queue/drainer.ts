/**
 * Morphit relay — pending-transfer queue drainer (ADR-0011 §8).
 *
 * The indexer writes rows to relay_pending_transfers when it
 * detects trigger conditions (first-trade welcome bonus today;
 * low-balance refill and loyalty BP in future sub-phases). The
 * relay polls that table, broadcasts each transfer with its
 * active key, and marks the row broadcast_at + broadcast_trx_id
 * on success.
 *
 * Failure model:
 *   - Transport failures (RPC down, network timeout): increment
 *     error_count, leave broadcast_at NULL. Next poll retries.
 *   - Chain-rejection errors (malformed op, insufficient
 *     balance, etc.): same treatment — these are usually fixable
 *     by operator intervention (refund the relay's BLURT balance,
 *     correct a bad row). Auto-retry is harmless until the root
 *     cause is addressed.
 *   - Rows with error_count >= queueMaxRetries are SKIPPED by
 *     the drain query. They stay in the table as evidence; an
 *     operator dashboard surfaces them for manual investigation.
 *
 * Each row is broadcast in its own transaction. A poison row
 * that consistently fails does NOT block subsequent rows from
 * being tried.
 */

import type pg from 'pg';
import type { UnlockedConfig } from '$config';
import type { Database } from '$db/pool';
import type { BlurtClient } from '$blurt/client';
import { logger } from '$log';

const log = logger('relay-drainer');

/** Blurt account name regex — used to defensively re-validate the
 *  recipient of every queue row before broadcasting a transfer.
 *
 *  Every current writer to `relay_pending_transfers` already
 *  validates the recipient upstream (feedback handler, loyalty
 *  tracker, low-balance scanner). This check is defense-in-depth
 *  against a future bug or operator misstep that could poison the
 *  queue via direct DB write — if the recipient isn't a valid
 *  Blurt account name, we refuse to broadcast and log loudly.
 *
 *  Per Blurt's `is_valid_account_name`, account names are dotted
 *  multi-segment (e.g. `alice.alpha`).  Canonicalized to allow
 *  dots — see REVISIT-LIST.md "C-19 follow-on consistency pass"
 *  for context. Without dot allowance, any dotted-account user's
 *  welcome bonus would fail to deliver. */
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

interface PendingTransferRow {
	id: number;
	recipient: string;
	kind: 'liquid' | 'vesting' | 'delegation';
	amount_blurt: string; // NUMERIC arrives as a string from pg
	/** Present when kind='delegation'; null otherwise. */
	amount_bp: string | null;
	reason: string;
	error_count: number;
}

export interface QueueDrainResult {
	/** How many rows we attempted this cycle. */
	readonly attempted: number;
	/** How many succeeded (broadcast_at set). */
	readonly succeeded: number;
	/** How many failed this cycle — error_count incremented. */
	readonly failed: number;
}

export class RelayQueueDrainer {
	private abort = new AbortController();
	private runningLoop: Promise<void> | null = null;

	constructor(
		private readonly config: UnlockedConfig,
		private readonly db: Database,
		private readonly blurt: BlurtClient
	) {}

	/** Start the continuous drain loop. Resolves when stop() is
	 *  called. Errors inside the loop are logged and do NOT stop
	 *  the loop — the drain itself must be resilient. */
	start(): void {
		if (this.runningLoop !== null) {
			throw new Error('RelayQueueDrainer.start() called twice');
		}
		log.info('starting', {
			interval_ms: this.config.queuePollIntervalMs,
			batch_size: this.config.queueBatchSize,
			max_retries: this.config.queueMaxRetries
		});
		this.runningLoop = this.loop();
	}

	/** Gracefully stop the loop. Resolves when the in-flight
	 *  drain (if any) completes. */
	async stop(): Promise<void> {
		this.abort.abort();
		if (this.runningLoop) await this.runningLoop;
		this.runningLoop = null;
	}

	/** Perform one drain cycle. Exposed for tests + for callers
	 *  who want to force an immediate drain (e.g. a manual
	 *  operator trigger via /admin).
	 *
	 *  Concurrency: the whole cycle runs in a single transaction
	 *  with SELECT ... FOR UPDATE SKIP LOCKED on the candidate
	 *  rows.  Multiple drainers pointed at the same DB (e.g. HA
	 *  setups) will see disjoint row sets — no double-broadcast.
	 *  See Finding N23. */
	async drainOnce(): Promise<QueueDrainResult> {
		const client = await this.db.connect();
		let succeeded = 0;
		let failed = 0;
		let attempted = 0;
		try {
			await client.query('BEGIN');
			const rows = await this.selectPendingLocked(client);
			attempted = rows.length;
			for (const row of rows) {
				// Each row: its own savepoint inside the outer
				// transaction.  Poison rows don't poison their
				// neighbors, but the row-level lock is still held
				// to the end of the cycle.
				const sp = `row_${row.id}`;
				await client.query(`SAVEPOINT ${sp}`);
				try {
					await this.processRow(client, row);
					await client.query(`RELEASE SAVEPOINT ${sp}`);
					succeeded++;
				} catch (err) {
					await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
					failed++;
					await this.recordFailure(client, row, err);
				}
			}
			await client.query('COMMIT');
		} catch (err) {
			try {
				await client.query('ROLLBACK');
			} catch {
				// Already rolled back; ignore.
			}
			throw err;
		} finally {
			client.release();
		}
		return { attempted, succeeded, failed };
	}

	// ─── Internals ────────────────────────────────────────────────

	private async loop(): Promise<void> {
		while (!this.abort.signal.aborted) {
			try {
				const result = await this.drainOnce();
				if (result.attempted > 0) {
					log.info('cycle_complete', {
						attempted: result.attempted,
						succeeded: result.succeeded,
						failed: result.failed
					});
				}
			} catch (err) {
				log.error('cycle_failed', {}, err);
			}
			await this.sleep(this.config.queuePollIntervalMs);
		}
	}

	private async selectPendingLocked(client: pg.PoolClient): Promise<PendingTransferRow[]> {
		// FIFO by created_at. Skip rows that have already hit the
		// retry ceiling — they need operator attention, not another
		// auto-retry.  FOR UPDATE SKIP LOCKED claims the rows so
		// concurrent drainers see disjoint sets (see N23).
		//
		// The broadcast_attempt_at filter combines two purposes:
		//
		// 1. Post-N23 residual window: if a row was marked "about
		//    to send" but the post-success UPDATE then failed
		//    mid-flight, the row has broadcast_attempt_at set but
		//    broadcast_at still NULL.  We hold off long enough for
		//    a transient PG hiccup to clear.
		//
		// 2. REVISIT-LIST §G item — exponential backoff between
		//    retries.  An upstream RPC outage shouldn't get hammered
		//    every 10 minutes by a stuck row.  Cooldown grows with
		//    error_count: minute(2^error_count) capped at 240m (4h).
		//    error_count = 0  →  cooldown 1m   (first retry: fast)
		//    error_count = 1  →  cooldown 2m
		//    error_count = 2  →  cooldown 4m
		//    error_count = 3  →  cooldown 8m   (default cap reached
		//                                       at queueMaxRetries=3,
		//                                       row escalates to
		//                                       operator)
		//    error_count = 8+ →  cooldown 240m (operators with
		//                                       higher max-retries
		//                                       tunings hit this cap)
		//
		// First attempt (error_count=0 AND broadcast_attempt_at IS
		// NULL) bypasses the wait — we drain fresh rows immediately.
		const result = await client.query<PendingTransferRow>(
			`SELECT id, recipient, kind, amount_blurt::text,
			        amount_bp::text AS amount_bp, reason, error_count
			   FROM relay_pending_transfers
			  WHERE broadcast_at IS NULL
			    AND error_count < $1
			    AND (
			      broadcast_attempt_at IS NULL
			      OR broadcast_attempt_at < NOW() - (
			        INTERVAL '1 minute' * LEAST(POWER(2, error_count)::numeric, 240)
			      )
			    )
			  ORDER BY created_at ASC, id ASC
			  LIMIT $2
			  FOR UPDATE SKIP LOCKED`,
			[this.config.queueMaxRetries, this.config.queueBatchSize]
		);
		return Array.from(result.rows);
	}

	private async processRow(client: pg.PoolClient, row: PendingTransferRow): Promise<void> {
		// Defense-in-depth: validate the recipient shape even
		// though upstream writers already did so. A queue row
		// with an invalid recipient is a signal that something
		// upstream is broken (or that the DB was written
		// directly outside our ingest path); we refuse to
		// broadcast and let the row's error_count escalate so
		// it eventually lands in operator attention.
		if (!ACCOUNT_NAME_RE.test(row.recipient)) {
			throw new Error(
				`row ${row.id}: recipient does not match account-name regex: ${JSON.stringify(row.recipient).slice(0, 64)}`
			);
		}

		// Mark "we are about to broadcast" BEFORE the chain call.
		// If the broadcast lands but the post-success UPDATE then
		// fails (transient PG hiccup, savepoint rollback), the row
		// has broadcast_attempt_at set, and the next drain cycle
		// can decide whether to retry or hold for operator review.
		// This closes a residual double-broadcast window from N23.
		await client.query(
			`UPDATE relay_pending_transfers
			    SET broadcast_attempt_at = NOW()
			  WHERE id = $1`,
			[row.id]
		);

		// Defense-in-depth: validate reason shape.  All current
		// writers use lowercase identifiers like
		// `welcome_bonus_liquid` or `loyalty_milestone_100`; this
		// guard catches future writer bugs, DB corruption, or
		// accidentally-injected control chars before they land in
		// a user's wallet history via the broadcast memo.
		if (!/^[a-z0-9_:-]{1,64}$/.test(row.reason)) {
			throw new Error(`row ${row.id}: invalid reason ${JSON.stringify(row.reason).slice(0, 64)}`);
		}

		// Defense-in-depth: cap amounts.  Legitimate writers cap
		// at 10 BLURT (welcome bonus) and 1260 BP (sum of all
		// loyalty milestones).  These bounds catch wildly-out-of-
		// range values from a future bug or DB-direct-write
		// without rejecting any legitimate path.  See Finding G1.2.
		const MAX_AMOUNT_BLURT = 10_000;
		const MAX_AMOUNT_BP = 10_000;

		// Dispatch based on kind. For liquid/vesting, amount_blurt
		// is the payable amount. For delegation, amount_bp is —
		// amount_blurt is a sentinel 0 per the v6 schema.
		let confirmation;
		if (row.kind === 'liquid' || row.kind === 'vesting') {
			const amount = Number(row.amount_blurt);
			if (!Number.isFinite(amount) || amount <= 0) {
				throw new Error(`row ${row.id}: invalid amount_blurt ${row.amount_blurt}`);
			}
			if (amount > MAX_AMOUNT_BLURT) {
				throw new Error(`row ${row.id}: amount_blurt ${amount} exceeds cap ${MAX_AMOUNT_BLURT}`);
			}
			if (row.kind === 'liquid') {
				confirmation = await this.blurt.broadcastTransfer({
					from: this.config.relayAccount,
					fromActiveWif: this.config.relayActiveKeyWif,
					to: row.recipient,
					amountBlurt: amount,
					memo: `morphit:${row.reason}`
				});
			} else {
				confirmation = await this.blurt.broadcastTransferToVesting({
					from: this.config.relayAccount,
					fromActiveWif: this.config.relayActiveKeyWif,
					to: row.recipient,
					amountBlurt: amount
				});
			}
		} else if (row.kind === 'delegation') {
			if (row.amount_bp === null) {
				throw new Error(`row ${row.id}: delegation kind missing amount_bp`);
			}
			const bp = Number(row.amount_bp);
			if (!Number.isFinite(bp) || bp <= 0) {
				throw new Error(`row ${row.id}: invalid amount_bp ${row.amount_bp}`);
			}
			if (bp > MAX_AMOUNT_BP) {
				throw new Error(`row ${row.id}: amount_bp ${bp} exceeds cap ${MAX_AMOUNT_BP}`);
			}
			confirmation = await this.blurt.broadcastDelegation({
				delegator: this.config.relayAccount,
				delegatorActiveWif: this.config.relayActiveKeyWif,
				delegatee: row.recipient,
				amountBp: bp
			});
		} else {
			throw new Error(`row ${row.id}: unknown kind ${JSON.stringify(row.kind)}`);
		}

		// Success — mark broadcast.  Runs inside the cycle's
		// transaction; the row-level lock held since
		// selectPendingLocked guarantees no other drainer can
		// interleave.  Conditional WHERE is paranoid defense in
		// depth, not strictly necessary now (see Finding N23).
		await client.query(
			`UPDATE relay_pending_transfers
			    SET broadcast_at = NOW(),
			        broadcast_trx_id = $2
			  WHERE id = $1 AND broadcast_at IS NULL`,
			[row.id, confirmation.id]
		);
	}

	private async recordFailure(
		client: pg.PoolClient,
		row: PendingTransferRow,
		err: unknown
	): Promise<void> {
		const message = err instanceof Error ? err.message : String(err);
		log.error(
			'row_failed',
			{
				row_id: row.id,
				kind: row.kind,
				amount_blurt: row.amount_blurt,
				recipient: row.recipient,
				reason: row.reason
			},
			err
		);
		try {
			await client.query(
				`UPDATE relay_pending_transfers
				    SET last_error = $2,
				        last_error_at = NOW(),
				        error_count = error_count + 1
				  WHERE id = $1 AND broadcast_at IS NULL`,
				[row.id, message.slice(0, 500)] // cap to avoid bloating
			);
		} catch (dbErr) {
			// If even the error-recording UPDATE fails, log loudly
			// but don't propagate — we're already in an error path.
			log.error('error_record_write_failed', { row_id: row.id }, dbErr);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const t = setTimeout(resolve, ms);
			// Honor abort during the sleep — don't wait the full
			// interval to shut down.
			this.abort.signal.addEventListener(
				'abort',
				() => {
					clearTimeout(t);
					resolve();
				},
				{ once: true }
			);
		});
	}
}
