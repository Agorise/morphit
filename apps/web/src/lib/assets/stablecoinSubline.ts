/**
 * The USD-pegged stablecoins that get a live-price subline on their order rows
 * (see StablecoinPriceSubline.svelte). Single source of truth so OrderCard and
 * the component agree on the set. cp417 — generalised from USDT-only to all
 * three stablecoins that carry `assets.<t>.price_subline.*` strings.
 */
export const STABLECOIN_SUBLINE_TICKERS = ['USDT', 'USDC', 'DAI'] as const;
export type StablecoinSublineTicker = (typeof STABLECOIN_SUBLINE_TICKERS)[number];

/** Narrowing guard for template/OrderCard use. */
export function isStablecoinSublineTicker(t: string): t is StablecoinSublineTicker {
	return (STABLECOIN_SUBLINE_TICKERS as readonly string[]).includes(t);
}
