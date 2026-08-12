/**
 * Morphit indexer — operator-registration reconciliation (cp710).
 *
 * THE GAP (documented in docs/REVISIT-LIST.md, from cp670).  The
 * dispatcher records every morphit op it sees into the `ops` event-log
 * table with a status of 'applied' or 'rejected'.  When an
 * `operator_register` op is REJECTED because of a validator BUG — not
 * because it's genuinely invalid — that rejection is permanent for this
 * indexer: blocks are processed once and never revisited, so a later
 * code fix doesn't retroactively apply the registration.  The operator
 * simply vanishes from this node's federated directory until they
 * re-broadcast.
 *
 * This bit us for real twice:
 *   - cp670: a display-name impersonation guard wrongly rejected every
 *     valid "Morphit <Region>" instance name → zero operators on every
 *     indexer.
 *   - cp671: a zero-width-non-joiner (U+200C) block rejected valid
 *     Persian display names.
 *
 * Each was fixed in the validator, but the ALREADY-rejected ops on
 * every deployed indexer stayed rejected.  Re-registration was the only
 * recovery.
 *
 * A naive "re-index the chain" is DANGEROUS: order/fee/feedback handlers
 * are NOT idempotent (re-applying a fee transfer double-counts), so a
 * blanket replay would corrupt materialised state.
 *
 * THE FIX (bounded + safe).  Replay ONLY the `operator_register` ops
 * that this indexer already recorded as 'rejected', straight from the
 * local `ops` table — no chain access, no other handler touched.  The
 * operatorRegister handler is idempotent by construction (it guards on
 * `account_already_registered` and every insert is `ON CONFLICT DO
 * NOTHING`), so:
 *   - a previously-rejected op that a validator fix now accepts →
 *     materialises the operator and flips its `ops` row to 'applied'
 *     (atomically, in one transaction);
 *   - an op that's STILL genuinely invalid (bad payload, tag really
 *     taken) → re-rejects, no state change, row stays 'rejected';
 *   - an op whose account is already registered (e.g. the operator
 *     re-broadcast in the meantime) → `account_already_registered`,
 *     no-op.
 *
 * So reconciliation is a safe no-op whenever there's nothing to heal,
 * and it self-heals the validator-bug case the moment the fixed indexer
 * boots.  It runs ONCE per boot (rejected registrations don't accrue
 * between blocks; a new rejection only appears when a new block is
 * processed, and that block's op is freshly evaluated by current code).
 *
 * BOUNDED: capped at RECONCILE_MAX_ROWS most-recent rejected
 * registrations.  operator_register ops are rare (one per operator per
 * instance, ever), so in practice every rejected row is covered; the
 * cap only guards against a pathological flood.
 *
 * SCOPE NOTE: this reconciles ops the indexer RECORDED-as-rejected.  A
 * truly *missed* op (a block the indexer never processed at all) is out
 * of scope here — the sequential poller doesn't skip blocks (it rolls
 * back and retries on error), and recovering a never-seen op would need
 * exactly the dangerous chain re-scan this design avoids.
 */

import type pg from 'pg';

import type { BlurtClient } from '$blurt/client';
import type { Config } from '$config';
import type { Handler, OpContext } from '$indexer/handler-contract';
import operatorRegisterHandler from '$indexer/handlers/operatorRegister';
import { OP_IDS } from '$indexer/dispatcher';

/** Cap on rejected registrations replayed per boot.  Generous — these
 *  ops are rare — but bounded so a flood can't turn boot into a scan. */
export const RECONCILE_MAX_ROWS = 5000;

/** The subset of Database this module needs.  Kept narrow so tests can
 *  supply a lightweight fake. */
export interface ReconcileDb {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<{ rows: R[] }>;
	withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
}

