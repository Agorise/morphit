/**
 * Blurt price-feed fetcher — api.blurt.blog/price_info (cp425).
 *
 * A Blurt-native BLURT/USD source added alongside the market
 * aggregators (Coingecko, CoinPaprika, …). It joins the same
 * median-anchored robust average in CompositeCachedPriceSource, so
 * it's one more independent reading that damps any single provider's
 * swing — and it's self-sovereign to the Blurt ecosystem rather than
 * a third-party CEX aggregator, which fits Morphit's decentralization
 * priority.
 *
 * ⚠ SHAPE IS BEST-EFFORT / VERIFY ON DEPLOY. The exact JSON shape of
 * `/price_info` is not something we can pin from here, so this parser
 * is DEFENSIVE: it scans a set of likely price fields (and a couple of
 * nested shapes), and — crucially — only accepts a candidate that
 * falls inside the caller's plausibility band (for BLURT, 0.0001–0.1).
 * That band is what makes a wrong field harmless: a 24h-volume,
 * percent-change, or market-cap value can't be mistaken for a
 * sub-cent price, so at worst this returns null and the source is
 * silently excluded from the average (never throws, never pollutes).
 * An operator should curl the endpoint once on deploy to confirm it's
 * actually contributing; if the real field isn't covered here, add it.
 *
 * Endpoint: GET https://api.blurt.blog/price_info
 * Accepted shapes (first plausible wins):
 *   0.0019
 *   "0.0019"
 *   { "price": 0.0019 }            { "price": "0.0019" }
 *   { "price_usd": 0.0019 }        { "usd": 0.0019 }   { "USD": 0.0019 }
 *   { "last": 0.0019 }             { "last_price": 0.0019 }
 *   { "current_price": 0.0019 }    { "value": 0.0019 }
 *   { "blurt_usd": 0.0019 }        { "blurt": { "usd": 0.0019 } }
 *   { "data": { "price": 0.0019 } } (any of the leaf keys above under `data`)
 *
 * Contract: never throws; returns a positive, plausible number or null.
 */

import { logger } from '$log';
import {
	priceUpstreamFetchInit,
	priceUpstreamHeaders,
	readPriceBodyCapped
} from './priceFetchUtil.ts';

const log = logger('price-blurt-feed');

export interface BlurtBlogConfig {
	/** Full price-feed URL. Default (set by the factory):
	 *  https://api.blurt.blog/price_info. An operator can override or
	 *  set it empty to disable this source. */
	readonly url: string;
	/** Lower plausibility bound for the parsed price (inclusive).
	 *  A candidate below this is rejected — this is how a stray
	 *  non-price field (e.g. a tiny percent) can't slip through. */
	readonly plausibleMin: number;
	/** Upper plausibility bound for the parsed price (inclusive).
	 *  A candidate above this is rejected — guards against picking up
	 *  a volume / market-cap / count field by accident. */
	readonly plausibleMax: number;
	/** Request timeout in ms. */
	readonly timeoutMs: number;
	/** fetch injection for tests. */
	readonly fetchImpl?: typeof globalThis.fetch;
}

export function createBlurtBlogFetcher(config: BlurtBlogConfig): () => Promise<number | null> {
	const fetchImpl = config.fetchImpl ?? globalThis.fetch;
	const url = config.url;

	return async function fetchBlurtFeed(): Promise<number | null> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), config.timeoutMs);
		try {
			const res = await fetchImpl(url, {
				...priceUpstreamFetchInit(ac.signal),
				headers: priceUpstreamHeaders()
			});
			if (res.status === 429) {
				log.warn('rate_limited', { url });
				return null;
			}
			if (!res.ok) {
				log.warn('http_not_ok', { url, status: res.status });
				return null;
			}
			const text = await readPriceBodyCapped(res, ac, url);
			let body: unknown;
			try {
				body = JSON.parse(text) as unknown;
			} catch {
				// Not JSON — maybe a bare numeric body ("0.0019").
				body = text.trim();
			}
			const price = extractPlausiblePrice(body, config.plausibleMin, config.plausibleMax);
			if (price === null) {
				log.warn('unexpected_shape_or_implausible', { url });
				return null;
			}
			return price;
		} catch (err) {
			log.warn('fetch_error', { url }, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}

/** A number, or a numeric string, coerced to a finite positive number
 *  — otherwise null. Rejects NaN/Infinity/≤0 and non-numeric strings. */
function coerceNum(v: unknown): number | null {
	if (typeof v === 'number') {
		return Number.isFinite(v) && v > 0 ? v : null;
	}
	if (typeof v === 'string') {
		const t = v.trim();
		if (t === '') return null;
		const n = Number(t);
		return Number.isFinite(n) && n > 0 ? n : null;
	}
	return null;
}

/** Leaf keys that plausibly hold a BLURT/USD price, most-specific first. */
const PRICE_KEYS = [
	'price',
	'price_usd',
	'priceUsd',
	'usd',
	'USD',
	'blurt_usd',
	'blurtUsd',
	'last',
	'last_price',
	'lastPrice',
	'current_price',
	'currentPrice',
	'value'
] as const;

/** Scan `body` for the first price-like value that falls inside
 *  [min, max]. Handles a bare number/string, a flat object, `data.*`,
 *  and `blurt.usd`. Returns null if nothing plausible is found. */
function extractPlausiblePrice(body: unknown, min: number, max: number): number | null {
	const inBand = (n: number | null): number | null => (n !== null && n >= min && n <= max ? n : null);

	// Bare number or numeric string.
	const bare = inBand(coerceNum(body));
	if (bare !== null) return bare;

	if (typeof body !== 'object' || body === null) return null;
	const obj = body as Record<string, unknown>;

	// Flat leaf keys on the top-level object.
	for (const k of PRICE_KEYS) {
		const hit = inBand(coerceNum(obj[k]));
		if (hit !== null) return hit;
	}

	// Nested `data: { <leaf> }`.
	const data = obj.data;
	if (typeof data === 'object' && data !== null) {
		const d = data as Record<string, unknown>;
		for (const k of PRICE_KEYS) {
			const hit = inBand(coerceNum(d[k]));
			if (hit !== null) return hit;
		}
	}

	// Coingecko-like `blurt: { usd }`.
	const blurt = obj.blurt;
	if (typeof blurt === 'object' && blurt !== null) {
		const b = blurt as Record<string, unknown>;
		const hit = inBand(coerceNum(b.usd ?? b.USD));
		if (hit !== null) return hit;
	}

	return null;
}
