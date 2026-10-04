/**
 * Morphit — live prices from this instance's indexer.
 *
 * GET /v1/listing-fee carries the USD prices the indexer holds for BLURT, BTC
 * and XMR (`blurt_price_fiat`, `btc_price_fiat`, `xmr_price_fiat`), and only
 * while they are fresh: the indexer omits a price its feed has not refreshed
 * (apps/indexer/src/api/listingFeeBody.ts). Same origin, so the browser
 * contacts no price service of its own.
 *
 * Every other asset — and these three when the indexer has no fresh value or
 * quotes in another currency — has no live price here: the result is null
 * ("unknown"), never a bundled constant.
 */

import type { ListingFeeResponse } from '@morphit/indexer-client';
import type { PriceQuote, PricedSymbol } from '../types';

/** A source of live prices: null = no live price for that symbol now. */
export interface LivePriceSource {
	readonly name: string;
	getLiveUsd(symbol: PricedSymbol): Promise<PriceQuote | null>;
}

/** How long one /v1/listing-fee read serves all three symbols. */
const READ_TTL_MS = 60_000;

const FIELD: Partial<
	Record<PricedSymbol, 'blurt_price_fiat' | 'btc_price_fiat' | 'xmr_price_fiat'>
> = {
	BLURT: 'blurt_price_fiat',
	BTC: 'btc_price_fiat',
	XMR: 'xmr_price_fiat'
};

/** `load` reads /v1/listing-fee (null when the read fails). */
export function createIndexerPriceSource(
	load: () => Promise<Partial<ListingFeeResponse> | null>
): LivePriceSource {
	let last: { at: number; body: Partial<ListingFeeResponse> | null } | null = null;
	let inflight: Promise<Partial<ListingFeeResponse> | null> | null = null;

	async function read(): Promise<{ at: number; body: Partial<ListingFeeResponse> | null }> {
		if (last !== null && Date.now() - last.at < READ_TTL_MS) return last;
		inflight ??= load().catch(() => null);
		try {
			const body = await inflight;
			last = { at: Date.now(), body };
			return last;
		} finally {
			inflight = null;
		}
	}

	return {
		name: 'indexer',
		async getLiveUsd(symbol: PricedSymbol): Promise<PriceQuote | null> {
			const field = FIELD[symbol];
			if (field === undefined) return null;
			const { at, body } = await read();
			if (body === null) return null;
			if (
				typeof body.denomination_fiat !== 'string' ||
				body.denomination_fiat.toUpperCase() !== 'USD'
			) {
				return null;
			}
			const usd = body[field];
			if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
			return { symbol, usd, fetchedAt: at, source: 'indexer' };
		}
	};
}
