/**
 * Morphit indexer — /v1/fx endpoint (cp372).
 *
 * Serves the indexer's cached USD→fiat rate table so the browser
 * can compute the "$1 USD-equivalent" first-order minimum (and any
 * other fiat echo) in the user's LOCAL currency without itself
 * calling an FX provider.
 *
 * **Privacy invariant (matches the FX source's design).**  The
 * endpoint returns the WHOLE table in one response; the client
 * picks its own currency's rate locally.  The indexer never learns
 * which fiat any individual user selected — neither from an FX
 * provider (the source pulls base=USD wholesale, server-side) nor
 * from this endpoint (no per-currency query param).  This is why we
 * deliberately do NOT offer a `/v1/fx/:currency` lookup.
 *
 * The data is identical to what already drives the indexer-side
 * first-order floor (`OpContext.fiatToUsd`), so the client's
 * pre-submit check and the indexer's authoritative check agree.
 *
 * 404 when FX is disabled on this instance
 * (`MORPHIT_INDEXER_FX_FEED_ENABLED=false`) — the client then falls
 * back to treating the entered minimum as already-USD (the
 * pre-cp372 behaviour) and the indexer's own floor still applies.
 */

import { Hono } from 'hono';

import type { FxRateSource } from '$indexer/fx/source';
import { errorBody } from '$api/shared';

export function fxRoute(fx: FxRateSource | null): Hono {
	const app = new Hono();

	app.get('/', (c) => {
		if (fx === null) {
			return c.json(errorBody('not_found', 'fx feed disabled on this instance'), 404);
		}
		const d = fx.currentDetailed();
		return c.json({
			base: 'USD',
			rates: d.rates,
			source: d.source,
			stale: d.stale,
			updated_at: d.updated_at.toISOString(),
			currency_count: Object.keys(d.rates).length
		});
	});

	return app;
}
