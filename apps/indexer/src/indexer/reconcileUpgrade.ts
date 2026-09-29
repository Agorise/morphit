/**
 * Morphit indexer — converge with the federation after an upgrade that
 * taught the handlers something new (v1.20.0, V3-1).
 *
 * THE PROBLEM. The dispatcher records every Morphit op in `ops` with its RAW
 * payload, but the handlers of the version that indexed it decided what went
 * into materialised state. A node still on v1.19 when the v1.20.0 release op
 * arrives (morphitir and morphitlat, by the ceremony's order) stores that
 * release with the treasury block rebuilt from the fields v1.19 knew —
 * `btc: {address, satoshis}`, no `xpub`, no `xmr.primary_address` — and, until
 * it upgrades, REJECTS every per-order-address BTC order (no txid) and every
 * XMR order carrying a `tx_key` instead of an OutProof. Nothing re-reads those
 * rows, so after upgrading it would number fee addresses, bind XMR payments
 * and list orders differently from every node that indexed the same blocks on
 * v1.20 — for good. (And `treasury-repin-broadcast.ts --node <it>` would carry
 * the stripped treasury into the next release op, dropping the xpub for
 * everyone; that tool now reads the op from chain instead.)
 *
 * THE FIX, run at every boot before the poller applies a block (all
 * idempotent, all from the local event log — no chain access):
 *
 * 1. backfillReleaseRows — every release row (valid or not) whose op is in
 *    `ops` is re-validated with the CURRENT release validator (the handler's
 *    own `validate`), and its `treasury` and `distribution` columns are
 *    rewritten to what the current handler stores. A payload the current
 *    validator REFUSES (e.g. a malformed new block an older node ignored) is
 *    what a fresh node never stored: the row is made invalid and the op marked
 *    rejected with that reason, exactly as a fresh node's log reads. The trust
 *    verdict (`valid` from signer + key) is left alone —
 *    it came from a chain read at indexing time that cannot be repeated.
 *    When any pin changed, the per-order BTC address cache
 *    (btc_fee_address_log, rebuildable from `ops` + `releases`) is emptied.
 *
 * 2. reapplyObsoleteRejections — `morphit_order_v1` ops that were rejected
 *    for a reason the current handler may no longer give (the list below, one
 *    entry per reason an OLDER handler gave for a payload the current one
 *    accepts) are replayed through the current order handler at their own
 *    block (ctx from the event log), in chain order, one transaction each —
 *    the same pattern as reconcileOperatorRegistrations. An op that now applies
 *    is flipped to 'applied'; one that is still refused gets the current
 *    reason. For every order that was healed, the owner's later
 *    replace/cancel/complete ops for that permlink and attestations for it that
 *    were rejected (they found no order) are replayed after it, in chain
 *    order, so a listing cancelled while this node could not see it is
 *    cancelled here too.
 *
 * WHY REPLAYING IS SAFE HERE. The order handler's per-order-address and XMR
 * paths read only chain-derived state: the pin in force at the op's block
 * (releases, fixed above), the BTC numbering (a pure function of `ops` in
 * chain order), the op's own payload and block time, and the explorers (the
 * same ones every node asks; the re-check loop reconciles later answers). The
 * BLURT path, which depends on sibling transfers and fee-transfer tables, is
 * never replayed: no BLURT-fee rejection is in the list.
 *
 * Proven in test/integration/upgrade-convergence-v3.test.ts: a node that
 * indexed the release and the following orders "as v1.19 did" converges with
 * a node that indexed them on v1.20.
 */
import type pg from 'pg';

import type { BlurtClient } from '$blurt/client';
import type { Config } from '$config';
import type { Handler, OpContext } from '$indexer/handler-contract';
import { OP_IDS } from '$indexer/dispatcher';
import orderHandler from '$indexer/handlers/order';
import orderReplaceHandler from '$indexer/handlers/orderReplace';
import orderCancelHandler from '$indexer/handlers/orderCancel';
import orderCompleteHandler from '$indexer/handlers/orderComplete';
import feeAttestHandler from '$indexer/handlers/feeAttest';
import { validateReleaseOp } from '$indexer/handlers/release';

/** Reasons an older order handler gave for payloads the current one may
 *  accept. Append (never remove) when a version widens what it accepts. */
