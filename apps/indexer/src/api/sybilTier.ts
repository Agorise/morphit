/**
 * How many of an account's orders count toward its Sybil fee tier at a given
 * time (ADR-0009 §4): live at that time (stored live and not past expires_at)
 * OR created in the 24 hours before it, even if since cancelled. The order
 * about to be posted is the (count + 1)-th.
 *
 * One definition for the order handler, which prices the fee it verifies, and
 * for GET /v1/orders/:account/sybil_tier, which a client quotes the fee from.
 * Clients used to derive the count from the newest 100 orders of
 * /v1/orders/:account; an account with more than 100 orders was quoted a
 * lower tier than the indexer then charged, and the order's fee was lost.
 *
 * `at` is the block time on the handler side (identical across instances); a
 * quote passes the current time. This reads the orders table as it stands, so
 * it is the count AT the op only when no later op has been applied yet: true
 * in the live pass. An op judged after later ops of the same account were
 * applied uses countForSybilTierAsOf (the fee re-check, unchanged since
 * v1.20.0) or countForSybilTierAtPosition (the upgrade replay).
 */

export const SYBIL_TIER_WINDOW_MS = 24 * 3600 * 1000;

/** Anything that runs a parameterised query: a pg client or a Database. */
export interface SybilTierQueryable {
	query<R extends Record<string, unknown>>(text: string, params: unknown[]): Promise<{ rows: R[] }>;
}

export async function countForSybilTier(
	db: SybilTierQueryable,
	account: string,
	at: Date
): Promise<number> {
	const cutoff = new Date(at.getTime() - SYBIL_TIER_WINDOW_MS);
	const res = await db.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n
		 FROM orders
		 WHERE account = $1
		   AND ((status = 'live' AND (expires_at IS NULL OR expires_at > $3))
		        OR created_at >= $2)`,
		[account, cutoff, at]
	);
	return parseInt(res.rows[0]?.n ?? '0', 10);
}

/** A position in the chain: block, then transaction, then op. */
export interface ChainPosition {
	readonly block_num: number | string;
	readonly trx_in_block: number;
	readonly op_in_trx: number;
}

/**
 * The account's count toward the Sybil tier AS IT STOOD when the live handler
 * judged the op at `pos` (countForSybilTier, reconstructed for an op judged
 * later). (V3-9) An order counts when its CREATING op came earlier in CHAIN
 * ORDER — block, then transaction, then op, read from the event log — exactly
 * the orders the live handler had already stored; an order with no event-log
 * row falls back to created_at strictly before the block. It must also have
 * been live then (still live, or changed after the block, and not expired by
 * then), or created in the 24 h before it. Excludes the order `permlink`
 * itself. (Counting by created_at alone counted orders later in the SAME
 * block, so a re-check refused a fee the live pass accepted; counting the
 * table as it stands counted the account's LATER orders, so the upgrade
 * replay charged a higher tier than every node that judged the op live.)
 */
export async function countForSybilTierAsOf(
	db: SybilTierQueryable,
	account: string,
	permlink: string,
	blockTime: Date,
	pos: ChainPosition
): Promise<number> {
	const cutoff = new Date(blockTime.getTime() - SYBIL_TIER_WINDOW_MS);
	const res = await db.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n
		   FROM orders o2
		   LEFT JOIN LATERAL (
		        SELECT block_num, trx_in_block, op_in_trx FROM ops
		         WHERE ops.signer = o2.account AND ops.op_id = $5 AND ops.status = 'applied'
		           AND ops.payload->>'permlink' = o2.permlink
		         ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC
		         LIMIT 1) c ON TRUE
		  WHERE o2.account = $1 AND o2.permlink <> $2
		    AND (CASE WHEN c.block_num IS NOT NULL
		              THEN (c.block_num, c.trx_in_block, c.op_in_trx) < ($6::bigint, $7::int, $8::int)
		              ELSE o2.created_at < $3 END)
		    AND (((o2.status = 'live' OR o2.updated_at > $3) AND (o2.expires_at IS NULL OR o2.expires_at > $3))
		         OR o2.created_at >= $4)`,
		[
			account,
			permlink,
			blockTime,
			cutoff,
			ORDER_OP_ID,
			pos.block_num,
			pos.trx_in_block,
			pos.op_in_trx
		]
	);
	return parseInt(res.rows[0]?.n ?? '0', 10);
}

