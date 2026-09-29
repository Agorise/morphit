/**
 * Morphit indexer — /v1/operator-registration/:account (v1.20.0, G1 / V3-4).
 *
 *   GET /v1/operator-registration/:account
 *     → 200 { account, tag, block_num, trx_id, payload }   the payload of the
 *           NEWEST morphit_operator_register_v1 op by :account that THIS
 *           indexer APPLIED (verbatim from its event log)
 *     → 404 when this indexer applied none; 400 on a malformed account.
 *
 * WHY. `morphit-ops upgrade` re-publishes an operator's registration to add
 * its fees account. It must re-publish exactly what the chain ACCEPTED — not
 * a rebuild from the local config (which reverted a display name or contact
 * set later through the web form, and wiped fields the config lacked). The
 * accepted payload lives only in the event log; this route serves it. All of
 * it is public chain data (the op is on Blurt), so no auth.
 */
import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

export function operatorRegistrationRoute(db: Pick<Database, 'query'>): Hono {
	const app = new Hono();
	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account))
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		const r = await db.query<{
			block_num: string;
			trx_id: string;
			payload: Record<string, unknown>;
		}>(
			`SELECT block_num::text AS block_num, trx_id, payload
			   FROM ops
			  WHERE signer = $1 AND op_id = 'morphit_operator_register_v1' AND status = 'applied'
			    AND jsonb_typeof(payload) = 'object'
			  ORDER BY block_num DESC, trx_in_block DESC, op_in_trx DESC
			  LIMIT 1`,
			[account]
		);
		const row = r.rows[0];
		if (row === undefined) return c.json(errorBody('not_found', 'no applied registration'), 404);
		c.header('Cache-Control', 'no-cache');
		return c.json({
			account,
			tag: typeof row.payload.tag === 'string' ? row.payload.tag : null,
			block_num: Number(row.block_num),
			trx_id: row.trx_id,
			payload: row.payload
		});
	});
	return app;
}
