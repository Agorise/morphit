/**
 * Morphit indexer — /v1/blocks/:account endpoint.
 *
 * Returns every account that `:account` currently has blocked
 * (state='blocked'). Rows with state='unblocked' are omitted —
 * this endpoint exposes current-state only, not audit history.
 *
 * Why not expose the reverse "who has blocked me?" query:
 *   Morphit's UX decision is that a blocked user should NOT be
 *   notified of the block — that would turn the block signal
 *   into a provocation vector. The raw block op is public on
 *   Blurt (anyone scraping the chain can aggregate it), but the
 *   indexer doesn't normalize the reverse query to keep the
 *   "I don't tell you you're blocked" guarantee consistent
 *   across the product's public API surface.
 *
 * Authentication: none. Every morphit_block_v1 op is a public
 * on-chain event; the derived list exposes the same information
 * the chain itself exposes, just pre-aggregated and filtered to
 * the "currently-blocking" subset.
 *
 * Response shape:
 *   {
 *     account: string,
 *     items: [{
 *       blocked: string,
 *       since_block_num: number,
 *       since_trx_id: string,
 *       created_at: string,  // ISO
 *       updated_at: string   // ISO
 *     }]
 *   }
 *
 * Items sorted by updated_at DESC (most-recently-acted-on first).
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

/** Hard cap on rows returned. Even a prolific user is unlikely
 *  to have more than a few dozen blocked accounts; 10k is an
 *  unreachable ceiling but still bounds response size under
 *  adversarial input. */
const MAX_ROWS = 10_000;

interface Row {
	blocked: string;
	since_block_num: string; // BIGINT returns as string from pg
	since_trx_id: string;
	created_at: Date;
	updated_at: Date;
}

export function blocksRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const sql = `
			SELECT blocked,
			       since_block_num::text,
			       since_trx_id,
			       created_at,
			       updated_at
			FROM blocks
			WHERE blocker = $1 AND state = 'blocked'
			ORDER BY updated_at DESC
			LIMIT $2
		`;

		const result = await db.query<Row>(sql, [account, MAX_ROWS]);

		return c.json({
			account,
			items: result.rows.map((r) => ({
				blocked: r.blocked,
				since_block_num: Number(r.since_block_num),
				since_trx_id: r.since_trx_id,
				created_at: r.created_at.toISOString(),
				updated_at: r.updated_at.toISOString()
			}))
		});
	});

	return app;
}