/**
 * The upgrade replay's Sybil-tier count (v1.22.0): what countForSybilTier
 * returned when the live handler judged the op at `pos`, reconstructed from
 * the event log after later ops of the account were applied.
 *
 * An order counts when its CREATING op came earlier in chain order (created_at
 * strictly before the block when the event log has no row for it), and either
 * it was created in the 24 h before the block, or it was live then: not past
 * expires_at, and not yet ended — its status is still 'live', or the cancel or
 * complete op that ended it ran LATER. "Later" is the order the live pass
 * applied ops in, not the raw chain order: applyBlock runs a block's order ops
 * before its other ops (sortOpsForAdmission), so a cancel or complete in the
 * SAME block, even in an earlier transaction, had not run yet when the order
 * was counted. Only when the event log has no ending op for an order that is
 * no longer live is updated_at used ("changed at or after the block": a
 * same-block end sets it to the block time).
 *
 * countForSybilTierAsOf reads "changed after the block" from updated_at alone,
 * and updated_at also moves on orders that had ENDED before the op: naming a
 * counterparty later on a completed order, a fee attestation on a cancelled
 * one, a fee re-check. Counted as live, such an order raised the replayed
 * op's tier, so an order that paid its fee was stored underpaid on the node
 * that replayed it and verified on every other. No exclusion of the op's own
 * permlink either: the live count has none (its order did not exist yet; an
 * EARLIER order of the same permlink did count).
 */
export async function countForSybilTierAtPosition(
	db: SybilTierQueryable,
	account: string,
	blockTime: Date,
	pos: ChainPosition
): Promise<number> {
	const cutoff = new Date(blockTime.getTime() - SYBIL_TIER_WINDOW_MS);
	const res = await db.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n
		   FROM orders o2
		   LEFT JOIN LATERAL (
		        SELECT block_num, trx_in_block, op_in_trx FROM ops
		         WHERE ops.signer = o2.account AND ops.op_id = $4 AND ops.status = 'applied'
		           AND ops.payload->>'permlink' = o2.permlink
		         ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC
		         LIMIT 1) c ON TRUE
		   LEFT JOIN LATERAL (
		        SELECT block_num, trx_in_block, op_in_trx FROM ops
		         WHERE ops.signer = o2.account AND ops.op_id = ANY($8::text[]) AND ops.status = 'applied'
		           AND ops.payload->>'permlink' = o2.permlink
		         ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC
		         LIMIT 1) e ON TRUE
		  WHERE o2.account = $1
		    AND (CASE WHEN c.block_num IS NOT NULL
		              THEN (c.block_num, c.trx_in_block, c.op_in_trx) < ($5::bigint, $6::int, $7::int)
		              ELSE o2.created_at < $2 END)
		    AND (o2.created_at >= $3
		         OR ((o2.expires_at IS NULL OR o2.expires_at > $2)
		             AND (o2.status = 'live'
		                  OR (e.block_num IS NOT NULL
		                      AND e.block_num >= $5::bigint)
		                  OR (e.block_num IS NULL AND o2.updated_at >= $2))))`,
		[
			account,
			blockTime,
			cutoff,
			ORDER_OP_ID,
			pos.block_num,
			pos.trx_in_block,
			pos.op_in_trx,
			ORDER_ENDING_OP_IDS
		]
	);
	return parseInt(res.rows[0]?.n ?? '0', 10);
}

/**
 * How many orders the account had stored when the live handler judged the op
 * at `pos` (the first-buy waiver's "has this account posted before?", a plain
 * COUNT of the account's rows), for an op judged after later ops were applied:
 * orders whose creating op came earlier in chain order (created_at strictly
 * before the block when the event log has no row).
 */
export async function countPriorOrdersAsOf(
	db: SybilTierQueryable,
	account: string,
	blockTime: Date,
	pos: ChainPosition
): Promise<number> {
	const res = await db.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n
		   FROM orders o2
		   LEFT JOIN LATERAL (
		        SELECT block_num, trx_in_block, op_in_trx FROM ops
		         WHERE ops.signer = o2.account AND ops.op_id = $3 AND ops.status = 'applied'
		           AND ops.payload->>'permlink' = o2.permlink
		         ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC
		         LIMIT 1) c ON TRUE
		  WHERE o2.account = $1
		    AND (CASE WHEN c.block_num IS NOT NULL
		              THEN (c.block_num, c.trx_in_block, c.op_in_trx) < ($4::bigint, $5::int, $6::int)
		              ELSE o2.created_at < $2 END)`,
		[account, blockTime, ORDER_OP_ID, pos.block_num, pos.trx_in_block, pos.op_in_trx]
	);
	return parseInt(res.rows[0]?.n ?? '0', 10);
}

/** The order op's id in the event log (OP_IDS.order). Literal here so the
 *  API side does not import the dispatcher. */
const ORDER_OP_ID = 'morphit_order_v1';
/** The ops that end an order (OP_IDS.orderCancel, OP_IDS.orderComplete). */
const ORDER_ENDING_OP_IDS = ['morphit_order_cancel_v1', 'morphit_order_complete_v1'];