export const REAPPLY_ORDER_REASONS: readonly string[] = [
	// v1.19: fee_method 'btc' without a txid (per-order address, v1.20 MK-H2)
	'external_tx_id_required_for_btc_xmr',
	// v1.19: XMR with a tx_key instead of an OutProof (v1.20 M-X1)
	'tx_proof_required_for_xmr',
	'tx_proof_malformed_prefix',
	'tx_proof_malformed_length',
	'tx_proof_malformed_charset'
];

export const REAPPLY_MAX_ROWS = 5000;

export interface UpgradeReconcileDb {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<{ rows: R[]; rowCount?: number | null }>;
	withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
}

export interface UpgradeReconcileDeps {
	readonly db: UpgradeReconcileDb;
	readonly blurt: BlurtClient;
	readonly config: Config;
	readonly feeVerifiers: OpContext['feeVerifiers'];
	readonly feeAmounts: OpContext['feeAmounts'];
	readonly fiatToUsd: OpContext['fiatToUsd'];
	readonly maxRows?: number;
	readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

// ─── 1. Release rows ─────────────────────────────────────────────

export async function backfillReleaseRows(
	db: UpgradeReconcileDb
): Promise<{ rewritten: number; invalidated: number }> {
	const { rows } = await db.query<{
		id: string;
		payload: unknown;
		block_num: string;
		trx_in_block: number;
		op_in_trx: number;
	}>(
		`SELECT r.id::text AS id, o.payload, o.block_num::text AS block_num, o.trx_in_block, o.op_in_trx
		   FROM releases r
		   JOIN ops o ON o.trx_id = r.source_trx_id AND o.block_num = r.source_block_num
		              AND o.op_id = $1 AND o.status = 'applied'
		  ORDER BY r.source_block_num ASC`,
		[OP_IDS.releaseDiscovery]
	);
	let rewritten = 0;
	let invalidated = 0;
	for (const r of rows) {
		const v = validateReleaseOp(r.payload);
		if ('reason' in v) {
			await db.withTx(async (c) => {
				await c.query(
					`UPDATE releases SET valid = false, invalid_reason = $2 WHERE id = $1::bigint`,
					[r.id, `rejected_on_revalidation:${v.reason}`.slice(0, 200)]
				);
				await c.query(
					`UPDATE ops SET status = 'rejected', reject_reason = $4
					  WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3`,
					[r.block_num, r.trx_in_block, r.op_in_trx, v.reason]
				);
			});
			invalidated++;
			continue;
		}
		const upd = await db.query(
			`UPDATE releases
			    SET treasury = CASE WHEN $2::text IS NULL THEN NULL ELSE $2::jsonb END,
			        distribution = CASE WHEN $3::text IS NULL THEN NULL ELSE $3::jsonb END
			  WHERE id = $1::bigint
			    AND (treasury IS DISTINCT FROM (CASE WHEN $2::text IS NULL THEN NULL ELSE $2::jsonb END)
			         OR distribution IS DISTINCT FROM (CASE WHEN $3::text IS NULL THEN NULL ELSE $3::jsonb END))`,
			[r.id, v.treasury_serialized, v.distribution_serialized]
		);
		rewritten += upd.rowCount ?? 0;
	}
	if (rewritten + invalidated > 0) {
		// Numbering cache: rebuilt from ops + releases on the next BTC-fee order.
		await db.query(`DELETE FROM btc_fee_address_log`);
	}
	return { rewritten, invalidated };
}

// ─── 2. Order ops an older handler refused ──────────────────────

interface OpRow {
	block_num: string;
	trx_in_block: number;
	op_in_trx: number;
	block_time: Date;
	trx_id: string;
	signer: string;
	op_id: string;
	payload: unknown;
	reject_reason: string | null;
}

class StillRejected extends Error {
	constructor(readonly reason: string) {
		super(`still_rejected:${reason}`);
	}
}

function ctxFor(row: OpRow, deps: UpgradeReconcileDeps): OpContext {
	return {
		blockNum: Number(row.block_num),
		trxInBlock: row.trx_in_block,
		opInTrx: row.op_in_trx,
		blockTime: new Date(row.block_time),
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

/** Replay one rejected op; true when it now applies. */
async function replay(row: OpRow, handler: Handler, deps: UpgradeReconcileDeps): Promise<boolean> {
	try {
		await deps.db.withTx(async (c) => {
			const r = await handler(ctxFor(row, deps), c);
			if (!r.ok) throw new StillRejected(r.reason ?? 'unknown');
			await c.query(
				`UPDATE ops SET status = 'applied', reject_reason = NULL
				  WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3`,
				[row.block_num, row.trx_in_block, row.op_in_trx]
			);
		});
		return true;
	} catch (err) {
		if (err instanceof StillRejected) {
			if (err.reason !== row.reject_reason) {
				await deps.db.query(
					`UPDATE ops SET reject_reason = $4
					  WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3 AND status = 'rejected'`,
					[row.block_num, row.trx_in_block, row.op_in_trx, err.reason]
				);
			}
			return false;
		}
		deps.log?.('upgrade_reapply_error', {
			block_num: row.block_num,
			error: err instanceof Error ? err.message : String(err)
		});
		return false;
	}
}

const DEPENDENT_HANDLERS: Readonly<Record<string, Handler>> = {
	[OP_IDS.orderReplace]: orderReplaceHandler,
	[OP_IDS.orderCancel]: orderCancelHandler,
	[OP_IDS.orderComplete]: orderCompleteHandler,
	[OP_IDS.feeAttest]: feeAttestHandler
};

export async function reapplyObsoleteRejections(
	deps: UpgradeReconcileDeps
): Promise<{ scanned: number; healed: number; dependentsHealed: number }> {
	const { rows } = await deps.db.query<OpRow>(
		`SELECT block_num::text AS block_num, trx_in_block, op_in_trx, block_time, trx_id, signer,
		        op_id, payload, reject_reason
		   FROM ops
		  WHERE op_id = $1 AND status = 'rejected' AND reject_reason = ANY($2::text[])
		  ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC
		  LIMIT $3`,
		[OP_IDS.order, REAPPLY_ORDER_REASONS, deps.maxRows ?? REAPPLY_MAX_ROWS]
	);
	let healed = 0;
	let dependentsHealed = 0;
	for (const row of rows) {
		if (!(await replay(row, orderHandler, deps))) continue;
		healed++;
		const p = row.payload as { permlink?: unknown } | null;
		if (typeof p?.permlink !== 'string') continue;
		const deps2 = await deps.db.query<OpRow>(
			`SELECT block_num::text AS block_num, trx_in_block, op_in_trx, block_time, trx_id, signer,
			        op_id, payload, reject_reason
			   FROM ops
			  WHERE status = 'rejected'
			    AND (block_num, trx_in_block, op_in_trx) > ($1::bigint, $2::int, $3::int)
			    AND ((op_id = ANY($4::text[]) AND signer = $5 AND payload->>'permlink' = $6)
			         OR (op_id = $7 AND payload->>'order_account' = $5 AND payload->>'order_permlink' = $6))
			  ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC`,
			[
				row.block_num,
				row.trx_in_block,
				row.op_in_trx,
				[OP_IDS.orderReplace, OP_IDS.orderCancel, OP_IDS.orderComplete],
				row.signer,
				p.permlink,
				OP_IDS.feeAttest
			]
		);
		for (const d of deps2.rows) {
			const h = DEPENDENT_HANDLERS[d.op_id];
			if (h !== undefined && (await replay(d, h, deps))) dependentsHealed++;
		}
	}
	return { scanned: rows.length, healed, dependentsHealed };
}

/** Both steps, releases first (the replay needs the corrected pins). The
 *  caller refreshes its fee verifiers between the two (`beforeReapply`). */
export async function reconcileAfterUpgrade(
	deps: UpgradeReconcileDeps & { readonly beforeReapply?: () => Promise<void> }
): Promise<void> {
	const log = deps.log ?? (() => {});
	try {
		const r = await backfillReleaseRows(deps.db);
		if (r.rewritten + r.invalidated > 0) log('upgrade_release_rows_backfilled', { ...r });
	} catch (err) {
		log('upgrade_release_backfill_error', {
			error: err instanceof Error ? err.message : String(err)
		});
	}
	try {
		await deps.beforeReapply?.();
		const r = await reapplyObsoleteRejections(deps);
		if (r.healed > 0) log('upgrade_rejections_reapplied', { ...r });
	} catch (err) {
		log('upgrade_reapply_failed', { error: err instanceof Error ? err.message : String(err) });
	}
}
