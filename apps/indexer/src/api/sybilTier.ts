/**
 * How many of an account's orders count toward its Sybil fee tier at a given
 * time (ADR-0009 §4): live at that time (stored live and not past expires_at)
 * OR created in the 24 hours before it, even if since cancelled. The order
 * about to be posted is the (count + 1)-th.
 *
 * One definition for the order handler, which prices the fee it verifies, and
 * for GET /v1/orders/:account/sybil_tier, which a client quotes the fee from.
 * Clients used to derive the count from the newest 100 orders of
 * /v1/orders/:account; an account with more than 100 orders was quoted a
 * lower tier than the indexer then charged, and the order's fee was lost.
 *
 * `at` is the block time on the handler side (identical on replay and across
 * instances); a quote passes the current time.
 */

export const SYBIL_TIER_WINDOW_MS = 24 * 3600 * 1000;

/** Anything that runs a parameterised query: a pg client or a Database. */
export interface SybilTierQueryable {
	query<R extends Record<string, unknown>>(text: string, params: unknown[]): Promise<{ rows: R[] }>;
}

export async function countForSybilTier(
	db: SybilTierQueryable,
	account: string,
	at: Date
): Promise<number> {
	const cutoff = new Date(at.getTime() - SYBIL_TIER_WINDOW_MS);
	const res = await db.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n
		 FROM orders
		 WHERE account = $1
		   AND ((status = 'live' AND (expires_at IS NULL OR expires_at > $3))
		        OR created_at >= $2)`,
		[account, cutoff, at]
	);
	return parseInt(res.rows[0]?.n ?? '0', 10);
}
