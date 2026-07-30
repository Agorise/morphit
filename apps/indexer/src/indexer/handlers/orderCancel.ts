/**
 * Handler: morphit_order_cancel_v1
 *
 * Payload shape:
 *   {
 *     "permlink": string
 *   }
 *
 * Effect: flip the order's status from 'live' to 'cancelled',
 * bump updated_at. Row is preserved (no DELETE) so audit trail
 * and feedback linked to the order both keep working.
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
		`UPDATE orders SET status = 'cancelled', updated_at = $3
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
