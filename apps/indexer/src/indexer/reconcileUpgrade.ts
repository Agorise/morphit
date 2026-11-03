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
 * 3. Orders in a coin this version knows (v1.22.0): every coin in its
 *    registry, not only the newest, so a node that lagged through an earlier
 *    coin's addition converges too. A node still on the
 *    version before a coin was added refuses an order in it ('asset_invalid')
 *    and a barter listing that accepts it ('accepted_assets_entry_unknown', or
 *    'accepted_assets_too_many' when it accepts more coins than that version
 *    knew). Once the node upgrades, those orders are replayed like the ones in
 *    REAPPLY_ORDER_REASONS, but only when every coin the payload names is in
 *    THIS version's registry: an order in a made-up ticker is never replayed,
 *    so no number of them costs a boot anything. Such an order usually paid
 *    its listing fee in BLURT, in the same transaction; the event log keeps
 *    those transfers (fee_payment_legs, recorded for every fee op whatever its
 *    verdict), and the replay gives the handler exactly those, so the fee
 *    reads as it did on a node that knew the coin. An order whose transfers
 *    are not recorded yet waits for a later boot: on a node that indexed it
 *    with v1.21.7 or older, the fee-legs back-fill records them in the
 *    background after this boot's replay (oldest block first), and the order
 *    shows at the first restart after the back-fill has reached it. These have their own scan, read in batches until none
 *    is left: rows of the scan above (a reason this version still gives for
 *    a malformed payload is read again at every boot) cannot starve it.
 *
 * Each replay judges the op AS OF ITS OWN POSITION in the chain
 * (OpContext.judgedOutOfOrder): later ops of the same account may already be
 * applied here, and the order handler's Sybil tier (countForSybilTierAtPosition:
 * orders created before it that were made in the 24 hours before it or still
 * live then) and first-buy check count only what existed at that point, as the
 * live pass did. An order and its
 * dependent ops are healed in ONE transaction. A dependent op is replayed only
 * when it was refused for the missing order (or its coin). A handler that
 * throws (or swallows a failed statement) is refused as the live pass refuses
 * it; anything else that fails (a passing database trouble, a lost
 * connection) undoes it all, for the next boot to try again, and that account
 * is not healed further this boot, so its later orders are not judged without
 * it (likewise for an order whose fee transfers are not recorded yet).
 *
 * WHAT A REPLAY CANNOT UNDO. Ops this node APPLIED while it refused the order
 * were judged without it, and stay as they were: a later order of the same
 * account priced at a tier one lower, a first-buy waiver granted to an
 * account whose first order was the refused one, a fee transaction ID a later
 * order claimed first (the replayed order then finds it taken), a permlink
 * the account used again for a later order (that order keeps it, and the
 * refused one stays refused: 'permlink_taken_since'), and the loyalty
 * milestones and BP delegations, which follow the order in which this
 * node verified the fees. Ops that cite the order
 * other than the four above (chat messages tagged with it, feature bids on it,
 * reviews citing it) were refused for a missing order and are not replayed:
 * they read state that has moved on since. Both are confined to the accounts
 * that used the new coin while this node lagged; upgrading before the coin's
 * first orders appear avoids them.
 * WHY REPLAYING IS SAFE HERE. The order handler's per-order-address and XMR
 * paths read only chain-derived state: the pin in force at the op's block
 * (releases, fixed above), the BTC numbering (a pure function of `ops` in
 * chain order), the op's own payload and block time, and the explorers (the
 * same ones every node asks; the re-check loop reconciles later answers). The
 * BLURT path reads the order's own fee transfers, which the replay rebuilds
 * from fee_payment_legs (every transfer from the signer with the order's memo,
 * up to MAX_LEGS_PER_FEE_OP — a real fee is one or two; a transaction carrying
 * more memo transfers than that is judged from the first ones only), and the
 * Sybil-tier count at the op's position. No BLURT-fee REJECTION is replayed: none is
 * in either list.
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
import { inSavepoint } from '$indexer/savepoint';
import { ASSET_TICKERS } from '@morphit/asset-registry';

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

/** Reasons an older order handler gave because a coin the order names was not
 *  in its registry. Replayed only when every coin the payload names is in
 *  this version's (see reapplyObsoleteRejections). */
export const REAPPLY_UNKNOWN_COIN_REASONS: readonly string[] = [
	'asset_invalid',
	'accepted_assets_entry_unknown',
	'accepted_assets_too_many'
];

/** Rows read per batch; both scans read batches until none is left. */
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

