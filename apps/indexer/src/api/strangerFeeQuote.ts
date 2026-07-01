/**
 * Morphit indexer — /v1/stranger-fee-quote/:sender endpoint.
 *
 * Returns the current escalating stranger-fee price for the
 * sender's next first-contact message. The frontend queries
 * this when the user opens the pay-to-message modal, so it
 * can display:
 *   - The current BLURT fee (which may be doubled from the base
 *     if the sender has paid for other strangers in the last 5
 *     minutes — anti-spam escalation).
 *   - A multiplier (1, 2, 4, ..., 128) and recent-count so the
 *     warning text can be specific.
 *   - The base price for context (so the UI can show "doubled
 *     from 5 BLURT because you've messaged N strangers
 *     recently").
 *
 * Authentication: none. The sender's recent stranger-fee
 * payments are all public on-chain state already (anyone can
 * scrape the blocks). Exposing a count + price is just
 * pre-aggregation.
 *
 * Response shape (ok):
 *   {
 *     account: string,
 *     base_price_blurt: number,
 *     price_blurt: number,
 *     multiplier: number,
 *     recent_count: number,
 *     window_minutes: number,
 *     capped: boolean,
 *     max_multiplier: number
 *   }
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';
import { buildStrangerFeeQuoteBody } from '$api/strangerFeeQuoteBody';

export { buildStrangerFeeQuoteBody };

export function strangerFeeQuoteRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:sender', async (c) => {
		const sender = c.req.param('sender');
		if (!isAccountName(sender)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}
		const body = await buildStrangerFeeQuoteBody(db, sender);
		return c.json(body);
	});

	return app;
}
