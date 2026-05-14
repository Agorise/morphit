/**
 * Morphit — prices public API.
 *
 * This is what consumers import. Internally maintains a small in-memory
 * cache so repeated calls within `CACHE_TTL_MS` reuse the last quote
 * rather than re-fetching. The cache is per-session (no persistence);
 * on reload, the next call freshens the quote.
 *
 * A reactive `priceStore` store exposes the last known quote per symbol,
 * so UI components can subscribe and auto-re-render the "updated X ago"
 * timer.
 */

import { writable, type Readable } from 'svelte/store';
import type { PriceProvider, PriceQuote, PricedSymbol } from './types';
import { fallbackProvider } from './providers/fallback';

/** How long a quote is considered fresh without re-fetching. */
const CACHE_TTL_MS = 60_000;

/** Swap this in Phase 3 for an on-chain oracle provider or the relay
 *  API provider (or a composite that tries one then the other). Phase 2
 *  hardcodes fallback. */
let activeProvider: PriceProvider = fallbackProvider;

const cache = new Map<PricedSymbol, PriceQuote>();

const internalStore = writable<Record<PricedSymbol, PriceQuote | null>>({
	BTC: null,
	XMR: null,
	BLURT: null,
	USDT: null
});

/**
 * Read-only store of the last known quote per symbol. UI components
 * that show "updated N seconds ago" subscribe to this and re-derive
 * the elapsed time every second on their own timer.
 */
export const priceStore: Readable<Record<PricedSymbol, PriceQuote | null>> = {
	subscribe: internalStore.subscribe
};

export async function getPrice(symbol: PricedSymbol): Promise<PriceQuote> {
	const cached = cache.get(symbol);
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached;
	}
	const fresh = await activeProvider.getPriceUsd(symbol);
	cache.set(symbol, fresh);
	internalStore.update((s) => ({ ...s, [symbol]: fresh }));
	return fresh;
}

/**
 * Convert a USD amount into a quantity of `symbol`.
 * @example usdToSymbolAmount(50, 'BLURT') -> 25000 if BLURT is $0.002
 */
export async function usdToSymbolAmount(
	usd: number,
	symbol: PricedSymbol
): Promise<{ amount: number; quote: PriceQuote }> {
	const quote = await getPrice(symbol);
	return { amount: usd / quote.usd, quote };
}

/**
 * Convert a quantity of `symbol` into a USD amount.
 * @example symbolAmountToUsd(0.001, 'BTC') -> 95 if BTC is $95k
 */
export async function symbolAmountToUsd(
	amount: number,
	symbol: PricedSymbol
): Promise<{ usd: number; quote: PriceQuote }> {
	const quote = await getPrice(symbol);
	return { usd: amount * quote.usd, quote };
}

/** For Phase 3: allow swapping the active provider. No-op in Phase 2
 *  unless explicitly called from code that ships later. */
export function setProvider(provider: PriceProvider): void {
	activeProvider = provider;
	// Cache is invalidated because a different provider will have
	// different quotes; don't serve old values from the previous source.
	cache.clear();
	internalStore.set({ BTC: null, XMR: null, BLURT: null, USDT: null });
}

export function currentProviderName(): string {
	return activeProvider.name;
}

export type { PriceQuote, PriceProvider, PricedSymbol } from './types';
