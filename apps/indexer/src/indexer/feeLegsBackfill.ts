/**
 * Morphit indexer — back-fill of fee_payments / fee_payment_legs (v1.21.8)
 * for the fee ops this node indexed before it recorded them.
 *
 * WHY A CHAIN RE-FETCH. What a fee op paid is in the transfers of its
 * transaction. This node kept only the transfers to ITS OWN fees account
 * (`fee_transfers`), never the leg to another operator's account; the `ops`
 * row keeps the op's block, position, trx id, signer and payload. So the job
 * fetches the block through the indexer's own BlurtClient (the full RPC pool;
 * a hidden-only node's pool is hidden-only) and requires the transaction's id
 * — a hash of its content — to equal the id this node indexed. A node serving
 * an altered transaction is caught and nothing is recorded for it. A block
 * that fails is retried on the next passes; after FETCH_FAILURES_PER_BLOCK
 * failures in a row it is set aside for GIVEN_UP_RETRY_MS, then tried again —
 * for as long as it takes.
 *
 * WHAT IS SELECTED. Every op of the three fee-bearing ids that has no
 * `fee_payments` row — the dispatcher writes one for every fee op it logs, so
 * after an upgrade these are exactly the ops logged by an older version (and,
 * after a restore of an older snapshot, the ops it carried). The legs are
 * computed by the same function the live path uses (feePayments.ts), from the
 * transaction as the dispatcher would have seen it (pgSafeDeep).
 *
 * WHEN. Started from the poller loop after each caught-up tick, in the
 * background (the loop goes on indexing): at once, then BACKLOG_INTERVAL_MS
 * after each pass ends while candidates remain. A pass that finds none, with
 * no block set aside, ends the job for the life of the process (every newer
 * op is recorded live). At
 * most MAX_BLOCKS_PER_PASS block fetches per pass, each block's ops in one
 * transaction. Never throws.
 */
import type { BlurtClient, BlockTransaction, ChainOperation } from '$blurt/client';
import type { Database } from '$db/pool';
import { pgSafeDeep } from '$db/pgText';
import { transactionIdOf } from '$blurt/snapshotOpTrust';
import { FEE_PAYMENT_OPS, recordFeePayment } from '$indexer/feePayments';
import { logger } from '$log';

const log = logger('feeLegsBackfill');

/** While candidates are left, the next pass comes this soon. */
export const BACKLOG_INTERVAL_MS = 10_000;
/** Distinct blocks fetched per pass. */
export const MAX_BLOCKS_PER_PASS = 25;
/** A block whose fetch fails, or that does not hold the indexed transaction,
 *  is retried on the next passes up to this many times in a row… */
export const FETCH_FAILURES_PER_BLOCK = 3;
/** …then set aside (so it never holds the queue) and tried again this much
 *  later, for as long as it takes: an RPC outage must not leave a node's
 *  figures short for good. The job ends only when nothing is left. */
export const GIVEN_UP_RETRY_MS = 10 * 60_000;

const FEE_OP_IDS = Object.keys(FEE_PAYMENT_OPS);

export interface FeeLegsBackfillDeps {
	readonly db: Pick<Database, 'query' | 'withTx'>;
	readonly blurt: Pick<BlurtClient, 'getBlock'>;
	readonly now?: () => number;
}

export interface FeeLegsBackfillSummary {
	/** Ops recorded this pass. */
	readonly recorded: number;
	/** Blocks that failed to fetch or did not hold the indexed transaction. */
	readonly fetchFailures: number;
	/** True when candidates are left for a later pass. */
	readonly backlog: boolean;
}

interface Candidate {
	readonly block_num: string;
	readonly trx_in_block: number;
	readonly op_in_trx: number;
	readonly trx_id: string;
	readonly block_time: Date;
	readonly signer: string;
	readonly op_id: string;
	readonly payload: unknown;
}

export class FeeLegsBackfill {
	private lastRunAt = Number.NEGATIVE_INFINITY;
	private done = false;
	private pass: Promise<void> | null = null;
	/** Fetch failures in a row per block number. */
	private readonly failures = new Map<string, number>();
	/** Blocks set aside after FETCH_FAILURES_PER_BLOCK failures, and when. */
	private readonly setAside = new Map<string, number>();

	constructor(private readonly deps: FeeLegsBackfillDeps) {}

	/** True once a pass found nothing left to record. */
	get finished(): boolean {
		return this.done;
	}

	/**
	 * Self-throttling, never throws, and only STARTS a pass, in the background:
	 * the block fetches go through the RPC pool (seconds each over Tor), and
	 * the poller loop must go on indexing meanwhile. One pass at a time; the
	 * next starts BACKLOG_INTERVAL_MS after the last one ENDED.
	 */
	async maybeRun(): Promise<void> {
		if (this.done || this.pass !== null) return;
		const clock = this.deps.now ?? Date.now;
		if (clock() - this.lastRunAt < BACKLOG_INTERVAL_MS) return;
		this.pass = (async () => {
			try {
				const s = await this.runOnce();
				if (s.recorded + s.fetchFailures > 0) {
					log.info('fee_legs_backfill_pass', {
						recorded: s.recorded,
						fetch_failures: s.fetchFailures,
						backlog: s.backlog
					});
				}
				if (!s.backlog) this.done = true;
			} catch (err) {
				log.error('fee_legs_backfill_failed', {}, err instanceof Error ? err : undefined);
			} finally {
				this.lastRunAt = clock();
				this.pass = null;
			}
		})();
	}

