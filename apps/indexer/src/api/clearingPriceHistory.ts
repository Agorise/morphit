/**
 * Morphit indexer — /v1/orderbook/featured/clearing-price-history endpoint.
 *
 * Surfaces historical featured-slot auction "clearing prices"
 * (REVISIT-LIST §G item — Group 1 #2 from the prior chat's
 * decision menu).
 *
 * Definition of clearing price:
 *   At any given moment, up to MAX_SLOTS_VISIBLE (=5) bids are
 *   visible at the top of the orderbook.  The "clearing price"
 *   is the bid rate (in BLURT/hour) of the LOWEST-ranked
 *   currently-visible bid — i.e., the price you needed to beat
 *   to displace someone visible.  For under-filled auctions
 *   (fewer than 5 visible bids), the clearing price is 0
 *   (anyone with any bid wins a visible slot).
 *
 * Why this is interesting to bidders:
 *   - "Was the auction competitive last week?" (high clearing
 *     price = competitive)
 *   - "Where's the floor I'd need to bid above to be visible?"
 *     (current clearing price)
 *   - "Has demand grown over time?" (trend across windows)
 *
 * Response shape:
 *   {
 *     points: Array<{
 *       day: ISO date (YYYY-MM-DD),
 *       clearing_blurt_per_hour: number,  // 0 if under-filled
 *       active_visible_count: number,     // how many slots
 *                                         //  were filled this day
 *       max_slots: number                 // for context (= 5)
 *     }>,
 *     window_days: number,
 *     max_slots: number
 *   }
 *
 * Window:
 *   ?window=7|30|90 (default 30).  Caps at 90 to keep the
 *   query bounded; longer windows can scrape from the same
 *   data via repeated calls.
 *
 * Cache-Control:
 *   max-age=300 (5 min).  Daily-binned data doesn't change
 *   minute-to-minute, but a 5-minute window keeps the
 *   "today's clearing price" point reasonably fresh without
 *   pounding the DB.
 *
 * Pure-logic split:
 *   - Query and shape transform are isolated in
 *     buildClearingPriceSeries() / shapeClearingResponse()
 *     so the smoke can verify the contract without spinning
 *     up Postgres.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';

/** Mirror of MAX_SLOTS in `featuredOrderbook.ts`.  See the note
 *  in `featureBid.ts` about MAX_SLOTS_VISIBLE living in three
 *  places — handler, current-orderbook API, and history API.
 *  An integration test would catch drift; for now the comment is
 *  the only enforcement. */
const MAX_SLOTS = 5;

/** Window choices.  Validated at request time; clipped to
 *  defaults if the client sends garbage rather than rejecting
 *  outright (match the rest of the indexer's "be liberal in
 *  what you accept" posture for read endpoints). */
const ALLOWED_WINDOWS = [7, 30, 90] as const;
const DEFAULT_WINDOW_DAYS = 30;

/** Single day's clearing-price summary.  Shipped over the
 *  wire; the UI charts a series of these. */
export interface ClearingPricePoint {
	readonly day: string; // YYYY-MM-DD
	readonly clearing_blurt_per_hour: number;
	readonly active_visible_count: number;
	readonly max_slots: number;
}

export interface ClearingPriceResponse {
	readonly points: readonly ClearingPricePoint[];
	readonly window_days: number;
	readonly max_slots: number;
}

/** Raw row coming out of Postgres for the daily aggregation. */
interface ClearingPriceRow {
	day: Date;
	clearing_blurt_per_hour: string | null; // NUMERIC nullable
	active_visible_count: number;
}

/** Shape a Postgres row set into the wire response.  Pure
 *  transform — the smoke calls this directly with synthetic
 *  rows. */