function ctxFor(
	row: OpRow,
	deps: UpgradeReconcileDeps,
	siblingOps: OpContext['siblingOps'] = []
): OpContext {
	return {
		blockNum: Number(row.block_num),
		trxInBlock: row.trx_in_block,
		opInTrx: row.op_in_trx,
		blockTime: new Date(row.block_time),
		trxId: row.trx_id,
		signer: row.signer,
		payload: row.payload,
		siblingOps,
		blurt: deps.blurt,
		config: deps.config,
		feeVerifiers: deps.feeVerifiers,
		feeAmounts: deps.feeAmounts,
		fiatToUsd: deps.fiatToUsd,
		recordOrderbookChange: () => {},
		recordChatChange: () => {},
		// Later ops of this account may already be applied here.
		judgedOutOfOrder: true
	};
}

/** The order's listing-fee transfers as its transaction carried them, from
 *  the event log: each recorded leg back at its own position, from the
 *  signer, with the order's memo. Everything the BLURT fee check reads. */
async function feeTransfersOf(
	row: OpRow,
	deps: UpgradeReconcileDeps
): Promise<OpContext['siblingOps']> {
	const p = row.payload as { permlink?: unknown } | null;
	if (typeof p?.permlink !== 'string') return [];
	const { rows } = await deps.db.query<{
		leg_op_in_trx: number;
		recipient: string;
		amount_milli: string;
	}>(
		`SELECT leg_op_in_trx, recipient, amount_milli::text AS amount_milli
		   FROM fee_payment_legs
		  WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3
		  ORDER BY leg_op_in_trx`,
		[row.block_num, row.trx_in_block, row.op_in_trx]
	);
	const ops: [string, Record<string, unknown>][] = [];
	for (const l of rows) {
		const milli = Number(l.amount_milli);
		ops[l.leg_op_in_trx] = [
			'transfer',
			{
				from: row.signer,
				to: l.recipient,
				amount: `${Math.floor(milli / 1000)}.${String(milli % 1000).padStart(3, '0')} BLURT`,
				memo: `morphit-fee:${p.permlink}`
			}
		];
	}
	return ops as unknown as OpContext['siblingOps'];
}

const DEPENDENT_HANDLERS: Readonly<Record<string, Handler>> = {
	[OP_IDS.orderReplace]: orderReplaceHandler,
	[OP_IDS.orderCancel]: orderCancelHandler,
	[OP_IDS.orderComplete]: orderCompleteHandler,
	[OP_IDS.feeAttest]: feeAttestHandler
};

/** The event-log columns a replay reads (OpRow). */
const OP_ROW_COLUMNS = `block_num::text AS block_num, trx_in_block, op_in_trx, block_time, trx_id,
		        signer, op_id, payload, reject_reason`;

