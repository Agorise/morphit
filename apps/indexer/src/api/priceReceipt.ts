/**
 * Morphit indexer — /v1/price/morphit-native/receipt (defense G).
 *
 * The "show your work" endpoint for price derivation.  Parallels the
 * reputation-receipt endpoint in spirit and structure.
 *
 * Why this exists
 * ───────────────
 * Reputation hardening taught us that PROVABILITY beats
 * perfection.  The reputation receipt lets any chain reader re-derive
 * an account's score; this endpoint does the same for the morphit_native
 * price.
 *
 * Defense G in the black-hat checklist:
 *
 *   Patient sock-puppet attackers may build up legitimate-looking
 *   accounts over months, evading the Sybil signal
 *   tables, and then coordinate to manipulate the price.  We can't
 *   prevent that perfectly at intake time.  But we CAN make
 *   after-the-fact forensics easy: publish exactly which accounts
 *   contributed to a price + which tier they used + what their
 *   median was.  Anticipation of post-hoc forensics is itself a
 *   deterrent.
 *
 * What the receipt exposes
 * ────────────────────────
 *
 *   - The current price + which tier produced it
 *   - The list of distinct trader accounts whose orders contributed
 *   - The cross-stablecoin depeg detector's full pair-detail output
 *   - Which tiers were attempted and why they were used / skipped
 *   - Plausibility-envelope settings (operator config + hardcoded
 *     outer bounds for comparison)
 *   - Drift monitor state
 *   - Cross-source disagreement state
 *   - NOT-AN-ORACLE warning text (loudly visible)
 *
 * What the receipt does NOT expose
 * ────────────────────────────────
 *
 *   - The full order details (amounts, fiat, payment methods).
 *     These are already publicly visible via the orderbook endpoint;
 *     duplicating them here would just be a larger payload.  Readers
 *     who want order-level detail look them up by account from the
 *     contributing_traders list.
 *   - Per-order Sybil-filter decisions (whether an order would have
 *     been included if not flagged).  Useful for super-deep forensics
 *     but exposes Sybil-table flag pairs in a new way; deferred.
 *
 * Shape
 * ─────
 * The body is a PriceReceiptBody (indexer/price/priceReceiptShape.ts),
 * the same type peer instances parse it with (peerPriceMonitor) — one
 * definition, so producer and consumer cannot drift apart again.
 *
 * Caching
 * ───────
 * ETag over the body's content, excluding `as_of` (the derivation time,
 * which changes on every call and would make every ETag unique).
 * Cache-Control: 60s.  The receipt is re-derived on every request.
 */

import { createHash } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import type { Database } from '$db/pool';
import type { Config } from '$config';
import { errorBody } from '$api/shared';
import {
	deriveMorphitNativePrice,
	HARDCODED_OUTER_MIN_USD,
	HARDCODED_OUTER_MAX_USD,
	NATIVE_MIN_DISTINCT_TRADERS,
	NATIVE_MIN_STABLECOIN_COUNT_TIER2,
	NATIVE_ORDER_AGE_GRACE_MINUTES
} from '$indexer/price/morphitNativeFetcher';
import { nativePlausibleEnvelope } from '$indexer/price/factory';
import type { PriceReceiptBody } from '$indexer/price/priceReceiptShape';

/** Loudly-visible warning in the receipt payload.  Defense H in the
 *  black-hat checklist: downstream protocols that ignore this and
 *  use morphit_native as an oracle are explicitly on notice. */
export const NOT_AN_ORACLE_WARNING =
	'NOT-AN-ORACLE: This price is for the morphit indexer\'s internal USD ' +
	'display only. It is NOT designed to be consumed as an external oracle ' +
	'by other smart contracts or value-bearing systems. Anyone using this ' +
	'price as input to a lending protocol, DEX, or other system where money ' +
	'depends on the value being correct does so AGAINST the explicit ' +
	'recommendation of Morphit\'s designers, and accepts full responsibility ' +
	'for any losses resulting from price manipulation. See ADR-0039.';

const querySchema = z.object({
	asset: z.string().regex(/^[A-Za-z0-9]{2,16}$/).optional(),
	denomination_fiat: z.string().regex(/^[A-Za-z]{3,8}$/).optional()
});

