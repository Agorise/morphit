/**
 * Handler: morphit_order_complete_v1
 *
 * Payload shape:
 *   {
 *     "permlink": string
 *   }
 *
 * Effect: flip the order's status from 'live' to 'completed', bump
 * updated_at. Row is preserved (no DELETE) so the audit trail and
 * any feedback linked to the order both keep working.
 *
 * Posted by the SELLER (order owner) once a trade's payment is
 * confirmed — automatically the moment their client verifies the
 * payment on-chain, or via the manual "Mark as complete" action for
 * off-chain settlements (BTC/XMR/cash). A completed order leaves the
 * public orderbook (the orderbook query filters status='live').
 *
 * This is the second removal path parallel to morphit_order_cancel_v1.
 * The `account = signer` guard means ONLY the owner can complete their
 * own listing, so a buyer faking payment cannot grief an order off the
 * book. v1.5.0.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { validateOrderPermlink } from '$indexer/permlink';

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) return { ok: false, reason: 'payload_not_object' };

	const permlinkFail = validateOrderPermlink(ctx.payload.permlink);
	if (permlinkFail) return { ok: false, reason: permlinkFail };
	const permlink = ctx.payload.permlink as string;

	const res = await client.query(
		`UPDATE orders SET status = 'completed', updated_at = $3
		 WHERE account = $1 AND permlink = $2 AND status = 'live'`,
		[ctx.signer, permlink, ctx.blockTime]
	);

	if (res.rowCount === 0) {
		const probe = await client.query<{ status: string }>(
			`SELECT status FROM orders WHERE account = $1 AND permlink = $2`,
			[ctx.signer, permlink]
		);
		if (probe.rowCount === 0) return { ok: false, reason: 'target_not_found' };
		return { ok: false, reason: 'target_already_' + (probe.rows[0]?.status ?? 'unknown') };
	}

	ctx.recordOrderbookChange(`${ctx.signer}/${permlink}`);
	return { ok: true };
};

export default handle;
