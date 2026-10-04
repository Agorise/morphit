/**
 * Morphit indexer — operator-registration reconciliation.
 *
 * THE GAP (documented in the project backlog).  The
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
 *   - a display-name impersonation guard wrongly rejected every
 *     valid "Morphit <Region>" instance name → zero operators on every
 *     indexer.
 *   - a zero-width-non-joiner (U+200C) block rejected valid
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
 * local `ops` table — no chain access, no other handler touched.
 *
 * THE REGISTER OP IS AN UPSERT keyed on the signing account (a
 * re-registration UPDATES origin, name, contact and addresses), so a replay is
 * NOT idempotent by construction. What keeps it safe (v1.20.0, E5):
 *   - rows whose signer has an APPLIED registration at a LATER block are never
 *     selected — the operator's newer registration is the truth, and replaying
 *     the older one over it reverted it (origin, name, directory row and probe
 *     history) the first time a validator fix made the old op acceptable;
 *   - the handler itself refuses a registration older than the newest one it
 *     applied (`superseded_by_newer_registration`), as a second line;
 * and then:
 *   - a previously-rejected op that a validator fix now accepts →
 *     materialises the operator and flips its `ops` row to 'applied'
 *     (atomically, in one transaction);
 *   - an op that's STILL genuinely invalid (bad payload, tag really
 *     taken, tag_immutable) → re-rejects, no state change, row stays
 *     'rejected'.
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
 * FEE-RECIPIENT HISTORY (v1.20.0, G1). A healed registration that carries
 * `fee_recipient` records it through the handler, at the op's ORIGINAL block.
 * Separately, `backfillFeeRecipientHistory` (run at the end of every
 * reconcile) records the field for register ops an OLDER build APPLIED
 * without reading it — every v1.19.x indexer accepted the field and kept the
 * whole payload in `ops`, so an operator who re-registers while a box still
 * runs v1.19.x is not lost when that box upgrades, and a node restored from a
 * pre-v1.20 snapshot rebuilds the history from the event log it carries. Only
 * payloads the CURRENT validator accepts are recorded, keyed exactly as the
 * live handler keys them, so the rows are identical to a live replay's.
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
import operatorRegisterHandler, {
	validate as validateRegistration
} from '$indexer/handlers/operatorRegister';
import { OP_IDS } from '$indexer/dispatcher';
import { recordFeeRecipient } from '$indexer/feeRecipients';

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
	//
	// EXCLUDE superseded rows (v1.20.0, E5): a later APPLIED registration by the
	// same signer is the operator's current word; replaying an older op over it
	// is a revert, whatever the older op's reject reason was (the original
	// validator reason is kept on a row that stayed rejected, so the
	// `account_already_registered` filter below never caught these).
	//
	// EXCLUDE historical `account_already_registered` rejections: since register
	// is now an account-keyed UPSERT (a re-registration updates the origin), those
	// old rows would re-apply as updates on reboot. In block-ASC order that would
	// usually converge correctly, but a rejected op OLDER than a later APPLIED
	// update would overwrite the newer origin — a revert. They were correct
	// rejections under the prior one-time semantics, not validator bugs, so they
	// must not be healed. New re-registrations apply live during indexing; an
	// operator whose origin is stale simply re-registers once.
	const { rows } = await deps.db.query<RejectedRow>(
		`SELECT block_num, trx_in_block, op_in_trx, block_time, trx_id,
		        signer, payload, reject_reason
		 FROM ops
		 WHERE op_id = $1 AND status = 'rejected'
		   AND reject_reason IS DISTINCT FROM 'account_already_registered'
		   -- v1.20.0 (V3-11): a payload that held a NUL or an unpaired surrogate is
		   -- stored with U+FFFD in their place. That copy is not what the signer
		   -- signed, and no validator fix makes it so: never healed.
		   AND reject_reason IS DISTINCT FROM 'invalid_text'
		   AND NOT EXISTS (
		       SELECT 1 FROM ops later
		        WHERE later.op_id = $1 AND later.status = 'applied'
		          AND later.signer = ops.signer AND later.block_num > ops.block_num)
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

	// G1 — after the heals (which record their own history rows), record the
	// fee_recipient of registrations an older build applied. Best-effort: a
	// failure here must not fail the reconcile.
	try {
		const backfilled = await backfillFeeRecipientHistory(deps.db, maxRows);
		if (backfilled > 0) log('fee_recipient_history_backfilled', { rows: backfilled });
	} catch (err) {
		log('fee_recipient_history_backfill_error', {
			error: err instanceof Error ? err.message : String(err)
		});
	}
	return summary;
}

/** One applied operator_register row carrying `fee_recipient`. */
interface AppliedRegisterRow {
	readonly block_num: string | number;
	readonly trx_in_block: number;
	readonly op_in_trx: number;
	readonly trx_id: string;
	readonly signer: string;
	readonly payload: unknown;
}

/**
 * v1.20.0 (G1) — record `fee_recipient` for APPLIED register ops that have no
 * history row yet (applied by an older build, which ignored the field; or
 * carried in from a pre-v1.20 snapshot). Idempotent: rows already recorded
 * are not selected, and a payload the current validator refuses is skipped —
 * exactly the ops the live handler would not have recorded. Returns how many
 * rows it wrote.
 *
 * (V3-8) Only rows whose `fee_recipient` HAS the account-name shape are
 * selected (empty / null / malformed ones can never be recorded), and the scan
 * walks the event log in chain order in pages of `pageSize` with a cursor, so
 * a row the validator refuses for another reason is passed over — it can no
 * longer sit in a LIMIT window forever hiding every later registration.
 */
export async function backfillFeeRecipientHistory(
	db: ReconcileDb,
	pageSize: number = RECONCILE_MAX_ROWS
): Promise<number> {
	let written = 0;
	let cursor: [string, number, number] = ['-1', 0, 0];
	for (;;) {
		const { rows } = await db.query<AppliedRegisterRow>(
			`SELECT block_num::text AS block_num, trx_in_block, op_in_trx, trx_id, signer, payload
			   FROM ops
			  WHERE op_id = $1 AND status = 'applied'
			    AND jsonb_typeof(payload) = 'object'
			    AND jsonb_typeof(payload->'fee_recipient') = 'string'
			    AND payload->>'fee_recipient' ~ '^[a-z][a-z0-9.-]{1,14}[a-z0-9]$'
			    AND (block_num, trx_in_block, op_in_trx) > ($3::bigint, $4::int, $5::int)
			    AND NOT EXISTS (
			        SELECT 1 FROM operator_fee_recipients f
			         WHERE f.account = ops.signer AND f.effective_block = ops.block_num
			           AND f.effective_trx = ops.trx_id)
			  ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC
			  LIMIT $2`,
			[OP_IDS.operatorRegister, pageSize, cursor[0], cursor[1], cursor[2]]
		);
		for (const row of rows) {
			const v = validateRegistration(row.payload);
			if ('reason' in v || v.fee_recipient === null) continue;
			await recordFeeRecipient(db, {
				account: row.signer,
				feeRecipient: v.fee_recipient,
				blockNum: Number(row.block_num),
				trxId: row.trx_id,
				trxInBlock: row.trx_in_block,
				opInTrx: row.op_in_trx
			});
			written++;
		}
		if (rows.length < pageSize) break;
		const last = rows[rows.length - 1]!;
		cursor = [String(last.block_num), last.trx_in_block, last.op_in_trx];
	}
	return written;
}
