/**
 * Morphit indexer — /v1/operators endpoint.
 *
 * Public directory of registered operators. Read-only. No auth.
 * No query parameters — the operator set is expected to be small
 * (dozens, not thousands) and filtering client-side is fine.
 *
 * Response shape:
 *   {
 *     operators: [
 *       {
 *         account, tag, display_name, contact_url,
 *         registered_at, is_active,
 *         fee_account,            // latest registered fees account, or null
 *         stats?: { cumulative_blurt_earned, total_orders_attributed }
 *       }
 *     ]
 *   }
 *
 * STATS (v1.21.8 — every operator, since inception). Before, they came from
 * operator_earnings, which only the operator's OWN indexer filled (and only for
 * listing fees, from the version that added it), so every other operator
 * showed nothing anywhere. They are computed in the background by the poller
 * (indexer/operatorStats.ts, which documents exactly what they count) into
 * `operator_stats`; this route only reads that table, so it stays fast however
 * many fee payments exist. `stats` is absent for an operator the background
 * pass has not counted yet: one registered since the last count, or every
 * one before the first count after the upgrade or a restore (the count waits
 * until the node has caught up with the chain).
 *
 *  - total_orders_attributed: orders carrying the operator's tag whose fee
 *    this node holds as paid (any fee method, free first buys included),
 *    whatever the order's status now — this node's judgement, so nodes can
 *    differ a little (assets a node does not list, BTC/XMR confirmations).
 *  - cumulative_blurt_earned: the BLURT that reached the operator's fees
 *    account in Morphit fee payments (listing, first-contact, featured-slot),
 *    from chain data only — the same on every node.
 *
 * Order: active operators first, then most orders, then most earned, then
 * the earliest registered. Inactive operators stay listed, below.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';

interface OperatorRow {
	account: string;
	tag: string;
	display_name: string;
	contact_url: string | null;
	registered_at: Date;
	is_active: boolean;
	fee_account: string | null;
	earned_milli: string | null;
	orders: string | null;
}

interface OperatorStatsWire {
	cumulative_blurt_earned: number;
	total_orders_attributed: number;
}

interface OperatorWire {
	account: string;
	tag: string;
	display_name: string;
	contact_url: string | null;
	registered_at: string;
	is_active: boolean;
	fee_account: string | null;
	stats?: OperatorStatsWire;
}

function rowToWire(r: OperatorRow): OperatorWire {
	const wire: OperatorWire = {
		account: r.account,
		tag: r.tag,
		display_name: r.display_name,
		contact_url: r.contact_url,
		registered_at: r.registered_at.toISOString(),
		is_active: r.is_active,
		fee_account: r.fee_account
	};
	if (r.earned_milli !== null && r.orders !== null) {
		wire.stats = {
			// milliBLURT is exact; one division at the edge.
			cumulative_blurt_earned: Number(r.earned_milli) / 1000,
			total_orders_attributed: Number(r.orders)
		};
	}
	return wire;
}

export const OPERATORS_SQL = `
SELECT o.account, o.tag, o.display_name, o.contact_url, o.registered_at, o.is_active,
       (SELECT f.fee_recipient FROM operator_fee_recipients f
         WHERE f.account = o.account
         ORDER BY f.effective_block DESC, f.trx_in_block DESC, f.op_in_trx DESC
         LIMIT 1) AS fee_account,
       s.earned_milli::text AS earned_milli,
       s.orders::text AS orders
  FROM operators o
  LEFT JOIN operator_stats s ON s.account = o.account
 ORDER BY o.is_active DESC, COALESCE(s.orders, 0) DESC, COALESCE(s.earned_milli, 0) DESC,
          o.registered_at ASC, o.account ASC
 LIMIT 500`;

export function operatorsRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		const result = await db.query<OperatorRow>(OPERATORS_SQL);
		return c.json({
			operators: result.rows.map(rowToWire)
		});
	});

	return app;
}
