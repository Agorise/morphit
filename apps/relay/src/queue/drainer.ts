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
 * Failure model (the previous text here described a
 * retry-on-any-error design that paid twice):
 *   - Before anything is signed, nothing has left the process: a failure there
 *     (chain unreachable for the head read, validation, bookkeeping) is a
 *     DEFINITE failure — error_count + 1, retried with backoff.
 *   - Once the signed bytes may have reached ANY node, no answer except
 *     "accepted"/"duplicate" is trusted: a timeout may hide an acceptance, and
 *     a hostile node can relay a transaction and still answer "rejected". The
 *     row is then UNSETTLED and is settled from the chain before anything else
 *     (see NEVER PAY TWICE).
 *   - Rows with error_count >= queueMaxRetries are SKIPPED by the drain query
 *     — they stay as evidence (last_error says why) for the operator.
 *
 * Each row is processed on its own. A poison row that consistently
 * fails does NOT block subsequent rows from being tried, and rows that have
 * never been attempted are taken BEFORE unsettled ones, so a batch full of
 * unsettled rows cannot starve new payments.
 *
 * NEVER PAY TWICE (D1 + wave 4).
 *   1. The row is CLAIMED by an atomic compare-and-set on
 *      broadcast_attempt_at, committed on its own (it also keeps two drainers
 *      off one row).
 *   2. The transfer is signed ONCE; its txid and SIGNED expiration are
 *      committed ('in_flight trx_id=… exp=…') BEFORE any node is sent the
 *      bytes. If that write fails, nothing is sent.
 *   3. An unconfirmed send becomes 'outcome_unknown trx_id=… exp=… checks=N'.
 *   4. An unsettled row is settled (BlurtClient.settleTransfer) only once the
 *      signed expiration has passed: found in history → done; absent per >= 2
 *      operators whose OWN irreversible block is past the signed expiration →
 *      that attempt failed (error_count + 1) and the row is re-sent next
 *      cycle; otherwise → checked again later, and after queueMaxSettleChecks
 *      checks ESCALATED (error_count set to the cap, last_error 'escalated: …',
 *      logged, counted on /v1/health) — never re-sent blind.
 * DELEGATIONS (2026-10-08). They used to be exempt from settling ("a
 * delegation SETS an absolute amount, so re-sending one is harmless"). On
 * morphit.io two delegation rows were then re-signed about once a minute for
 * five days: each send ended "outcome unknown", nothing looked at the chain, and
 * error_count never rose, so they never stopped or reached the operator. Now a
 * delegation attempt is settled from the relay's history exactly like a
 * transfer (by its txid), and:
 *   - only the NEWEST delegation row for an account is ever sent; an older one
 *     is retired as superseded (each row carries the absolute target, and an
 *     older, smaller one landing after a newer one would undo it);
 *   - a delegation row is not sent while an older row for the same account has
 *     an attempt that may still land.
 * The nodes' answer to an unconfirmed send is kept (`cause=` in last_error,
 * and in the log), so a refusal the chain repeats reaches the operator.
 */

import type { UnlockedConfig } from '$config';
import type { Database } from '$db/pool';
import { BroadcastOutcomeUnknownError, type BlurtClient } from '../blurt/client.ts';
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
 *  dots — see the project backlog "C-19 follow-on consistency pass"
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
	broadcast_attempt_at: Date | null;
	/** broadcast_attempt_at as Postgres text (full microsecond precision) —
	 *  the compare-and-set token; a JS Date would drop the microseconds. */
	attempt_token: string | null;
	last_error: string | null;
}

/** last_error at claim time, before anything is signed: nothing sent yet. */
const IN_FLIGHT = 'in_flight';
/** last_error prefixes of an attempt whose bytes may be on the network. */
const IN_FLIGHT_SIGNED = 'in_flight trx_id=';
const OUTCOME_UNKNOWN = 'outcome_unknown';
/** A settle check is not attempted until this long after the signed
 *  expiration (an irreversible block must pass it). */
