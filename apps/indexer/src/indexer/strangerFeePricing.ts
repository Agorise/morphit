/**
 * Morphit indexer — stranger-fee pricing helper.
 *
 * Anti-spam layer-2 escalation for first-contact chat messages.
 * The base 5 BLURT stranger fee doubles for each first-contact a
 * sender has paid for in the last 5 minutes.  A user reaching
 * out to one stranger pays the base; reaching out to a second
 * within 5 minutes pays 10 BLURT; a third pays 20 BLURT, and so
 * on.  Cap at 640 BLURT (128× base).
 *
 * BLURT-native: amounts are denominated directly in BLURT, not
 * derived from a USD anchor.  The cap exists so that:
 *   - A confused legitimate user can't accidentally trigger
 *     a huge charge.
 *   - A malicious user can't deliberately trigger a huge
 *     charge against themselves to smear Morphit ("they
 *     charged me thousands for a chat message").
 *
 * Window mechanics: sliding 5 minutes. Each new send counts the
 * sender's fee payments in `paid_at > NOW() - 5 min`. Pause for
 * 5 minutes and the next send resets to base. Pace yourself to
 * one stranger per 5+ minutes and the multiplier never engages.
 *
 * The helper is used by:
 *   - strangerFee handler (validates the quoted BLURT amount
 *     matches the current escalating price).
 *   - /v1/stranger-fee-quote endpoint (lets the frontend show
 *     the user the current price BEFORE they sign).
 *
 * Window state lives in the existing stranger_fees table
 * (paid_at column, indexed). No new schema needed.
 */

import type pg from 'pg';

/** Base stranger fee in BLURT. */
export const STRANGER_FEE_BASE_BLURT = 5;

/** Max number of doublings before the price caps. After this
 *  many prior sends within the window, additional sends stop
 *  raising the multiplier — but they still cost the cap, not
 *  the base. With this set to 8, the multiplier sequence is
 *  1, 2, 4, 8, 16, 32, 64, 128, 128, 128, ...
 *
 *  In other words: the 1st fee at multiplier 1, the 2nd at
 *  multiplier 2, ..., the 8th and beyond at multiplier 128
 *  (= 640 BLURT at the 5 BLURT base). */
export const STRANGER_FEE_MAX_DOUBLINGS = 8;

/** Window length in minutes for counting recent fees. */
export const STRANGER_FEE_WINDOW_MINUTES = 5;

/** Maximum multiplier the doubling can reach.
 *  With STRANGER_FEE_MAX_DOUBLINGS = 8 this is 2^7 = 128. */
export const STRANGER_FEE_MAX_MULTIPLIER = Math.pow(2, STRANGER_FEE_MAX_DOUBLINGS - 1);

export interface StrangerFeeQuote {
	/** Price for the *next* stranger fee from this sender, in
	 *  BLURT. Always >= STRANGER_FEE_BASE_BLURT. */
	readonly priceBlurt: number;
	/** Multiplier vs base (1, 2, 4, ..., 128). Useful for
	 *  rendering "you've messaged N strangers in 5 min, fee
	 *  is now Nx" warnings on the frontend. */
	readonly multiplier: number;
	/** Number of recent stranger fees the sender has paid
	 *  inside the sliding window. Frontend uses this to
	 *  count down "messaged N strangers in last 5 min." */
	readonly recentCount: number;
	/** True iff multiplier hit the cap. Once hit, paying more
	 *  doesn't make subsequent fees more expensive — but they
	 *  still cost the cap, not the base. */
	readonly capped: boolean;
}

/** Minimal shape the helper needs — works against
 *  pg.PoolClient, pg.Pool, or any test mock with a
 *  `query()` method matching this signature. */
export interface Queryable {
	query<R extends pg.QueryResultRow>(
		text: string,
		params: readonly unknown[]
	): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Compute the current stranger-fee quote for `sender`.
 *
 *  Counts rows in `stranger_fees` where the sender matches
 *  and `paid_at` is within the sliding window. The count
 *  becomes the exponent (multiplier = 2^count, capped).
 *
 *  Determinism note: pass `now` from `ctx.blockTime` when
 *  calling from a chain-op handler.  Without that, the query
 *  uses `NOW()` at query-execution time, which makes replay
 *  produce different rejection codes than the original
 *  real-time pass — historical fees fall outside the
 *  window, multiplier resets to 1, and handlers that
 *  previously rejected `amount_blurt_below_current_quote`
 *  start accepting the same op.  API callers that serve
 *  real-time quotes can omit `now`; only handlers replaying
 *  history need to pass `ctx.blockTime`.  See P4-10 audit
 *  finding for context. */
export async function getStrangerFeeQuote(
	client: Queryable,
	sender: string,
	now?: Date
): Promise<StrangerFeeQuote> {
	const result = await client.query<{ count: string }>(
		now === undefined
			? `SELECT COUNT(*)::text AS count
			   FROM stranger_fees
			  WHERE sender = $1
			    AND paid_at > NOW() - $2::interval`
			: `SELECT COUNT(*)::text AS count
			   FROM stranger_fees
			  WHERE sender = $1
			    AND paid_at > $3::timestamptz - $2::interval`,
		now === undefined
			? [sender, `${STRANGER_FEE_WINDOW_MINUTES} minutes`]
			: [sender, `${STRANGER_FEE_WINDOW_MINUTES} minutes`, now]
	);
	const recentCount = Number(result.rows[0]?.count ?? '0');
	// Multiplier sequence: 1, 2, 4, 8, ..., 128, 128, 128, ...
	// With recentCount = N, the *next* send is the (N+1)th and
	// pays multiplier 2^min(N, MAX_DOUBLINGS - 1).
	const exponent = Math.min(recentCount, STRANGER_FEE_MAX_DOUBLINGS - 1);
	const multiplier = Math.pow(2, exponent);
	const priceBlurt = STRANGER_FEE_BASE_BLURT * multiplier;
	return {
		priceBlurt,
		multiplier,
		recentCount,
		capped: recentCount >= STRANGER_FEE_MAX_DOUBLINGS - 1
	};
}
