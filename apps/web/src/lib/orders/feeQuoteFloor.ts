/**
 * Chain-pinned bounds on the listing-fee QUOTE.
 *
 * What was wrong: the post page quoted exactly what `/v1/listing-fee` said
 * (`base_fee_blurt`, and the live BTC/XMR amounts). On a hidden-only node that
 * number comes from a federated price median that sybil peers could steer, so a
 * user could be quoted ~1.25 BLURT against an enforced floor of ~106 — the
 * order lands `underpaid` and the fee is lost — or be made to overpay ~10×.
 * The fallback constant (BASE_FEE_BLURT) could also sit below a higher pin.
 *
 * The indexer enforces the CHAIN-PINNED amount minus FEE_PRICE_TOLERANCE as a
 * floor. So when the signed release carries a pinned amount, the client keeps
 * its quote inside pinned × [1 − T, 1 + T]: never below what the indexer
 * accepts, and never more than T above the pin (the indexer accepts any
 * overpayment, so the upper bound can never cause a rejection). With no pinned
 * amount known, the quote passes through unchanged.
 */

import { FEE_PRICE_TOLERANCE } from '@morphit/asset-registry';

/** One milliBLURT — the smallest amount the chain can carry. */
const BLURT_QUOTE_HEADROOM = 0.001;

function usable(n: number | null | undefined): n is number {
	return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** The BLURT base to quote: the indexer's figure (or the fallback), kept inside
 *  the chain-pinned band. */
export function boundedBlurtBase(
	quoted: number | null | undefined,
	fallback: number,
	pinnedBase: number | null | undefined
): number {
	const base = usable(quoted) ? quoted : fallback;
	if (!usable(pinnedBase)) return base;
	// (v1.20.0, G8) +1 milliBLURT of headroom above the exact floor: a quote
	// clamped onto the floor used to land ON the indexer's float boundary
	// (0.2% of pins were rejected as underpaid). The indexer now compares in
	// integer milliBLURT too; this keeps a margin on both sides.
	const lo = pinnedBase * (1 - FEE_PRICE_TOLERANCE) + BLURT_QUOTE_HEADROOM;
	const hi = pinnedBase * (1 + FEE_PRICE_TOLERANCE);
	return Math.min(hi, Math.max(lo, base));
}

/** Live BTC fee in satoshis, kept inside the pinned band (whole satoshis,
 *  rounded toward the inside of the band). undefined → quote the pin. */
export function boundedSatoshis(
	live: number | undefined,
	pinnedSats: number | null | undefined
): number | undefined {
	if (!usable(live)) return undefined;
	if (!usable(pinnedSats)) return live;
	const lo = Math.ceil(pinnedSats * (1 - FEE_PRICE_TOLERANCE));
	const hi = Math.floor(pinnedSats * (1 + FEE_PRICE_TOLERANCE));
	return Math.min(hi, Math.max(lo, Math.round(live)));
}

/** Live XMR fee in piconero (decimal string), kept inside the pinned band. */
export function boundedPiconero(
	live: string | undefined,
	pinnedPiconero: string | null | undefined
): string | undefined {
	if (live === undefined || !/^[0-9]+$/.test(live) || BigInt(live) <= 0n) return undefined;
	if (!pinnedPiconero || !/^[0-9]+$/.test(pinnedPiconero)) return live;
	const pin = BigInt(pinnedPiconero);
	if (pin <= 0n) return live;
	const permille = BigInt(Math.round(FEE_PRICE_TOLERANCE * 1000));
	const lo = (pin * (1000n - permille) + 999n) / 1000n;
	const hi = (pin * (1000n + permille)) / 1000n;
	const v = BigInt(live);
	return (v < lo ? lo : v > hi ? hi : v).toString();
}

/**
 * The BLURT base to quote, or null when there is no
 * SAFE quote. The bundled fallback constant (BASE_FEE_BLURT, 60) was used
 * whenever /v1/listing-fee failed — but with no chain pin the indexer
 * enforces ITS env base (MORPHIT_INDEXER_FEE_BASE_BLURT, default 125) minus
 * 15% = 106.25, so a 60-BLURT payment landed `underpaid` and the fee was lost.
 * Rule: a live indexer figure is used (clamped to the pin band when a pin is
 * known); with no indexer figure the fallback is used ONLY inside a known
 * pinned band; with neither, refuse to quote (the page shows its friendly
 * "couldn't load the fee" message instead of letting the user pay a guess).
 */
export function resolveQuoteBase(
	quoted: number | null | undefined,
	fallback: number,
	pinnedBase: number | null | undefined
): number | null {
	if (!usable(quoted) && !usable(pinnedBase)) return null;
	return boundedBlurtBase(quoted, fallback, pinnedBase);
}
