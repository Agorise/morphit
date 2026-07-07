/**
 * Morphit indexer — /v1/stats endpoint (cp406).
 *
 * A small, STABLE, aggregate-only summary of network activity, intended for
 * third-party P2P aggregators (RoboSats, Bisq, Hodl Hodl, AgoraDesk, …) that
 * want a one-glance picture of a Morphit instance.
 *
 * Privacy-first by construction: every field is a coarse aggregate — a count,
 * or a static config list. There is NOTHING per-account here: no volume-by-
 * user, no order-count-by-user, nothing that could help correlate or de-
 * anonymize a trader. (Instance CONFIGURATION — disabled assets/payment
 * methods, treasury addresses, fees — lives on /v1/instance; this endpoint is
 * purely "how much is happening".)
 *
 * Fields:
 *   - orders.active  — orders currently live + fee-verified + not expired (the
 *                      exact visibility rule the public orderbook uses).
 *   - orders.total   — all order rows ever indexed (lifetime).
 *   - trades.completed_total / _30d — unique completed orders that received
 *                      feedback (DISTINCT (subject, order_permlink)), lifetime
 *                      and over the last 30 days. Same "a trade happened"
 *                      signal the activity page uses. Deliberately NOT a volume
 *                      figure: fiat amounts across mixed currencies aren't
 *                      meaningfully summable without USD normalization, so we
 *                      report counts only and leave a USD-normalized volume to
 *                      a later revision rather than publish a misleading number.
 *   - assets.supported — the CRYPTO tickers tradable on THIS instance (the
 *                      canonical set minus any the operator disabled, and minus
 *                      goods assets like BARTER, which are orderable but not
 *                      coins — see isGoodsAsset).
 *   - assets.with_active_orders / fiat_currencies.with_active_orders — breadth
 *                      of current liquidity (distinct counts among live orders).
 *
 * Public, no auth, same rate-limit tier as the orderbook reads. Two small
 * aggregate queries; sub-100ms at realistic table sizes.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import type { Config } from '$config';
import { ASSET_TICKERS, isGoodsAsset } from '@morphit/asset-registry';

interface OrdersAggRow {
	active: string;
	total: string;
	assets_active: string;
	fiats_active: string;
}
interface TradesAggRow {
	completed_total: string;
	completed_30d: string;
}

export interface StatsResponse {
	readonly network: 'morphit';
	readonly generated_at: string;
	readonly orders: { readonly active: number; readonly total: number };
	readonly trades: { readonly completed_total: number; readonly completed_30d: number };
	readonly assets: {
		readonly supported: readonly string[];
		readonly with_active_orders: number;
	};
	readonly fiat_currencies: { readonly with_active_orders: number };
}

/**
 * Build the /v1/stats response from two aggregate rows. Pure and total —
 * exported so the shaping (and, critically, the privacy shape) can be unit-
 * tested from tsx without a database.
 */
export function buildStatsResponse(
	orders: Partial<OrdersAggRow> | undefined,
	trades: Partial<TradesAggRow> | undefined,
	disabledAssets: readonly string[],
	now: Date = new Date()
): StatsResponse {
	const num = (s: string | undefined) => {
		if (s == null) return 0;
		const n = parseInt(s, 10);
		return Number.isFinite(n) && n >= 0 ? n : 0;
	};
	const disabled = new Set(disabledAssets.map((a) => a.toUpperCase()));
	// cp425 — `supported` reports the CRYPTO tickers this instance trades, the
	// list clients render as coins on the stats page. Goods assets (BARTER)
	// are orderable but are not coins (no address / price / icon-as-coin), so
	// isGoodsAsset() gates them out here — mirroring the sitemap builder and
	// the brag-list count. Barter's availability is surfaced via the orderbook
	// and the barter-specific UI, not this coin summary.
	const supported = ASSET_TICKERS.filter(
		(tk) => !disabled.has(tk) && !isGoodsAsset(tk)
	);

	return {
		network: 'morphit',
		generated_at: now.toISOString(),
		orders: { active: num(orders?.active), total: num(orders?.total) },
		trades: {
			completed_total: num(trades?.completed_total),
			completed_30d: num(trades?.completed_30d)
		},
		assets: {
			supported,
			with_active_orders: num(orders?.assets_active)
		},
		fiat_currencies: { with_active_orders: num(orders?.fiats_active) }
	};
}

export function statsRoute(db: Database, config: Config): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		// "Live" = the exact visibility rule the public orderbook uses:
		// status='live', fee verified, not past expiry. Defined once in a CTE so
		// the three live-order aggregates stay consistent with each other.
		const ordersSql = `
			WITH live AS (
				SELECT asset, fiat_currency
				FROM orders
				WHERE status = 'live'
				  AND fee_status IN ('verified', 'verified_by_attestation')
				  AND (expires_at IS NULL OR expires_at > NOW())
			)
			SELECT
				(SELECT COUNT(*) FROM live)::text                      AS active,
				(SELECT COUNT(*) FROM orders)::text                    AS total,
				(SELECT COUNT(DISTINCT asset) FROM live)::text         AS assets_active,
				(SELECT COUNT(DISTINCT fiat_currency) FROM live)::text AS fiats_active
		`;

		// Completed trades = distinct (subject, order_permlink) feedback rows
		// (both-party feedback on one order counts once). Lifetime + last 30d in
		// one scan via FILTER.
		const tradesSql = `
			SELECT
				(COUNT(DISTINCT (subject, order_permlink))
					FILTER (WHERE order_permlink IS NOT NULL))::text AS completed_total,
				(COUNT(DISTINCT (subject, order_permlink))
					FILTER (WHERE order_permlink IS NOT NULL
					              AND created_at > NOW() - '30 days'::interval))::text
					AS completed_30d
			FROM feedback
		`;

		const [ordersRes, tradesRes] = await Promise.all([
			db.query<OrdersAggRow>(ordersSql),
			db.query<TradesAggRow>(tradesSql)
		]);

		return c.json(buildStatsResponse(ordersRes.rows[0], tradesRes.rows[0], config.disabledAssets));
	});

	return app;
}