/** Defaults used when query params are omitted.  A later change wires only
 *  BLURT/USD; future iterations can route on the query params.
 *  denomination_fiat default now reads from config instead
 *  of being hardcoded 'USD' — operators can serve receipts in their
 *  configured denomination.  Query-param override still allowed
 *  for inspection of "what would this receipt look like for fiat
 *  X if I switched?" use cases. */
const DEFAULT_ASSET = 'BLURT';

export function priceReceiptRoute(db: Database, config: Config): Hono {
	const app = new Hono();

	app.get('/morphit-native/receipt', async (c) => {
		const parsed = querySchema.safeParse(
			Object.fromEntries(new URL(c.req.url).searchParams)
		);
		if (!parsed.success) {
			return c.json(
				errorBody(
					'bad_request',
					parsed.error.issues.map((i) => i.message).join('; ')
				),
				400
			);
		}
		const asset = (parsed.data.asset ?? DEFAULT_ASSET).toUpperCase();
		const denominationFiat = (
			parsed.data.denomination_fiat ?? config.priceFeedDenominationFiat
		).toUpperCase();

		// Re-run derivation for the receipt.  The fetcher is cheap;
		// re-running gives us up-to-the-second data instead of a
		// cached value possibly minutes old.  60s ETag caching covers
		// the repeated-call case.
		//
		// IMPORTANT: We don't gate by whether the native fetcher is
		// CURRENTLY in the composite chain (config.priceFeedNativeEnabled).
		// The receipt is informational — operators may want to see
		// what the native fetcher WOULD produce even when it's off,
		// for evaluation purposes.
		//
		// The envelope is the asset's own (nativePlausibleEnvelope): the
		// operator's native envelope describes BLURT, and applied to BTC or
		// XMR it rejected every price.
		const envelope = nativePlausibleEnvelope(config, asset);
		const derivation = await deriveMorphitNativePrice({
			asset,
			denominationFiat,
			stablecoinKeys: config.priceFeedStablecoinKeys,
			db,
			operatorAccountName: config.operatorAccountName,
			minPlausibleUsd: envelope.min,
			maxPlausibleUsd: envelope.max
		});

		const response: PriceReceiptBody = {
			asset,
			denomination_fiat: denominationFiat,
			as_of: derivation.as_of,
			price: derivation.price,
			source: 'morphit_native',
			tier_used: derivation.tier_used,
			null_reason: derivation.null_reason ?? null,
			tier_attempted: derivation.tier_attempted,
			contributing_traders: derivation.contributing_traders,
			depeg_report: derivation.depeg_report,
			window_hours: derivation.window_hours,
			envelope: {
				hardcoded_outer_min_usd: HARDCODED_OUTER_MIN_USD,
				hardcoded_outer_max_usd: HARDCODED_OUTER_MAX_USD,
				asset_min_usd: Math.max(envelope.min, HARDCODED_OUTER_MIN_USD),
				asset_max_usd: Math.min(envelope.max, HARDCODED_OUTER_MAX_USD)
			},
			thresholds: {
				min_distinct_traders: NATIVE_MIN_DISTINCT_TRADERS,
				min_stablecoin_count_tier2: NATIVE_MIN_STABLECOIN_COUNT_TIER2,
				order_age_grace_minutes: NATIVE_ORDER_AGE_GRACE_MINUTES
			},
			warning: NOT_AN_ORACLE_WARNING
		};

		const etag = receiptEtag(response);
		c.header('ETag', etag);
		c.header('Cache-Control', 'public, max-age=60');

		const ifNoneMatch = c.req.header('if-none-match');
		if (ifNoneMatch === etag) {
			return c.body(null, 304);
		}

		return c.json(response);
	});

	return app;
}

/** ETag over everything in the body except `as_of`, the derivation time. */
export function receiptEtag(body: PriceReceiptBody): string {
	const { as_of: _asOf, ...content } = body;
	return `"${createHash('sha256').update(JSON.stringify(content)).digest('base64url').slice(0, 22)}"`;
}
