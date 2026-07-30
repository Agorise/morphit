/**
 * Morphit indexer — /v1/activity/volume endpoint (Batch K).
 *
 * Returns aggregated trading-activity stats for the activity page:
 *
 *   - Trade count by asset over 7d / 30d / 90d windows (exact).
 *   - Estimated mid-point volume by asset (notional approximation;
 *     see caveats below).
 *
 * "Trade count" here = unique completed orders that received
 * feedback.  An order with feedback from BOTH parties counts ONCE
 * (DISTINCT on (subject, order_permlink)).
 *
 * Volume caveat: the feedback row carries the order_permlink but
 * NOT the actual trade amount.  An order has amount_min and
 * amount_max — the actual fill could be anywhere in that range
 * (or even outside it if parties negotiated).  We compute
 * estimated volume as `(amount_min + amount_max) / 2` per
 * completed order.  The frontend labels this clearly.
 *
 * Public endpoint, no auth.  Same rate-limit tier as orderbook
 * reads.  All asset tickers normalized to upper-case.
 *
 * Performance: a single query with three CTE windows.  The
 * feedback table's index on (subject, created_at DESC) helps,
 * and the orders PK lookup is constant per row.  At thousands of
 * trades per window this stays sub-100ms; at millions we'd need a
 * materialized view (deferred until that's a real problem).
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';

interface VolumeRow {
	asset: string;
	trade_count: string;
	estimated_volume: string | null;
}

export interface ActivityVolumeWindow {
	readonly asset: string;
	readonly trade_count: number;
	readonly estimated_volume: number;
}

export interface ActivityVolumeResponse {
	readonly window_7d: readonly ActivityVolumeWindow[];
	readonly window_30d: readonly ActivityVolumeWindow[];
	readonly window_90d: readonly ActivityVolumeWindow[];
	readonly generated_at: string;
}

export function activityRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/volume', async (c) => {
		// Three windows, one query each.  Could be combined into a
		// single CTE; kept separate so each query can be cached
		// independently in the future without re-running.
		const sql = `
			SELECT o.asset                                             AS asset,
			       COUNT(DISTINCT (f.subject, f.order_permlink))::text AS trade_count,
			       SUM((COALESCE(o.amount_min, 0) + COALESCE(o.amount_max, 0)) / 2.0)::text
			                                                          AS estimated_volume
			FROM feedback f
			JOIN orders o ON o.account = f.subject AND o.permlink = f.order_permlink
			WHERE f.order_permlink IS NOT NULL
			  AND f.created_at > NOW() - $1::interval
			GROUP BY o.asset
			ORDER BY o.asset
		`;

		const [r7, r30, r90] = await Promise.all([
			db.query<VolumeRow>(sql, ['7 days']),
			db.query<VolumeRow>(sql, ['30 days']),
			db.query<VolumeRow>(sql, ['90 days'])
		]);

		const map = (rows: VolumeRow[]): ActivityVolumeWindow[] =>
			rows.map((r) => ({
				asset: r.asset,
				trade_count: parseInt(r.trade_count, 10),
				estimated_volume: r.estimated_volume === null ? 0 : Number(r.estimated_volume)
			}));

		const response: ActivityVolumeResponse = {
			window_7d: map(r7.rows),
			window_30d: map(r30.rows),
			window_90d: map(r90.rows),
			generated_at: new Date().toISOString()
		};

		return c.json(response);
	});

	return app;
}
