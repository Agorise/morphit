/**
 * Pure response-body builder for /v1/stranger-fee-quote/:sender.
 *
 * Extracted from `strangerFeeQuote.ts` so the response shape can
 * be unit-tested without spinning up Hono.  The route is now a
 * thin wrapper around this and account-name validation.
 *
 * Lives in its own module because tsx-style smokes can't load
 * modules that import `hono` (the package isn't installed in the
 * sandbox).
 */

import {
	getStrangerFeeQuote,
	type Queryable,
	STRANGER_FEE_BASE_BLURT,
	STRANGER_FEE_MAX_MULTIPLIER,
	STRANGER_FEE_WINDOW_MINUTES
} from '$indexer/strangerFeePricing';

export async function buildStrangerFeeQuoteBody(
	db: Queryable,
	sender: string
): Promise<Record<string, unknown>> {
	const quote = await getStrangerFeeQuote(db, sender);
	return {
		account: sender,
		base_price_blurt: STRANGER_FEE_BASE_BLURT,
		price_blurt: quote.priceBlurt,
		multiplier: quote.multiplier,
		recent_count: quote.recentCount,
		window_minutes: STRANGER_FEE_WINDOW_MINUTES,
		capped: quote.capped,
		max_multiplier: STRANGER_FEE_MAX_MULTIPLIER
	};
}