export interface ReconcileDeps {
	readonly db: ReconcileDb;
	readonly blurt: BlurtClient;
	readonly config: Config;
	readonly feeVerifiers: OpContext['feeVerifiers'];
	readonly feeAmounts: OpContext['feeAmounts'];
	readonly fiatToUsd: OpContext['fiatToUsd'];
	/** Injectable for tests; defaults to the real operatorRegister handler. */
	readonly handler?: Handler;
	/** Cap override (tests); defaults to RECONCILE_MAX_ROWS. */
	readonly maxRows?: number;
	/** Structured log sink; defaults to no-op. */
	readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface ReconcileSummary {
	readonly scanned: number;
	readonly healed: number;
	readonly stillRejected: number;
	readonly errored: number;
}

/** One rejected operator_register row from the `ops` table. */
interface RejectedRow {
	readonly block_num: string | number;
	readonly trx_in_block: number;
	readonly op_in_trx: number;
	readonly block_time: Date;
	readonly trx_id: string;
	readonly signer: string;
	readonly payload: unknown;
	readonly reject_reason: string | null;
}

/** Sentinel thrown to force a per-row transaction rollback when the
 *  replayed op is still (correctly) rejected — so any partial write is
 *  discarded and the row keeps its 'rejected' status.  Not an error. */
class StillRejected extends Error {
	constructor(readonly rejectReason: string) {
		super(`still_rejected:${rejectReason}`);
		this.name = 'StillRejected';
	}
}

/** Build the OpContext an operatorRegister replay needs.  The handler
 *  only reads payload/signer/blockNum/blockTime/trxId; the remaining
 *  fields are supplied inert (no-op recorders, empty siblingOps) or
 *  passed through from the poller's real deps so the type is satisfied
 *  and any accidental use of a chain/fee path behaves exactly as it
 *  would in a live block. */
function buildReplayCtx(row: RejectedRow, deps: ReconcileDeps): OpContext {
	return {
		blockNum: typeof row.block_num === 'string' ? Number(row.block_num) : row.block_num,
		trxInBlock: row.trx_in_block,
		opInTrx: row.op_in_trx,
		blockTime: row.block_time,
		trxId: row.trx_id,
		signer: row.signer,
		payload: row.payload,
		siblingOps: [],
		blurt: deps.blurt,
		config: deps.config,
		feeVerifiers: deps.feeVerifiers,
		feeAmounts: deps.feeAmounts,
		fiatToUsd: deps.fiatToUsd,
		recordOrderbookChange: () => {},
		recordChatChange: () => {}
	};
}

/**
 * Replay this indexer's rejected `operator_register` ops through the
 * (idempotent) handler, healing any that a validator fix now accepts.
 * Safe no-op when there's nothing to heal.  Returns a summary.
 */
export async function reconcileOperatorRegistrations(
	deps: ReconcileDeps
): Promise<ReconcileSummary> {
	const handler = deps.handler ?? operatorRegisterHandler;
	const maxRows = deps.maxRows ?? RECONCILE_MAX_ROWS;
	const log = deps.log ?? (() => {});

	// Uses the existing ops_op_id_idx (op_id, block_num DESC).  Only
	// rejected operator_register rows — never any other handler's ops.
	const { rows } = await deps.db.query<RejectedRow>(
		`SELECT block_num, trx_in_block, op_in_trx, block_time, trx_id,
		        signer, payload, reject_reason
		 FROM ops
		 WHERE op_id = $1 AND status = 'rejected'
		 ORDER BY block_num ASC
		 LIMIT $2`,
		[OP_IDS.operatorRegister, maxRows]
	);

	let healed = 0;
	let stillRejected = 0;
	let errored = 0;

	for (const row of rows) {
		try {
			await deps.db.withTx(async (client) => {
				const ctx = buildReplayCtx(row, deps);
				const result = await handler(ctx, client);
				if (result.ok) {
					// Flip the event-log row to 'applied' in the SAME
					// transaction as the materialisation, so either both
					// commit or neither does.  It won't be selected again.
					await client.query(
						`UPDATE ops SET status = 'applied', reject_reason = NULL
						 WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3`,
						[row.block_num, row.trx_in_block, row.op_in_trx]
					);
					return;
				}
				// Still rejected → roll back (discard any stray partial
				// write) and keep the row's 'rejected' status untouched.
				throw new StillRejected(result.reason ?? 'unknown');
			});
			healed++;
			log('reconcile_healed', { signer: row.signer, block_num: row.block_num });
		} catch (err) {
			if (err instanceof StillRejected) {
				stillRejected++;
				continue;
			}
			// Unexpected error replaying one row — count it and move on;
			// one bad row must not abort the whole reconciliation.
			errored++;
			log('reconcile_error', {
				signer: row.signer,
				block_num: row.block_num,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	const summary: ReconcileSummary = {
		scanned: rows.length,
		healed,
		stillRejected,
		errored
	};
	if (rows.length > 0) {
		log('reconcile_summary', { ...summary });
	}
	return summary;
}
