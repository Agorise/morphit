/**
 * Morphit indexer — /v1/chain-fee endpoint.
 *
 * Returns the current chain-set account-creation fee in BLURT.
 * Witnesses can change this value; we read it from the chain
 * once per 24 hours and cache the result.  Frontend uses this
 * to display the live fee in FAQ entries and signup helpers
 * instead of hardcoding "100 BLURT" everywhere.
 *
 * Why daily and not on-demand:
 *   - Witnesses change it rarely (typically not for months)
 *   - Frontend renders this on every cold load; uncached we'd
 *     hammer Blurt RPC nodes for a value that doesn't move
 *   - 24h staleness is acceptable; if witnesses raise it
 *     mid-day the operator's relay still validates against
 *     the live value at signup time (relay's 10% sanity
 *     threshold catches surprise changes there)
 *
 * Falls back to the operator's configured
 * MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT when chain RPC is
 * unavailable, so the endpoint never returns 5xx — the
 * frontend always gets SOMETHING reasonable to render.
 */

import { Hono } from 'hono';
import { fetchChainProperties } from '$blurt/chainProperties';
import type { BlurtClient } from '$blurt/client';
import type { Config } from '$config';

interface CachedValue {
	readonly accountCreationFeeBlurt: number;
	readonly observedAt: number; // ms epoch
	readonly source: 'chain' | 'fallback';
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Module-level cache.  Survives across requests within a
 *  single indexer process; restart resets it. */
let cache: CachedValue | null = null;

/** In-flight refresh promise — prevents thundering-herd on
 *  cold-cache when many concurrent requests arrive. */
let inflight: Promise<CachedValue> | null = null;

async function refresh(blurt: BlurtClient, fallbackBlurt: number): Promise<CachedValue> {
	try {
		const props = await fetchChainProperties(blurt);
		return {
			accountCreationFeeBlurt: props.accountCreationFeeBlurt,
			observedAt: Date.now(),
			source: 'chain'
		};
	} catch {
		// Don't 5xx — surface the fallback with a 'fallback'
		// source flag.  Frontend can decide whether to dim the
		// value or surface a "couldn't reach chain" hint.
		return {
			accountCreationFeeBlurt: fallbackBlurt,
			observedAt: Date.now(),
			source: 'fallback'
		};
	}
}

async function getOrRefresh(blurt: BlurtClient, fallbackBlurt: number): Promise<CachedValue> {
	const now = Date.now();
	if (cache !== null && now - cache.observedAt < CACHE_TTL_MS) {
		return cache;
	}
	if (inflight !== null) return inflight;
	inflight = refresh(blurt, fallbackBlurt).finally(() => {
		// Clear inflight after promise settles, regardless of
		// outcome.  Cache update only on resolved value.
	});
	const fresh = await inflight;
	cache = fresh;
	inflight = null;
	return fresh;
}

export interface ChainFeeResponse {
	account_creation_fee_blurt: number;
	observed_at: string; // ISO-8601
	source: 'chain' | 'fallback';
}

export function chainFeeRoute(blurt: BlurtClient, config: Config): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		const fallback = config.accountCreationFeeBlurtFallback ?? 100;
		const value = await getOrRefresh(blurt, fallback);
		const body: ChainFeeResponse = {
			account_creation_fee_blurt: value.accountCreationFeeBlurt,
			observed_at: new Date(value.observedAt).toISOString(),
			source: value.source
		};
		// Cache aggressively at the HTTP layer too — 1 hour is
		// shorter than our internal 24h TTL but lets reverse
		// proxies and CDNs help under load.  Frontend service
		// worker can cache for the same duration.
		c.header('Cache-Control', 'public, max-age=3600');
		return c.json(body);
	});

	return app;
}

/** Reset the in-process cache.  Test-only; not exported via the
 *  HTTP surface.  Tests that exercise the endpoint multiple
 *  times need this to avoid cross-scenario bleed. */
export function _resetChainFeeCache(): void {
	cache = null;
	inflight = null;
}
