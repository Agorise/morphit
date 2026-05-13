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
 *         stats?: { cumulative_blurt_earned, total_orders_attributed }
 *       }
 *     ]
 *   }
 *
 * The stats object is only included if the operator has an
 * operator_earnings row (created lazily on first attributed
 * order). Zero-earnings operators have no stats attached —
 * there's no useful distinction between "zero earnings shown"
 * and "no stats" for display purposes, but at the wire level
 * we preserve the difference.
 *
 * Phase 5b scaffolding. The table exists (migration v7) but is
 * empty until the ADR-0013-gated registration op lands. Until
 * then this endpoint always returns `{operators: []}`.
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
	cumulative_blurt_earned: string | null;
	total_orders_attributed: string | null;
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
	stats?: OperatorStatsWire;
}

function rowToWire(r: OperatorRow): OperatorWire {
	const wire: OperatorWire = {
		account: r.account,
		tag: r.tag,
		display_name: r.display_name,
		contact_url: r.contact_url,
		registered_at: r.registered_at.toISOString(),
		is_active: r.is_active
	};
	// Stats are optional on the wire — zero-earnings operators
	// don't have an operator_earnings row, and we'd rather omit
	// the key than emit `stats: {0, 0}` which is ambiguous between
	// "never attributed" and "returned-to-zero after payout".
	if (r.cumulative_blurt_earned !== null && r.total_orders_attributed !== null) {
		wire.stats = {
			cumulative_blurt_earned: Number(r.cumulative_blurt_earned),
			total_orders_attributed: Number(r.total_orders_attributed)
		};
	}
	return wire;
}

export function operatorsRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		// LEFT JOIN — operators without an earnings row still appear,
		// just without a stats object. Order: active first, then
		// recently-registered first. Inactive operators are still
		// listed for transparency (they existed, they don't anymore),
		// but they appear below active ones.
		const sql = `
			SELECT o.account, o.tag, o.display_name, o.contact_url,
			       o.registered_at, o.is_active,
			       e.cumulative_blurt_earned::text,
			       e.total_orders_attributed::text
			  FROM operators o
			  LEFT JOIN operator_earnings e ON e.account = o.account
			 ORDER BY o.is_active DESC, o.registered_at DESC
			 LIMIT 500`;

		const result = await db.query<OperatorRow>(sql);
		return c.json({
			operators: result.rows.map(rowToWire)
		});
	});

	return app;
}