export function shapeClearingResponse(
	rows: readonly ClearingPriceRow[],
	windowDays: number
): ClearingPriceResponse {
	const points: ClearingPricePoint[] = rows.map((r) => ({
		// Format day as YYYY-MM-DD without timezone slop.  The
		// SQL casts to date so r.day is midnight UTC; toISO and
		// slice keeps the date portion only.
		day: r.day.toISOString().slice(0, 10),
		clearing_blurt_per_hour:
			r.clearing_blurt_per_hour === null ? 0 : Number(r.clearing_blurt_per_hour),
		active_visible_count: Number(r.active_visible_count),
		max_slots: MAX_SLOTS
	}));
	return {
		points,
		window_days: windowDays,
		max_slots: MAX_SLOTS
	};
}

/** Validate / normalize the client's `window` query param.
 *  Returns one of ALLOWED_WINDOWS — invalid or missing values
 *  fall back to DEFAULT_WINDOW_DAYS rather than 4xxing.  Pure
 *  function; tested directly by the smoke. */
export function parseWindowParam(raw: string | null | undefined): number {
	if (raw === null || raw === undefined) return DEFAULT_WINDOW_DAYS;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return DEFAULT_WINDOW_DAYS;
	if ((ALLOWED_WINDOWS as readonly number[]).includes(n)) return n;
	return DEFAULT_WINDOW_DAYS;
}

/** Hono route — /v1/orderbook/featured/clearing-price-history */
export function clearingPriceHistoryRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		const windowDays = parseWindowParam(c.req.query('window'));

		// SQL design notes:
		//
		// We want, per day in the window: among bids that were
		// VISIBLE on that day (i.e., active and ranked in the
		// top MAX_SLOTS), what was the lowest blurt_per_hour?
		// That's the clearing price for that day.
		//
		// "Visible on day D" = the bid was active sometime
		// during day D.  We approximate by sampling at day D's
		// midnight UTC: the bid was active iff
		//   effective_at <= midnight(D) < expires_at
		// AND the bid was in the top MAX_SLOTS by
		// blurt_per_hour (ties broken by block_time_at).
		//
		// The query is structured as a CTE that generates the
		// day-sampling timestamps, then for each sample point
		// computes the rank-MAX_SLOTS-th bid.  Postgres's
		// generate_series + LATERAL is the natural shape.
		//
		// Days with fewer than MAX_SLOTS active bids return a
		// NULL clearing price (handled in the JS shaping as
		// 0 / "under-filled").
		const rows = await db.query<ClearingPriceRow>(
			`WITH days AS (
				SELECT generate_series(
					(NOW() AT TIME ZONE 'UTC')::date - ($1::int - 1),
					(NOW() AT TIME ZONE 'UTC')::date,
					'1 day'::interval
				)::date AS day
			),
			day_samples AS (
				SELECT
					d.day,
					-- Sample at midnight UTC of each day. Bids
					-- with effective_at on the day itself but
					-- after midnight will be missed; those are
					-- counted starting the next day. Acceptable
					-- approximation given the auction floor is
					-- 6h (MIN_HOURS in featureBid.ts).
					(d.day::timestamp AT TIME ZONE 'UTC') AS sample_ts
				FROM days d
			),
			ranked_per_day AS (
				SELECT
					ds.day,
					b.blurt_per_hour,
					ROW_NUMBER() OVER (
						PARTITION BY ds.day
						ORDER BY b.blurt_per_hour DESC, b.block_time_at ASC
					) AS rnk
				FROM day_samples ds
				LEFT JOIN featured_slot_bids b
				  ON b.cancelled = FALSE
				 AND b.effective_at <= ds.sample_ts
				 AND b.expires_at > ds.sample_ts
			)
			SELECT
				rpd.day::timestamp AS day,
				MIN(CASE WHEN rpd.rnk = $2 THEN rpd.blurt_per_hour::text END) AS clearing_blurt_per_hour,
				COUNT(rpd.blurt_per_hour) FILTER (WHERE rpd.rnk <= $2) AS active_visible_count
			FROM ranked_per_day rpd
			GROUP BY rpd.day
			ORDER BY rpd.day ASC`,
			[windowDays, MAX_SLOTS]
		);

		const response = shapeClearingResponse(rows.rows, windowDays);

		c.header('cache-control', 'max-age=300, public');
		return c.json(response);
	});

	return app;
}