export async function reapplyObsoleteRejections(
	deps: UpgradeReconcileDeps
): Promise<{ scanned: number; healed: number; dependentsHealed: number }> {
	const limit = deps.maxRows ?? REAPPLY_MAX_ROWS;
	const out = { scanned: 0, healed: 0, dependentsHealed: 0 };
	// Accounts not healed further this boot: one of their refused orders could
	// not be judged now (its heal was undone by a passing database trouble, or
	// its fee transfers are not recorded yet). Their later orders wait too: judged
	// without it, their Sybil tier and first-buy check would be short of it for
	// good. The next boot takes them up again, in chain order.
	const held = new Set<string>();
	const heal = async (row: OpRow): Promise<void> => {
		if (held.has(row.signer)) return;
		out.scanned++;
		const r = await healWithDependents(row, deps);
		if (r === 'undone') {
			held.add(row.signer);
			return;
		}
		if (r === null) return;
		out.healed++;
		out.dependentsHealed += r;
	};

	// (a) Reasons the v1.19 handler gave (REAPPLY_ORDER_REASONS). This version
	// still gives them for a payload that really is malformed, and such a row
	// keeps its reason after a replay, so it is read again at every boot. Every
	// row is read (in batches, in chain order), so none is left unhealed while a
	// later (b) order of its account is judged without it. Healed before (b),
	// whatever their chain order, and that is safe: these are BTC/XMR-fee
	// orders, whose verdicts never read the account's other orders, and a
	// replay counts only orders whose creating op came before its own
	// (countForSybilTierAtPosition, countPriorOrdersAsOf), so an (a) order
	// healed early is not counted by an earlier (b) order.
	for (let afterA: [string, number, number] = ['-1', 0, 0]; ; ) {
		const { rows } = await deps.db.query<OpRow>(
			`SELECT ${OP_ROW_COLUMNS}
			   FROM ops
			  WHERE op_id = $1 AND status = 'rejected' AND reject_reason = ANY($2::text[])
			    AND (block_num, trx_in_block, op_in_trx) > ($4::bigint, $5::int, $6::int)
			  ORDER BY ops.block_num ASC, trx_in_block ASC, op_in_trx ASC
			  LIMIT $3`,
			[OP_IDS.order, REAPPLY_ORDER_REASONS, limit, ...afterA]
		);
		for (const row of rows) await heal(row);
		if (rows.length < limit) break;
		const last = rows[rows.length - 1]!;
		afterA = [last.block_num, last.trx_in_block, last.op_in_trx];
	}

	// (b) Orders in a coin this version knows that an older version refused for
	// not knowing it. Its own scan, so rows of (a) cannot fill the batch and
	// starve it. Every row it reads leaves it: a coin this version knows is
	// never refused for being unknown, so the replay applies the order or
	// refuses it for another reason. Read in batches, in chain order, until none
	// is left, so a node that lagged behind a burst of such orders converges in
	// one boot. A barter listing accepts at most every coin there is; one naming
	// a coin this version does not know stays refused, so it is not replayed.
	const tickers = [...ASSET_TICKERS] as string[];
	let after: [string, number, number] = ['-1', 0, 0];
	for (;;) {
		const { rows } = await deps.db.query<OpRow & { has_fee_rows: boolean }>(
			`SELECT ${OP_ROW_COLUMNS},
			        EXISTS (SELECT 1 FROM fee_payments fp
			                 WHERE fp.block_num = ops.block_num AND fp.trx_in_block = ops.trx_in_block
			                   AND fp.op_in_trx = ops.op_in_trx) AS has_fee_rows
			   FROM ops
			  WHERE op_id = $1 AND status = 'rejected'
			    AND (block_num, trx_in_block, op_in_trx) > ($5::bigint, $6::int, $7::int)
			    AND reject_reason = ANY($2::text[])
			    AND payload->>'asset' = ANY($3::text[])
			    AND CASE WHEN jsonb_typeof(payload->'accepted_assets') = 'array'
			             THEN jsonb_array_length(payload->'accepted_assets') <= cardinality($3::text[])
			                  AND NOT EXISTS (
			                    SELECT 1 FROM jsonb_array_elements(payload->'accepted_assets') e
			                     WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') <> ALL($3::text[]))
			             ELSE true END
			  ORDER BY ops.block_num ASC, trx_in_block ASC, op_in_trx ASC
			  LIMIT $4`,
			[OP_IDS.order, REAPPLY_UNKNOWN_COIN_REASONS, tickers, limit, ...after]
		);
		for (const row of rows) {
			// Its fee transfers are not recorded yet (an op indexed by v1.21.7 or
			// older; the back-fill records them in the background): it waits, and
			// so do its account's later orders.
			if (!row.has_fee_rows) {
				if (!held.has(row.signer))
					deps.log?.('upgrade_reapply_waiting_for_fee_rows', {
						block_num: row.block_num,
						signer: row.signer
					});
				held.add(row.signer);
			} else await heal(row);
		}
		if (rows.length < limit) break;
		const last = rows[rows.length - 1]!;
		after = [last.block_num, last.trx_in_block, last.op_in_trx];
	}
	return out;
}

/**
 * Replay one refused order op and, in the SAME transaction, the owner's later
 * replace/cancel/complete ops for that permlink and the attestations for it
 * that were refused because the order was missing, in chain order. One
 * transaction, so a crash between the two cannot leave the order healed and
 * its cancel refused for good (a later boot would not pick the cancel up: its
 * order no longer needs healing). "Later" is the order the live pass applied
 * them in: every op of a later block, and every op of the order's own block
 * (applyBlock runs a block's order ops before its other ops). Each dependent
 * runs in its own savepoint: one that is still refused keeps its (current)
 * reason and the rest go on; one whose handler throws, or swallows a failed
 * statement, is recorded as the live pass records it ('handler_threw:…',
 * 'handler_aborted_tx') and the rest go on; anything else (a passing database
 * trouble in or out of a handler, a lost connection, a failed savepoint)
 * undoes the whole heal, which the next boot tries again. The order handler
 * itself is classified the same way (liveReasonForThrow). Returns how many dependents now
 * apply; null when the order is still refused (its new reason recorded);
 * 'undone' when a passing trouble undid the heal (the caller then holds the
 * account for this boot).
 */
