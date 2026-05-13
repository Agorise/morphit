/**
 * Morphit indexer — /v1/operator-blocks/* endpoints.
 *
 * Item 3.  Two routes:
 *
 *   GET /v1/operator-blocks/by-blocked/:account
 *     Returns the operator-block record (if any) currently in effect
 *     against `:account`.  Used by the frontend banner to detect
 *     whether the signed-in user has been operator-blocked on this
 *     instance.  Response shape:
 *       { account, blocked: false }
 *     when no block, or
 *       { account, blocked: true, operator, reason,
 *         since_block_num, since_trx_id,
 *         created_at, updated_at }
 *     when the operator has an active block.
 *
 *   GET /v1/operator-blocks/by-operator/:operator
 *     Lists every account the operator has currently blocked
 *     (state='blocked').  Used by the orderbook view to filter,
 *     and by future transparency-page tooling.
 *
 * Authentication: none.  These are derived views over public
 * on-chain custom_json ops; anyone scraping the chain could
 * aggregate the same information.  We surface the operator's
 * stated reason verbatim — it's already public on chain.
 *
 * The data is OPERATOR-INSTANCE LEVEL.  Other instances see other
 * blocks; a user blocked here is unaffected on instance-B.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

/** Hard cap on rows returned by the by-operator listing.  An
 *  operator who's blocked tens of thousands of accounts has a
 *  bigger problem than this endpoint's response size, but we
 *  still bound it. */
const MAX_ROWS = 10_000;

interface ByBlockedRow {
	operator: string;
	reason: string;
	since_block_num: string;
	since_trx_id: string;
	created_at: Date;
	updated_at: Date;
}

interface ByOperatorRow {
	blocked: string;
	reason: string;
	since_block_num: string;
	since_trx_id: string;
	created_at: Date;
	updated_at: Date;
}

export function operatorBlocksRoute(db: Database): Hono {
	const app = new Hono();

	// ─── /by-blocked/:account ─────────────────────────────────────
	app.get('/by-blocked/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const sql = `
			SELECT operator,
			       reason,
			       since_block_num::text,
			       since_trx_id,
			       created_at,
			       updated_at
			FROM operator_blocks
			WHERE blocked = $1 AND state = 'blocked'
			ORDER BY updated_at DESC
			LIMIT 1
		`;

		const result = await db.query<ByBlockedRow>(sql, [account]);
		const row = result.rows[0];
		if (!row) {
			return c.json({ account, blocked: false });
		}
		return c.json({
			account,
			blocked: true,
			operator: row.operator,
			reason: row.reason,
			since_block_num: Number(row.since_block_num),
			since_trx_id: row.since_trx_id,
			created_at: row.created_at.toISOString(),
			updated_at: row.updated_at.toISOString()
		});
	});

	// ─── /by-operator/:operator ───────────────────────────────────
	app.get('/by-operator/:operator', async (c) => {
		const operator = c.req.param('operator');
		if (!isAccountName(operator)) {
			return c.json(errorBody('bad_request', 'invalid operator name'), 400);
		}

		const sql = `
			SELECT blocked,
			       reason,
			       since_block_num::text,
			       since_trx_id,
			       created_at,
			       updated_at
			FROM operator_blocks
			WHERE operator = $1 AND state = 'blocked'
			ORDER BY updated_at DESC
			LIMIT $2
		`;

		const result = await db.query<ByOperatorRow>(sql, [operator, MAX_ROWS]);

		return c.json({
			operator,
			items: result.rows.map((r) => ({
				blocked: r.blocked,
				reason: r.reason,
				since_block_num: Number(r.since_block_num),
				since_trx_id: r.since_trx_id,
				created_at: r.created_at.toISOString(),
				updated_at: r.updated_at.toISOString()
			}))
		});
	});

	return app;
}