	/** Resolves when the pass out now (if any) has finished (shutdown, tests). */
	whenIdle(): Promise<void> {
		return this.pass ?? Promise.resolve();
	}

	/** One bounded pass. */
	async runOnce(): Promise<FeeLegsBackfillSummary> {
		const now = (this.deps.now ?? Date.now)();
		// Blocks set aside are left out until GIVEN_UP_RETRY_MS has passed, so
		// they never hold the queue; then they get FETCH_FAILURES_PER_BLOCK
		// fresh tries.
		for (const [b, at] of this.setAside) {
			if (now - at >= GIVEN_UP_RETRY_MS) {
				this.setAside.delete(b);
				this.failures.delete(b);
			}
		}
		const skip = [...this.setAside.keys()];
		// Sorted as a number (a ::text copy would put block 10 before 9).
		const blocks = await this.deps.db.query<{ block_num: string | number }>(
			`SELECT DISTINCT o.block_num
			   FROM ops o
			  WHERE o.op_id = ANY($1::text[])
			    AND NOT (o.block_num = ANY($2::bigint[]))
			    AND NOT EXISTS (SELECT 1 FROM fee_payments p
			                     WHERE p.block_num = o.block_num AND p.trx_in_block = o.trx_in_block
			                       AND p.op_in_trx = o.op_in_trx)
			  ORDER BY o.block_num
			  LIMIT $3`,
			[FEE_OP_IDS, skip, MAX_BLOCKS_PER_PASS + 1]
		);
		const todo = blocks.rows.slice(0, MAX_BLOCKS_PER_PASS).map((r) => String(r.block_num));
		// Not over while a block is set aside: it is tried again later.
		let backlog = blocks.rows.length > MAX_BLOCKS_PER_PASS || this.setAside.size > 0;
		let recorded = 0;
		let fetchFailures = 0;
		for (const blockNum of todo) {
			const ops = await this.deps.db.query<Candidate>(
				`SELECT o.block_num::text AS block_num, o.trx_in_block, o.op_in_trx, o.trx_id,
				        o.block_time, o.signer, o.op_id, o.payload
				   FROM ops o
				  WHERE o.block_num = $1 AND o.op_id = ANY($2::text[])
				    AND NOT EXISTS (SELECT 1 FROM fee_payments p
				                     WHERE p.block_num = o.block_num AND p.trx_in_block = o.trx_in_block
				                       AND p.op_in_trx = o.op_in_trx)
				  ORDER BY o.trx_in_block, o.op_in_trx`,
				[blockNum, FEE_OP_IDS]
			);
			const got = await this.fetchIndexed(blockNum, ops.rows);
			if (got === null || got.failed) {
				fetchFailures++;
				// Retried on the next passes, then after GIVEN_UP_RETRY_MS.
				backlog = true;
			} else {
				this.failures.delete(blockNum);
			}
			if (got === null) continue;
			const trxs = got.trxs;
			await this.deps.db.withTx(async (client) => {
				for (const op of ops.rows) {
					const trx = trxs.get(op.trx_in_block);
					if (trx === undefined) continue;
					await recordFeePayment(
						client,
						{
							blockNum: op.block_num,
							trxInBlock: op.trx_in_block,
							opInTrx: op.op_in_trx,
							trxId: op.trx_id,
							blockTime: op.block_time,
							signer: op.signer,
							opId: op.op_id,
							payload: op.payload
						},
						trx
					);
					recorded++;
				}
			});
		}
		return { recorded, fetchFailures, backlog };
	}

	/** The operations of each transaction this node indexed in `blockNum` that
	 *  `ops` lives in, re-fetched and proven by its id (as the dispatcher saw
	 *  them: pgSafeDeep). `failed` (and a failure counted) when one of them is
	 *  absent or not the indexed transaction — the others are still returned;
	 *  null when the block is unavailable. */
	private async fetchIndexed(
		blockNum: string,
		ops: readonly Candidate[]
	): Promise<{ trxs: Map<number, readonly ChainOperation[]>; failed: boolean } | null> {
		const fail = (why: string): void => {
			const n = (this.failures.get(blockNum) ?? 0) + 1;
			this.failures.set(blockNum, n);
			if (n >= FETCH_FAILURES_PER_BLOCK) this.setAside.set(blockNum, (this.deps.now ?? Date.now)());
			log.warn('fee_legs_fetch_failed', {
				block_num: blockNum,
				why,
				set_aside: n >= FETCH_FAILURES_PER_BLOCK
			});
		};
		let block;
		try {
			block = await this.deps.blurt.getBlock(Number(blockNum));
		} catch (err) {
			fail(err instanceof Error ? err.message.slice(0, 120) : 'fetch_error');
			return null;
		}
		const trxs = new Map<number, readonly ChainOperation[]>();
		const bad = new Set<string>();
		for (const op of ops) {
			if (trxs.has(op.trx_in_block)) continue;
			const trx = block?.transactions?.[op.trx_in_block];
			if (!trx) {
				bad.add('transaction_absent');
				continue;
			}
			const id = transactionIdOf({
				...trx,
				extensions: (trx as BlockTransaction & { extensions?: unknown[] }).extensions ?? []
			});
			if (id !== op.trx_id) {
				bad.add('transaction_id_mismatch');
				continue;
			}
			trxs.set(op.trx_in_block, pgSafeDeep(trx.operations));
		}
		if (bad.size > 0) fail([...bad].join(','));
		return { trxs, failed: bad.size > 0 };
	}
}