async function healWithDependents(
	row: OpRow,
	deps: UpgradeReconcileDeps
): Promise<number | null | 'undone'> {
	const fees = await feeTransfersOf(row, deps);
	try {
		return await deps.db.withTx(async (c) => {
			// The account posted another order under the same permlink since,
			// and this node applied it. On a node that knew the coin the refused
			// order holds the permlink and that later op was a no-op; here the
			// later order holds it, and may have been traded on. Replayed, the
			// order would be marked applied while the row stays the later
			// order's, and its cancel would end that one: so it stays refused,
			// and the difference is one of those a replay cannot undo.
			const pl = (row.payload as { permlink?: unknown } | null)?.permlink;
			if (typeof pl === 'string') {
				const taken = await c.query(`SELECT 1 FROM orders WHERE account = $1 AND permlink = $2`, [
					row.signer,
					pl
				]);
				if ((taken.rowCount ?? 0) > 0) throw new StillRejected('permlink_taken_since');
			}
			const r = await runHandler(orderHandler, ctxFor(row, deps, fees), c);
			if (!r.ok) throw new StillRejected(r.reason ?? 'unknown');
			await markApplied(c, row);
			const p = row.payload as { permlink?: unknown } | null;
			if (typeof p?.permlink !== 'string') return 0;
			const { rows: later } = await c.query<OpRow>(
				`SELECT ${OP_ROW_COLUMNS}
				   FROM ops
				  WHERE status = 'rejected'
				    -- After the order in the order the live pass applied them: later
				    -- blocks, and any op of the order's own block — these are not
				    -- order ops, and applyBlock runs a block's order ops before the
				    -- others (sortOpsForAdmission), whatever their transaction.
				    AND (block_num > $1::bigint
				         OR (block_num = $1::bigint AND NOT (trx_in_block = $2::int AND op_in_trx = $3::int)))
				    AND ((op_id = ANY($4::text[]) AND signer = $5 AND payload->>'permlink' = $6)
				         OR (op_id = $7 AND payload->>'order_account' = $5 AND payload->>'order_permlink' = $6))
				    -- Only what the missing order (or its coin) caused: an op the
				    -- dispatcher refused before any handler ran (invalid_text …), or
				    -- that its handler refused for anything else, is refused on every
				    -- node and stays so.
				    AND reject_reason = ANY($8::text[])
				  ORDER BY ops.block_num ASC, trx_in_block ASC, op_in_trx ASC`,
				[
					row.block_num,
					row.trx_in_block,
					row.op_in_trx,
					[OP_IDS.orderReplace, OP_IDS.orderCancel, OP_IDS.orderComplete],
					row.signer,
					p.permlink,
					OP_IDS.feeAttest,
					DEPENDENT_REASONS
				]
			);
			let n = 0;
			for (const d of later) {
				const h = DEPENDENT_HANDLERS[d.op_id];
				if (h === undefined) continue;
				try {
					await inSavepoint(c, 'upgrade_reapply_dependent', async () => {
						const dr = await runHandler(h, ctxFor(d, deps), c);
						if (!dr.ok) throw new StillRejected(dr.reason ?? 'unknown');
						await markApplied(c, d);
					});
					n++;
				} catch (err) {
					if (err instanceof StillRejected) {
						await recordReason(c, d, err.reason);
						continue;
					}
					// A handler that threw, or swallowed a failed statement, is
					// refused as the live pass refuses it ('handler_threw:…',
					// 'handler_aborted_tx'), so a fresh node holds the same and the
					// heal goes on (undone instead, a handler that always throws
					// would block the order for good). Anything else — a passing
					// database trouble, a lost connection, a failed savepoint — undoes
					// the whole heal, order included, so the next boot tries both
					// again. Kept, the order would be healed and this op refused for
					// good: no later boot picks it up, its order no longer needing a
					// heal.
					const reason = liveReasonForThrow(err);
					if (reason === null)
						throw new PassingTrouble(
							`dependent op at block ${d.block_num} (${d.op_id}): ${errorText(err)}`
						);
					await recordReason(c, d, reason);
				}
			}
			return n;
		});
	} catch (err) {
		if (err instanceof StillRejected) {
			await recordReason(deps.db, row, err.reason);
			return null;
		}
		deps.log?.('upgrade_reapply_error', {
			block_num: row.block_num,
			error: errorText(err)
		});
		// The order handler threw (or swallowed a failed statement): refused as
		// the live pass refuses it. Anything else (a passing trouble, a lost
		// connection, a dependent's): the next boot tries again, and the account
		// waits.
		const reason = err instanceof PassingTrouble ? null : liveReasonForThrow(err);
		if (reason === null) return 'undone';
		await recordReason(deps.db, row, reason);
		return null;
	}
}

