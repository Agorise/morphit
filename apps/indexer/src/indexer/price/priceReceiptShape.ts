/**
 * The `/v1/price/morphit-native/receipt` body, defined once for both ends:
 * the producer (api/priceReceipt.ts) builds a {@link PriceReceiptBody} and the
 * consumer (peerPriceMonitor.fetchPeerReceipt) reads one with
 * {@link parsePeerReceipt}.
 *
 * The two ends used to be written separately and disagreed: the consumer
 * read `derived_price`, a field no producer ever sent, so every peer receipt
 * parsed to nothing, no peer price was ever recorded, and a hidden-only node's
 * federated price never had a sample.
 */

import type { NativeDerivationResult } from '$indexer/price/morphitNativeFetcher';
import type { StablecoinDepegReport } from '$indexer/price/stablecoinDepegDetector';

export const PRICE_RECEIPT_PATH = '/v1/price/morphit-native/receipt';

export interface PriceReceiptBody {
	readonly asset: string;
	readonly denomination_fiat: string;
	readonly as_of: string;
	/** The morphit_native price, or null when no tier qualified. */
	readonly price: number | null;
	/** How the price was derived. Always morphit_native on this endpoint;
	 *  stated so a reader never has to infer it from the URL. */
	readonly source: 'morphit_native';
	readonly tier_used: NativeDerivationResult['tier_used'];
	readonly null_reason: string | null;
	readonly tier_attempted: NativeDerivationResult['tier_attempted'];
	readonly contributing_traders: ReadonlyArray<string>;
	readonly depeg_report: StablecoinDepegReport;
	readonly window_hours: number;
	readonly envelope: {
		readonly hardcoded_outer_min_usd: number;
		readonly hardcoded_outer_max_usd: number;
		/** The plausibility envelope applied to THIS asset. */
		readonly asset_min_usd: number;
		readonly asset_max_usd: number;
	};
	readonly thresholds: {
		readonly min_distinct_traders: number;
		readonly min_stablecoin_count_tier2: number;
		readonly order_age_grace_minutes: number;
	};
	readonly warning: string;
}

/** What a peer's receipt contributes to the peer-price median. */
export interface PeerReceipt {
	readonly asset: string;
	readonly denominationFiat: string;
	readonly price: number;
	readonly sourceNative: 'morphit_native' | 'unknown';
}

const TIERS: ReadonlySet<string> = new Set([
	'tier1_usd_direct',
	'tier2_stablecoin',
	'tier3_hybrid'
]);

/**
 * Read a peer's receipt. Null when it carries no usable price for exactly the
 * asked (asset, denomination). PURE.
 *
 * `source` is new; a peer on an older release omits it. Its receipt still comes
 * from the morphit_native derivation (that is the only thing the endpoint
 * serves), which a named tier confirms, so such a receipt counts as
 * morphit_native. Anything else is 'unknown' and stays out of the median.
 */
export function parsePeerReceipt(
	body: unknown,
	asset: string,
	denominationFiat: string
): PeerReceipt | null {
	if (body === null || typeof body !== 'object') return null;
	const b = body as Record<string, unknown>;
	const price = b.price;
	if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
	if (b.asset !== asset) return null;
	// Same-denomination filter: a USD price cannot be compared with a EUR one.
	if (b.denomination_fiat !== denominationFiat) return null;
	const native =
		b.source === 'morphit_native' ||
		(b.source === undefined && typeof b.tier_used === 'string' && TIERS.has(b.tier_used));
	return { asset, denominationFiat, price, sourceNative: native ? 'morphit_native' : 'unknown' };
}