const SETTLE_GRACE_MS = 30_000;
/** History is searched back to this long before the signed expiration. */
const HISTORY_LOOKBACK_MS = 15 * 60_000;
/** A delegation held below the chain's minimum is looked at again after this. */
const HELD_RECHECK_HOURS = 6;
/** Default number of undecided settle checks before a row is escalated. */
const DEFAULT_MAX_SETTLE_CHECKS = 30;

/** The attempt a row's last_error describes. */
type Attempt =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'unsettled';
			readonly txid: string | null;
			readonly expirationMs: number;
			readonly checks: number;
			/** What the nodes answered to the send, when it was recorded. */
			readonly cause: string;
	  };

/** One line, bounded, for last_error (it is parsed by its leading fields).
 *  Every control character goes, NUL included: Postgres refuses NUL in text,
 *  and a write of a node's reply that fails must never lose the record of the
 *  signed transaction (review 2026-10-08). */
function oneLine(s: string): string {
	return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
}
function causeText(s: string): string {
	return oneLine(s).slice(0, 200);
}

/** The SQL condition "this row's attempt may be on the network". */
const ATTEMPT_OPEN_SQL = `(last_error LIKE '${OUTCOME_UNKNOWN}%' OR last_error LIKE '${IN_FLIGHT_SIGNED}%')`;

function parseAttempt(row: PendingTransferRow): Attempt {
	const e = row.last_error ?? '';
	if (!(e.startsWith(IN_FLIGHT_SIGNED) || e.startsWith(OUTCOME_UNKNOWN))) return { kind: 'none' };
	// The fields are read only from before the nodes' answer, which is free text.
	const at = e.indexOf(' cause=');
	const head = at === -1 ? e : e.slice(0, at);
	const cause = at === -1 ? '' : e.slice(at + ' cause='.length);
	const txid = /trx_id=([0-9a-f]{40})/.exec(head)?.[1] ?? null;
	const exp = Number(/\bexp=(\d+)/.exec(head)?.[1]);
	const checks = Number(/\bchecks=(\d+)/.exec(head)?.[1] ?? 0);
	// No recorded expiration (a row written before wave 4): assume the latest
	// it could be — the claim stamp plus a generous signing delay + window.
	const stampMs =
		row.broadcast_attempt_at == null ? Date.now() : new Date(row.broadcast_attempt_at).getTime();
	return {
		kind: 'unsettled',
		txid,
		expirationMs: Number.isFinite(exp) && exp > 0 ? exp : stampMs + 15 * 60_000,
		checks: Number.isFinite(checks) ? checks : 0,
		cause
	};
}

/** Counts surfaced on the relay's /v1/health (verbose). */
export interface QueueStats {
	/** Rows whose last payment attempt may be on chain, awaiting settlement. */
	readonly unsettled: number;
	/** Rows escalated to the operator: outcome still unknown after the
	 *  maximum number of settle checks. Never re-sent automatically. */
	readonly escalated: number;
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
	private stats: QueueStats | null = null;

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
	 *  Concurrency: no transaction is held across a broadcast. Each row is
	 *  CLAIMED by an atomic compare-and-set on broadcast_attempt_at (committed
	 *  at once), so two drainers pointed at the same DB can never both send a
	 *  row (Finding N23), and a crash leaves a durable "we were sending this"
	 *  mark (D1). */
	async drainOnce(): Promise<QueueDrainResult> {
		let succeeded = 0;
		let failed = 0;
		const rows = await this.selectPending();
		for (const row of rows) {
			try {
				const outcome = await this.processRow(row);
				if (outcome === 'done') succeeded++;
				else if (outcome === 'failed') failed++;
			} catch (err) {
				failed++;
				await this.recordFailure(row, err);
			}
		}
		await this.refreshStats();
		return { attempted: rows.length, succeeded, failed };
	}