/** Reasons a dependent op got because its order (or the order's coin) was
 *  missing on the node that indexed it: the ones a replay may change. */
const DEPENDENT_REASONS: readonly string[] = [
	'target_not_found',
	'order_not_found',
	...REAPPLY_UNKNOWN_COIN_REASONS
];

class PassingTrouble extends Error {}

/** A throw out of a handler itself (not out of the replay's own statements). */
export class HandlerThrew extends Error {
	constructor(readonly inner: unknown) {
		super(errorText(inner));
	}
}

/** Run a handler, wrapping what it throws in HandlerThrew. */
async function runHandler(
	h: Handler,
	ctx: OpContext,
	c: pg.PoolClient
): Promise<Awaited<ReturnType<Handler>>> {
	try {
		return await h(ctx, c);
	} catch (err) {
		throw new HandlerThrew(err);
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The reason the live dispatcher records for `err`, or null when the live pass
 * would not have refused the op for it (the replay is undone instead, for the
 * next boot). The dispatcher records 'handler_threw:<message>' for a handler
 * that throws — whatever it throws, an aborted-transaction error included —
 * and 'handler_aborted_tx' for one that returned ok on an aborted transaction
 * (its RELEASE failed; here, the statement after it). A handler's throw on a
 * passing database trouble, and anything thrown outside a handler but 25P02,
 * are not the op's fault: null.
 */
export function liveReasonForThrow(err: unknown): string | null {
	if (err instanceof HandlerThrew) {
		if (isPassingDbTrouble(err.inner)) return null;
		return err.inner instanceof Error
			? `handler_threw:${err.inner.message.slice(0, 120)}`
			: 'handler_threw';
	}
	if ((err as { code?: unknown } | null)?.code === '25P02') return 'handler_aborted_tx';
	return null;
}

/** A database error that passes by itself: the connection went (class 08,
 *  admin shutdown 57P0x), the statement was cancelled or timed out (57014),
 *  a serialization failure or deadlock (40001, 40P01), a lock not obtained or
 *  an object in use (55P03, 55006), the server ran short (53xxx) or hit an I/O
 *  error (58xxx); a Node.js system error (ECONNRESET, EPIPE, EHOSTDOWN …) or
 *  closed-socket stream error; or, otherwise, a driver error saying the
 *  connection ended, is not queryable or timed out. */
export function isPassingDbTrouble(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	// A Node.js system error (ECONNRESET, EPIPE, EHOSTDOWN …; EPIPE also has
	// five letters, and no SQLSTATE class starts with E): on a database call,
	// the socket or the host. Also the stream errors of a socket that closed.
	if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return true;
	if (
		typeof code === 'string' &&
		/^ERR_(?:STREAM_DESTROYED|STREAM_PREMATURE_CLOSE|STREAM_WRITE_AFTER_END|SOCKET_CLOSED)$/.test(
			code
		)
	)
		return true;
	if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
		// A PostgreSQL error: its SQLSTATE decides, never its message (which may
		// quote the op's own text).
		if (/^(08|53|58)/.test(code) || /^57P0/.test(code)) return true;
		return ['57014', '40001', '40P01', '55P03', '55006'].includes(code);
	}
	const msg = err instanceof Error ? err.message : String(err);
	return /Connection terminated|connection (?:ended|closed|refused|reset)|not queryable|Client was closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|statement timeout|canceling statement|timeout exceeded/i.test(
		msg
	);
}

async function markApplied(c: pg.PoolClient, row: OpRow): Promise<void> {
	await c.query(
		`UPDATE ops SET status = 'applied', reject_reason = NULL
		  WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3`,
		[row.block_num, row.trx_in_block, row.op_in_trx]
	);
}

/** A still-refused op keeps its row with the CURRENT reason, so the scan does
 *  not pick it up again for an obsolete one. */
async function recordReason(
	db: { query(text: string, params: unknown[]): Promise<unknown> },
	row: OpRow,
	reason: string
): Promise<void> {
	if (reason === row.reject_reason) return;
	await db.query(
		`UPDATE ops SET reject_reason = $4
		  WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3 AND status = 'rejected'`,
		[row.block_num, row.trx_in_block, row.op_in_trx, reason]
	);
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
