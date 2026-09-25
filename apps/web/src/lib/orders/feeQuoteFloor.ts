/**
 * Chain-pinned bounds on the listing-fee QUOTE (v1.18.0 deep-deep, M1).
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
	const lo = pinnedBase * (1 - FEE_PRICE_TOLERANCE);
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
