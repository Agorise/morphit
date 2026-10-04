/**
 * Morphit — prices public API.
 *
 * Live USD prices come from this instance's indexer (providers/indexer.ts:
 * BLURT, BTC and XMR, while its feed is fresh). Where there is no live price
 * the answer is null — "unknown" — and callers show no price: a market
 * order's pay amount stays blank, no "live" line is drawn, no fiat hint is
 * given. No bundled constant is presented as a price.
 *
 * Quotes are cached for `CACHE_TTL_MS`; a quote older than `MAX_QUOTE_AGE_MS`
 * is not treated as live (`liveUsd`). The reactive `priceStore` exposes the
 * last known quote per symbol (null = unknown) for UI that shows its age.
 */

import { writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import type { PriceQuote, PricedSymbol } from './types';
import { createIndexerPriceSource, type LivePriceSource } from './providers/indexer';
import { fetchListingFee } from '$lib/orders/listingFee';
import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';

/** How long a quote is reused without asking again. */
const CACHE_TTL_MS = 60_000;

/** A quote older than this is not a live price. */
export const MAX_QUOTE_AGE_MS = 10 * 60_000;

const activeSource: LivePriceSource = createIndexerPriceSource(async () => {
	if (!browser) return null;
	const r = await fetchListingFee(resolveOrigin(MORPHIT_INDEXER_ORIGIN));
	return r.kind === 'ok' ? r.quote : null;
});

const cache = new Map<PricedSymbol, { at: number; quote: PriceQuote | null }>();

const internalStore = writable<Record<PricedSymbol, PriceQuote | null>>({
	BTC: null,
	XMR: null,
	BLURT: null,
	USDT: null,
	USDC: null,
	DAI: null,
	BCH: null,
	LTC: null,
	DASH: null,
	DOGE: null,
	ZEC: null,
	ARRR: null,
	DCR: null,
	SOL: null,
	ETH: null,
	XRP: null
});

/**
 * Read-only store of the last known quote per symbol. UI components
 * that show "updated N seconds ago" subscribe to this and re-derive
 * the elapsed time every second on their own timer.
 */
export const priceStore: Readable<Record<PricedSymbol, PriceQuote | null>> = {
	subscribe: internalStore.subscribe
};

/** The live USD price of `symbol`, or null when there is none (unknown). */
export async function getPrice(symbol: PricedSymbol): Promise<PriceQuote | null> {
	const cached = cache.get(symbol);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.quote;
	let quote: PriceQuote | null = null;
	try {
		quote = await activeSource.getLiveUsd(symbol);
	} catch {
		quote = null;
	}
	cache.set(symbol, { at: Date.now(), quote });
	internalStore.update((s) => ({ ...s, [symbol]: quote }));
	return quote;
}

/** The quote's USD price if it is still live at `now`, else null. */
export function liveUsd(
	quote: PriceQuote | null | undefined,
	now: number = Date.now()
): number | null {
	if (!quote) return null;
	if (!Number.isFinite(quote.usd) || quote.usd <= 0) return null;
	return now - quote.fetchedAt <= MAX_QUOTE_AGE_MS ? quote.usd : null;
}

/**
 * Convert a USD amount into a quantity of `symbol`; null when the price is
 * unknown.
 */
export async function usdToSymbolAmount(
	usd: number,
	symbol: PricedSymbol
): Promise<{ amount: number; quote: PriceQuote } | null> {
	const quote = await getPrice(symbol);
	const p = liveUsd(quote);
	return quote && p !== null ? { amount: usd / p, quote } : null;
}

/**
 * Convert a quantity of `symbol` into a USD amount; null when the price is
 * unknown.
 */
export async function symbolAmountToUsd(
	amount: number,
	symbol: PricedSymbol
): Promise<{ usd: number; quote: PriceQuote } | null> {
	const quote = await getPrice(symbol);
	const p = liveUsd(quote);
	return quote && p !== null ? { usd: amount * p, quote } : null;
}

export type { PriceQuote, PricedSymbol } from './types';
