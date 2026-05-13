/**
 * Morphit indexer — low-balance auto-refill scanner (ADR-0010 §3).
 *
 * Periodic job that detects active Morphit users whose on-chain
 * BLURT balance has dropped below the configured threshold, and
 * queues 1 BLURT dust transfers via relay_pending_transfers. The
 * relay's existing drainer broadcasts these asynchronously.
 *
 * "Active" here means the account has had a Morphit op (order,
 * feedback, chat) in the last activityWindowDays. Users who
 * haven't touched Morphit in a while don't need our dust.
 *
 * Cooldown: we won't queue a second refill for the same account
 * within refillCooldownDays. Cooldown is tracked by looking at
 * recent relay_pending_transfers rows with reason='dust_refill'
 * — no new table, no migration.
 *
 * Why it sits in the indexer rather than the relay: the indexer
 * has the Morphit op history needed to define "active user" and
 * already owns the relay_pending_transfers writer from the
 * welcome-bonus trigger. The relay just drains the queue.
 *
 * Failure model matches WitnessFeePoller: each scan is one
 * pass, errors are logged and counted, the loop keeps running.
 * A stuck scan doesn't block block processing (it's gated off
 * the Poller's tick loop via maybePoll).
 */

import type pg from 'pg';
import type { BlurtClient } from '$blurt/client';
import type { Database } from '$db/pool';
import { parseBlurtAmount } from '$indexer/fee-transfer';
import { logger } from '$log';

const log = logger('low-balance');

export interface LowBalanceScanConfig {
	/** Minimum ms between scans. */
	readonly intervalMs: number;
	/** BLURT balance below which we consider refill. */
	readonly thresholdBlurt: number;
	/** Activity window for "active user" classification. */
	readonly activityWindowDays: number;
	/** Cooldown before re-refilling the same account. */
	readonly refillCooldownDays: number;
	/** Amount per refill in BLURT. */
	readonly refillAmountBlurt: number;
	/** Max accounts to process per scan. Bounds RPC load and
	 *  damage if a bug queues refills for everyone. */
	readonly maxBatch: number;
}

export interface ScanResult {
	/** Candidates considered this cycle (after activity + cooldown
	 *  filters, before balance check). */
	readonly candidatesChecked: number;
	/** How many were below threshold and got a refill queued. */
	readonly refillsQueued: number;
	/** RPC errors encountered this cycle. */
	readonly rpcErrors: number;
}

export class LowBalanceScanner {
	private lastScanAt = 0;

	constructor(
		private readonly db: Database,
		private readonly blurt: BlurtClient,
		private readonly relayAccount: string,
		private readonly config: LowBalanceScanConfig,
		/** Part 111 — THIS instance's operator tag.  When set, the
		 *  scanner's candidate query JOINs against `orders.operator_tag`
		 *  and refills only users whose recent orders were attributed
		 *  to THIS instance.  When undefined (operator unregistered),
		 *  the scanner refills nothing — conservative default,
		 *  matching the operator-payout gate in operatorEarnings.ts.
		 *  Pre-Part-111, the scanner refilled any user whose ops
		 *  appeared in this indexer's `ops` table — which is every
		 *  user in the federation, multiplying treasury spend by the
		 *  federation count. */
		private readonly instanceOperatorTag: string | undefined
	) {}

	/** Throttled runner for the Poller tick loop. No-op between
	 *  intervals. Safe to call on every tick. */
	async maybeScan(): Promise<void> {
		const now = Date.now();
		if (now - this.lastScanAt < this.config.intervalMs) return;
		this.lastScanAt = now;
		try {
			const result = await this.scanOnce();
			if (result.candidatesChecked > 0 || result.refillsQueued > 0) {
				log.info('scan_complete', {
					candidates_checked: result.candidatesChecked,
					refills_queued: result.refillsQueued,
					rpc_errors: result.rpcErrors
				});
			}
		} catch (err) {
			log.error('scan_failed', {}, err);
		}
	}

	/** Perform one scan. Exposed for tests and operator-triggered
	 *  scans. */
	async scanOnce(): Promise<ScanResult> {
		// Step 1: find candidate accounts. "Active Morphit users who
		// haven't received a dust refill within the cooldown window
		// AND aren't the relay itself."
		const candidates = await this.selectCandidates();
		if (candidates.length === 0) {
			return { candidatesChecked: 0, refillsQueued: 0, rpcErrors: 0 };
		}

		// Step 2: batch-fetch on-chain balances. One RPC for up to
		// maxBatch accounts.
		let balances: ReadonlyMap<string, string | undefined>;
		let rpcErrors = 0;
		try {
			const accounts = await this.blurt.getAccounts(candidates);
			balances = new Map(
				Array.from(accounts.entries()).map(
					([name, acc]) => [name, acc.balance] as [string, string | undefined]
				)
			);
		} catch (err) {
			log.error('rpc_get_accounts_failed', {}, err);
			rpcErrors++;
			return {
				candidatesChecked: candidates.length,
				refillsQueued: 0,
				rpcErrors
			};
		}

		// Step 3: filter to those below threshold + queue refills.
		let refillsQueued = 0;
		for (const name of candidates) {
			const balanceStr = balances.get(name);
			if (balanceStr === undefined) {
				// Account missing from chain response — probably a
				// deleted or renamed account. Skip silently; the
				// cooldown filter won't pick this one up again until
				// an op from it lands.
				continue;
			}
			const balance = parseBlurtAmount(balanceStr);
			if (balance === null) {
				// Unparseable balance string — log for operator
				// visibility but don't explode.
				log.warn('unparseable_balance', {
					account: name,
					raw: balanceStr
				});
				continue;
			}
			if (balance < this.config.thresholdBlurt) {
				try {
					await this.queueRefill(name);
					refillsQueued++;
				} catch (err) {
					// Queueing failure is worth logging but shouldn't
					// stop the scan — other accounts may still qualify.
					log.error('queue_refill_failed', { account: name }, err);
				}
			}
		}

		return {
			candidatesChecked: candidates.length,
			refillsQueued,
			rpcErrors
		};
	}