	/** Latest queue counts (null before the first cycle). */
	queueStats(): QueueStats | null {
		return this.stats;
	}

	private async refreshStats(): Promise<void> {
		try {
			const r = await this.db.query<{ unsettled: string; escalated: string }>(
				`SELECT
				   count(*) FILTER (WHERE broadcast_at IS NULL
				     AND (last_error LIKE 'outcome_unknown%' OR last_error LIKE 'in_flight trx_id=%'))::text AS unsettled,
				   count(*) FILTER (WHERE broadcast_at IS NULL AND last_error LIKE 'escalated:%')::text AS escalated
				 FROM relay_pending_transfers`
			);
			const row = r.rows[0];
			if (row) this.stats = { unsettled: Number(row.unsettled), escalated: Number(row.escalated) };
		} catch {
			/* stats are best-effort */
		}
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

	private async selectPending(): Promise<PendingTransferRow[]> {
		// FIFO by created_at. Skip rows that have already hit the
		// retry ceiling — they need operator attention, not another
		// auto-retry. No row lock here: processRow claims each row with
		// an atomic compare-and-set before touching the chain.
		//
		// Exponential backoff between attempts, keyed on the COMMITTED
		// broadcast_attempt_at (it used to be rolled back with the failed
		// attempt, which made every retry immediate): cooldown
		// minute(2^error_count) capped at 240m (4h).
		//    error_count = 0  →  cooldown 1m   (also the first settle check)
		//    error_count = 1  →  cooldown 2m
		//    error_count = 2  →  cooldown 4m
		//    error_count = 3  →  cooldown 8m   (default cap reached at
		//                                       queueMaxRetries=3, row
		//                                       escalates to operator)
		//    error_count = 8+ →  cooldown 240m
		//
		// A never-attempted row (broadcast_attempt_at IS NULL) is taken at once.
		const result = await this.db.query<PendingTransferRow>(
			`SELECT id, recipient, kind, amount_blurt::text,
			        amount_bp::text AS amount_bp, reason, error_count,
			        broadcast_attempt_at, broadcast_attempt_at::text AS attempt_token, last_error
			   FROM relay_pending_transfers t
			  WHERE broadcast_at IS NULL
			    AND error_count < $1
			    -- A delegation that must wait for an older one to the same account
			    -- is not taken: it would hold a batch slot every cycle (it is never
			    -- stamped) and, sorted first, keep the older one from settling.
			    AND NOT (kind = 'delegation' AND EXISTS (
			      SELECT 1 FROM relay_pending_transfers o
			       WHERE o.kind = 'delegation' AND o.recipient = t.recipient AND o.id < t.id
			         AND o.broadcast_at IS NULL AND o.error_count < $1
			         AND (o.last_error LIKE '${OUTCOME_UNKNOWN}%' OR o.last_error LIKE '${IN_FLIGHT_SIGNED}%')))
			    AND (
			      broadcast_attempt_at IS NULL
			      OR broadcast_attempt_at < NOW() - (
			        INTERVAL '1 minute' * LEAST(POWER(2, error_count)::numeric, 240)
			      )
			    )
			  -- Never-attempted rows first (A3): a batch full of unsettled rows
			  -- must not starve new payments.
			  ORDER BY (broadcast_attempt_at IS NOT NULL) ASC, created_at ASC, id ASC
			  LIMIT $2`,
			[this.config.queueMaxRetries, this.config.queueBatchSize]
		);
		return Array.from(result.rows);
	}

	/** Settle an attempt that may be on chain. 'done' = it landed (row marked);
	 *  'failed' = proven never to land (counted; re-sent next cycle);
	 *  'wait' = not decidable yet (or escalated). */
	private async settle(
		row: PendingTransferRow,
		att: Extract<Attempt, { kind: 'unsettled' }>,
		amount: number
	): Promise<'done' | 'failed' | 'wait'> {
		if (Date.now() < att.expirationMs + SETTLE_GRACE_MS) return 'wait';
		const asset = `${amount.toFixed(3)} BLURT`;
		const want =
			row.kind === 'liquid'
				? 'transfer'
				: row.kind === 'vesting'
					? 'transfer_to_vesting'
					: 'delegate_vesting_shares';
		const result = await this.blurt
			.settleTransfer({
				account: this.config.relayAccount,
				sinceMs: att.expirationMs - HISTORY_LOOKBACK_MS,
				expirationMs: att.expirationMs,
				match: (op, body, trxId) => {
					if (att.txid !== null && trxId !== undefined) return trxId === att.txid;
					if (want === 'delegate_vesting_shares')
						return (
							op === want &&
							body.delegator === this.config.relayAccount &&
							body.delegatee === row.recipient
						);
					if (op !== want || body.from !== this.config.relayAccount || body.to !== row.recipient)
						return false;
					if (body.amount !== asset) return false;
					return row.kind === 'vesting' || body.memo === `morphit:${row.reason}`;
				}
			})
			.catch(() => 'unknown' as const);
		if (result === 'found') {
			await this.db.query(
				`UPDATE relay_pending_transfers
				    SET broadcast_at = NOW(),
				        broadcast_trx_id = $2,
				        last_error = NULL
				  WHERE id = $1 AND broadcast_at IS NULL`,
				[row.id, att.txid ?? 'settled-from-history']
			);
			log.info('row_settled_found_on_chain', { row_id: row.id, trx_id: att.txid });
			return 'done';
		}
		if (result === 'absent') {
			await this.db.query(
				`UPDATE relay_pending_transfers
				    SET last_error = $2, last_error_at = NOW(), error_count = error_count + 1
				  WHERE id = $1 AND broadcast_at IS NULL`,
				[
					row.id,
					`not_landed trx_id=${att.txid ?? '?'} (absent past its expiration per 2+ operators)` +
						(att.cause !== '' ? ` — the nodes answered: ${att.cause}` : '')
				]
			);
			log.warn('row_attempt_not_landed', {
				row_id: row.id,
				kind: row.kind,
				trx_id: att.txid,
				...(att.cause !== '' ? { cause: att.cause } : {})
			});
			return 'failed';
		}
		const checks = att.checks + 1;
		const max = this.config.queueMaxSettleChecks ?? DEFAULT_MAX_SETTLE_CHECKS;
		if (checks >= max) {
			await this.db.query(
				`UPDATE relay_pending_transfers
				    SET last_error = $2, last_error_at = NOW(), error_count = GREATEST(error_count, $3)
				  WHERE id = $1 AND broadcast_at IS NULL`,
				[
					row.id,
					`escalated: outcome of trx_id=${att.txid ?? '?'} still unknown after ${checks} checks — check the relay account's history for it before re-queueing` +
						(att.cause !== '' ? ` — the nodes answered: ${att.cause}` : ''),
					this.config.queueMaxRetries
				]
			);
			log.error('row_escalated_outcome_unknown', {
				row_id: row.id,
				trx_id: att.txid,
				checks,
				hint: 'The chain could not tell whether this payment landed (no two RPC nodes could settle it). It is NOT re-sent automatically. Look the txid up in a block explorer; if it is absent, reset error_count on the row to re-queue it.'
			});
			return 'wait';
		}
		await this.db.query(
			`UPDATE relay_pending_transfers SET last_error = $2, last_error_at = NOW()
			  WHERE id = $1 AND broadcast_at IS NULL`,
			[
				row.id,
				`${OUTCOME_UNKNOWN} trx_id=${att.txid ?? '?'} exp=${att.expirationMs} checks=${checks}` +
					(att.cause !== '' ? ` cause=${att.cause}` : '')
			]
		);
		log.info('row_unsettled_waiting', { row_id: row.id, trx_id: att.txid, checks });
		return 'wait';
	}

	private async processRow(row: PendingTransferRow): Promise<'done' | 'failed' | 'wait'> {
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

		let amount = 0;
		let bp = 0;
		if (row.kind === 'liquid' || row.kind === 'vesting') {
			amount = Number(row.amount_blurt);
			if (!Number.isFinite(amount) || amount <= 0) {
				throw new Error(`row ${row.id}: invalid amount_blurt ${row.amount_blurt}`);
			}
			if (amount > MAX_AMOUNT_BLURT) {
				throw new Error(`row ${row.id}: amount_blurt ${amount} exceeds cap ${MAX_AMOUNT_BLURT}`);
			}
		} else if (row.kind === 'delegation') {
			if (row.amount_bp === null) {
				throw new Error(`row ${row.id}: delegation kind missing amount_bp`);
			}
			bp = Number(row.amount_bp);
			if (!Number.isFinite(bp) || bp <= 0) {
				throw new Error(`row ${row.id}: invalid amount_bp ${row.amount_bp}`);
			}
			if (bp > MAX_AMOUNT_BP) {
				throw new Error(`row ${row.id}: amount_bp ${bp} exceeds cap ${MAX_AMOUNT_BP}`);
			}
		} else {
			throw new Error(`row ${row.id}: unknown kind ${JSON.stringify(row.kind)}`);
		}

		// A previous attempt may already be on chain: settle it FIRST (D1).
		// Delegations too (2026-10-08, see the header).
		const att = parseAttempt(row);
		if (att.kind === 'unsettled') return this.settle(row, att, amount);

		if (row.kind === 'delegation') {
			// Only the newest target for an account is sent: an older row is retired.
			const newer = await this.db.query<{ id: string }>(
				`SELECT id::text FROM relay_pending_transfers
				  WHERE kind = 'delegation' AND recipient = $1 AND id > $2
				    AND broadcast_at IS NULL AND error_count < $3
				  ORDER BY id DESC LIMIT 1`,
				[row.recipient, row.id, this.config.queueMaxRetries]
			);
			const newerId = newer.rows[0]?.id;
			if (newerId !== undefined) {
				const retired = await this.db.query(
					`UPDATE relay_pending_transfers
					    SET broadcast_at = NOW(),
					        broadcast_trx_id = $2,
					        last_error = $3
					  WHERE id = $1 AND broadcast_at IS NULL
					    AND broadcast_attempt_at::text IS NOT DISTINCT FROM $4::text`,
					[
						row.id,
						`superseded-by-row-${newerId}`,
						`superseded: row ${newerId} carries a newer delegation target for ${row.recipient}; this one was never sent again`,
						row.attempt_token ?? null
					]
				);
				// Another drainer took the row meanwhile: leave it to that one.
				if ((retired.rowCount ?? 0) !== 1) return 'wait';
				log.info('row_superseded', { row_id: row.id, by_row_id: newerId });
				return 'done';
			}
			// Never send while an older row's attempt for the account may still land.
			const olderOpen = await this.db.query<{ id: string }>(
				`SELECT id::text FROM relay_pending_transfers
				  WHERE kind = 'delegation' AND recipient = $1 AND id < $2
				    AND broadcast_at IS NULL AND error_count < $3
				    AND ${ATTEMPT_OPEN_SQL}
				  LIMIT 1`,
				[row.recipient, row.id, this.config.queueMaxRetries]
			);
			if (olderOpen.rows.length > 0) return 'wait';

			// The chain's own limits (Blurt's delegate_vesting_shares evaluator,
			// from Steem HF20): a NEW delegation must be at least
			// account_creation_fee / 3 (about 33.4 BP at a 100 BLURT fee), a
			// change at least fee / 30. Below that the chain refuses it every
			// time: on morphit.io the 1 BP welcome stake and the 11 BP first
			// milestone to one account were re-sent for five days. Such a target
			// is HELD (not an error) and looked at again every few hours; a newer
			// row for the account, once the rewards add up, replaces it.
			const verdict = await this.delegationVerdict(row.recipient, bp);
			if (verdict.kind === 'already') {
				await this.db.query(
					`UPDATE relay_pending_transfers
					    SET broadcast_at = NOW(), broadcast_trx_id = 'already-delegated', last_error = NULL
					  WHERE id = $1 AND broadcast_at IS NULL`,
					[row.id]
				);
				log.info('row_delegation_already_in_place', { row_id: row.id, bp });
				return 'done';
			}
			if (verdict.kind === 'hold') {
				await this.db.query(
					`UPDATE relay_pending_transfers
					    SET last_error = $2, last_error_at = NOW(),
					        broadcast_attempt_at = NOW() + make_interval(hours => $3)
					  WHERE id = $1 AND broadcast_at IS NULL
					    AND broadcast_attempt_at::text IS NOT DISTINCT FROM $4::text`,
					[row.id, verdict.why, HELD_RECHECK_HOURS, row.attempt_token ?? null]
				);
				log.info('row_delegation_held', { row_id: row.id, bp, why: verdict.why });
				return 'wait';
			}
		}

		// Claim + stamp, committed BEFORE anything is signed: an atomic
		// compare-and-set on the attempt stamp we read, so a concurrent
		// drainer (or a second cycle) that already claimed the row loses.
		const claim = await this.db.query(
			`UPDATE relay_pending_transfers
			    SET broadcast_attempt_at = clock_timestamp(),
			        last_error = $3
			  WHERE id = $1
			    AND broadcast_at IS NULL
			    AND broadcast_attempt_at::text IS NOT DISTINCT FROM $2::text`,
			[row.id, row.attempt_token ?? null, IN_FLIGHT]
		);
		if ((claim.rowCount ?? 0) !== 1) return 'wait';

		// Record WHICH signed transaction is about to go out — txid and signed
		// expiration — BEFORE any node sees it. If this write fails, the client
		// sends nothing (BroadcastNotSentError).
		const onSigned = async (info: { txid: string; expirationMs: number }): Promise<void> => {
			const w = await this.db.query(
				`UPDATE relay_pending_transfers SET last_error = $2
				  WHERE id = $1 AND broadcast_at IS NULL`,
				[row.id, `${IN_FLIGHT_SIGNED}${info.txid} exp=${info.expirationMs}`]
			);
			if ((w.rowCount ?? 0) !== 1)
				throw new Error('could not record the signed transaction; not sending');
		};
		let confirmation;
		try {
			if (row.kind === 'liquid') {
				confirmation = await this.blurt.broadcastTransfer({
					from: this.config.relayAccount,
					fromActiveWif: this.config.relayActiveKeyWif,
					to: row.recipient,
					amountBlurt: amount,
					memo: `morphit:${row.reason}`,
					onSigned
				});
			} else if (row.kind === 'vesting') {
				confirmation = await this.blurt.broadcastTransferToVesting({
					from: this.config.relayAccount,
					fromActiveWif: this.config.relayActiveKeyWif,
					to: row.recipient,
					amountBlurt: amount,
					onSigned
				});
			} else {
				confirmation = await this.blurt.broadcastDelegation({
					delegator: this.config.relayAccount,
					delegatorActiveWif: this.config.relayActiveKeyWif,
					delegatee: row.recipient,
					amountBp: bp,
					onSigned
				});
			}
		} catch (err) {
			if (err instanceof BroadcastOutcomeUnknownError) {
				// It may be on chain. Record WHICH signed transaction, so the
				// settle step can find it exactly; NOT counted as an error.
				await this.db.query(
					`UPDATE relay_pending_transfers
					    SET last_error = $2,
					        last_error_at = NOW()
					  WHERE id = $1 AND broadcast_at IS NULL`,
					[
						row.id,
						`${OUTCOME_UNKNOWN} trx_id=${err.txid} exp=${err.expirationMs} checks=0 cause=${causeText(err.reason)}`
					]
				);
				log.warn('row_outcome_unknown', {
					row_id: row.id,
					kind: row.kind,
					trx_id: err.txid,
					cause: causeText(err.reason)
				});
				return 'wait';
			}
			// BroadcastNotSentError — nothing left this process (head read,
			// signing or the bookkeeping above failed): a definite failure,
			// counted and retried with backoff.
			throw err;
		}

		// Success — mark broadcast. If THIS write fails the payment is on chain
		// but the row still says 'in_flight': it must not go to recordFailure
		// (which would make it look like a definite failure and re-send it).
		// Left as is, the next cycle settles it from the history.
		try {
			await this.db.query(
				`UPDATE relay_pending_transfers
				    SET broadcast_at = NOW(),
				        broadcast_trx_id = $2,
				        last_error = NULL
				  WHERE id = $1 AND broadcast_at IS NULL`,
				[row.id, confirmation.id]
			);
		} catch (dbErr) {
			log.error('row_success_write_failed', { row_id: row.id, trx_id: confirmation.id }, dbErr);
			return 'wait';
		}
		return 'done';
	}

	/** What the chain allows for this delegation target now. Unknown (the
	 *  rules could not be read) sends as before: the chain decides. */
	private async delegationVerdict(
		recipient: string,
		bp: number
	): Promise<{ kind: 'send' } | { kind: 'already' } | { kind: 'hold'; why: string }> {
		const read = (this.blurt as Partial<BlurtClient>).delegationRules;
		if (typeof read !== 'function') return { kind: 'send' };
		let rules: { minNewBp: number; minChangeBp: number; currentBp: number };
		try {
			rules = await read.call(this.blurt, this.config.relayAccount, recipient);
		} catch {
			return { kind: 'send' };
		}
		// 1% margin: the BP-to-VESTS price moves a little before the block.
		const fmt = (n: number): string => n.toFixed(3).replace(/\.?0+$/, '');
		if (rules.currentBp <= 0) {
			if (bp < rules.minNewBp * 1.01)
				return {
					kind: 'hold',
					why:
						`held: ${fmt(bp)} BP is below the chain's minimum delegation of ${fmt(rules.minNewBp)} BP; ` +
						`it is lent once this account's rewards add up to it`
				};
			return { kind: 'send' };
		}
		const change = Math.abs(bp - rules.currentBp);
		if (change < rules.minChangeBp * 1.01) {
			if (change < rules.minChangeBp / 100) return { kind: 'already' };
			return {
				kind: 'hold',
				why:
					`held: a change of ${fmt(change)} BP (now ${fmt(rules.currentBp)} BP) is below the chain's ` +
					`minimum change of ${fmt(rules.minChangeBp)} BP`
			};
		}
		return { kind: 'send' };
	}

	private async recordFailure(row: PendingTransferRow, err: unknown): Promise<void> {
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
			// A definite failure (validation, or nothing left this process):
			// counted toward queueMaxRetries. The row's attempt record is kept when it describes a signed
			// transaction that may be on the network (an exception after the
			// send — a database write while settling or recording the outcome —
			// must not erase it, or the next cycle would sign and send again);
			// it is settled from the history instead. The failure is still
			// counted, so a row that keeps failing stops and reaches the
			// operator (second review 2026-10-08).
			await this.db.query(
				`UPDATE relay_pending_transfers
				    SET last_error = CASE WHEN last_error IS NOT NULL AND ${ATTEMPT_OPEN_SQL}
				                          THEN last_error ELSE $2 END,
				        last_error_at = NOW(),
				        error_count = error_count + 1
				  WHERE id = $1 AND broadcast_at IS NULL`,
				[row.id, oneLine(message).slice(0, 500)]
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