	// ─── Internals ────────────────────────────────────────────────

	/** Candidate query: accounts row exists, had a Morphit op in
	 *  the last activityWindow days, and no dust_refill queued
	 *  within the cooldown window. Excludes the relay itself.
	 *
	 *  Part 111 — additionally requires that the account had an
	 *  order in the activity window attributed to THIS instance's
	 *  operator_tag.  Closes the federation-cost gap: pre-Part-111,
	 *  every operator's scanner queued refills for every user
	 *  active across the federation, multiplying treasury spend
	 *  by the federation count.  Now each operator refills only
	 *  users who interacted with their own instance.
	 *
	 *  Users active across multiple instances may be refilled by
	 *  each independently (per-instance cooldown applies); this
	 *  is acceptable — they ARE active users of each.
	 *
	 *  When `instanceOperatorTag === undefined`, the JOIN's WHERE
	 *  clause matches no rows and the scanner refills nothing.
	 *  Conservative default — an unregistered operator pays
	 *  nothing.
	 */
	private async selectCandidates(): Promise<string[]> {
		// Part 111 fast-path: nothing to query if the operator
		// hasn't set MORPHIT_INSTANCE_OPERATOR_TAG.  Part 112
		// hardening: log once per tick so the operator sees an
		// explicit "I'm running but doing nothing" trail.
		if (this.instanceOperatorTag === undefined) {
			log.debug('low_balance_scan_skipped_unset_operator_tag', {
				reason: 'MORPHIT_INSTANCE_OPERATOR_TAG_unset'
			});
			return [];
		}

		const activityCutoff = this.intervalAgo(this.config.activityWindowDays * 24 * 60 * 60 * 1000);
		const cooldownCutoff = this.intervalAgo(this.config.refillCooldownDays * 24 * 60 * 60 * 1000);

		const result = await this.db.query<{ name: string }>(
			`SELECT a.name
			   FROM accounts a
			  WHERE a.name <> $1
			    AND EXISTS (
			          SELECT 1 FROM orders ord
			           WHERE ord.account = a.name
			             AND ord.created_at >= $2
			             AND ord.operator_tag = $5
			        )
			    AND NOT EXISTS (
			          SELECT 1 FROM relay_pending_transfers r
			           WHERE r.recipient = a.name
			             AND r.reason = 'dust_refill'
			             AND r.created_at >= $3
			        )
			  LIMIT $4`,
			[
				this.relayAccount,
				activityCutoff,
				cooldownCutoff,
				this.config.maxBatch,
				this.instanceOperatorTag
			]
		);
		return result.rows.map((r) => r.name);
	}

	/** Queue one refill row. Matches the pattern used by the
	 *  welcome-bonus trigger in the feedback handler.
	 *
	 *  Concurrency-safe: re-checks the cooldown inside the
	 *  transaction so two concurrent scanners (e.g. HA setup
	 *  with multiple indexer processes) can't double-queue the
	 *  same recipient.  The candidate filter in selectCandidates
	 *  catches the common case; this is the race-window backstop. */
	private async queueRefill(recipient: string): Promise<void> {
		const cooldownCutoff = this.intervalAgo(this.config.refillCooldownDays * 24 * 60 * 60 * 1000);
		await this.db.withTx(async (client: pg.PoolClient) => {
			// INSERT ... WHERE NOT EXISTS — atomic check-and-insert
			// against any concurrent scanner.  If a row already
			// exists for this recipient within the cooldown window,
			// the WHERE NOT EXISTS returns false and the INSERT is
			// a no-op (rowCount=0).  No error, no duplicate.
			await client.query(
				`INSERT INTO relay_pending_transfers
				   (recipient, kind, amount_blurt, reason, created_at)
				 SELECT $1, 'liquid', $2, 'dust_refill', NOW()
				 WHERE NOT EXISTS (
				     SELECT 1 FROM relay_pending_transfers
				      WHERE recipient = $1
				        AND reason = 'dust_refill'
				        AND created_at >= $3
				 )`,
				[recipient, this.config.refillAmountBlurt, cooldownCutoff]
			);
		});
	}

	/** Utility: timestamp N ms ago as a Date. Extracted so tests
	 *  can mock Date.now() consistently. */
	private intervalAgo(ms: number): Date {
		return new Date(Date.now() - ms);
	}
}
