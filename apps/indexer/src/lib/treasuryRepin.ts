/**
 * Morphit — treasury auto-re-pin decision logic (cp372).
 *
 * Model A keeps the *enforcement* floor on a chain-pinned amount
 * (deterministic across the federation, no price read in the
 * verifier).  The cost of that choice is that the pinned amount
 * goes stale as the market moves: once a fee asset drifts far
 * enough, a user paying the live-quoted (canonical-USD) amount
 * would fall outside the verifier's FEE_PRICE_TOLERANCE band and
 * be rejected.  Historically the operator would have to notice
 * this and re-pin by hand.
 *
 * This module is the brain of the AUTOMATION that removes that
 * toil: given the currently chain-pinned amounts and live USD
 * prices, it decides whether a re-pin is due and computes the
 * fresh canonical amounts.  It is a PURE function — no network,
 * no chain, no key, no clock, no env — so it is exhaustively
 * unit-testable, which is exactly what a money-path decision
 * needs.  The thin CLI/timer wrapper (see the ops command) does
 * the impure parts: fetch the current release, fetch prices, call
 * this, and broadcast the new release op iff `shouldRepin`.
 *
 * Failsafes (all enforced here, the deterministic layer):
 *   - A missing / non-finite / non-positive price for an asset
 *     means that asset is SKIPPED entirely — never re-pinned from
 *     a bad price.  A feed outage can never move the pin.
 *   - A freshly-computed amount that exceeds the same sanity
 *     ceiling the release validator enforces is REJECTED — a
 *     wildly wrong price (e.g. a $0.01 BTC tick) can never pin an
 *     absurd amount.  The old pin is kept.
 *   - Re-pin fires only when drift exceeds the threshold, which
 *     sits INSIDE the verifier's tolerance band — so quotes are
 *     never rejected mid-drift, and the chain isn't spammed with
 *     sub-threshold updates.
 *
 * Plan B (operator override) lives a layer up: an operator can
 * disable the auto-re-pin timer and pin amounts by hand at any
 * time; this module only ever RECOMMENDS, it never acts.
 */

import {
	LISTING_FEE_USD,
	listingFeeBlurtBase,
	listingFeeSatoshis,
	listingFeePiconero
} from '@morphit/asset-registry';
import type { ReleaseTreasuryBlock } from '@morphit/release-schema';

/** Sanity ceilings — mirror the release validator's bounds so a
 *  computed amount that would be rejected on write is never even
 *  proposed.  (releaseValidate.ts: BTC_SATOSHIS_MAX,
 *  XMR_PICONERO_MAX_LEN ⇒ 1e16, BLURT_BASE_MAX.) */
const BTC_SATOSHIS_MAX = 100_000_000_000;
const XMR_PICONERO_MAX = 9_999_999_999_999_999n; // 16 nines, matches len ≤ 16
const BLURT_BASE_MAX = 10_000_000;

/** Currently chain-pinned fee amounts (whatever the latest release
 *  op declared).  Any asset may be absent (null) — e.g. an
 *  instance that doesn't pin BLURT yet, or doesn't accept BTC. */
export interface PinnedAmounts {
	readonly btcSatoshis: number | null;
	readonly xmrPiconero: bigint | null;
	readonly blurtBase: number | null;
}

/** Live USD prices.  Any may be null/0 when that feed is down —
 *  the corresponding asset is then skipped (never re-pinned). */
export interface RepinPrices {
	readonly btcUsd: number | null;
	readonly xmrUsd: number | null;
	readonly blurtUsd: number | null;
}

export interface RepinAssetOutcome {
	/** Fresh canonical amount at the live price (null when skipped:
	 *  no price, no current pin to compare, or a failed sanity
	 *  bound). */
	readonly computed: number | bigint | null;
	/** |pinnedUsdValue − target| / target, or null when not
	 *  computable (missing price or missing current pin). */
	readonly drift: number | null;
	/** True iff this asset's drift exceeded the threshold AND a
	 *  valid fresh amount was computed. */
	readonly due: boolean;
	/** Machine-readable note for logs / operator output. */
	readonly note: string;
}

export interface RepinDecision {
	/** True iff at least one asset is due for re-pin.  The wrapper
	 *  broadcasts a new release op only when this is true. */
	readonly shouldRepin: boolean;
	readonly btc: RepinAssetOutcome;
	readonly xmr: RepinAssetOutcome;
	readonly blurt: RepinAssetOutcome;
}

/** Re-pin when the pinned amount's USD value drifts more than this
 *  fraction from the canonical target.  Must be < FEE_PRICE_TOLERANCE
 *  (0.15) so we re-pin BEFORE quotes start getting rejected, leaving
 *  a safety margin; large enough that ordinary market noise doesn't
 *  spam the chain.  10% is a comfortable middle. */
export const DEFAULT_REPIN_DRIFT_THRESHOLD = 0.1;

function driftFrac(pinnedUsdValue: number, targetUsd: number): number {
	return Math.abs(pinnedUsdValue - targetUsd) / targetUsd;
}

/**
 * Decide whether the chain-pinned treasury amounts are due for an
 * auto-re-pin, and compute the fresh canonical amounts.
 *
 * Pure + total: never throws, never touches the outside world.
 */
export function decideRepin(
	pinned: PinnedAmounts,
	prices: RepinPrices,
	driftThreshold: number = DEFAULT_REPIN_DRIFT_THRESHOLD
): RepinDecision {
	const btc = decideBtc(pinned.btcSatoshis, prices.btcUsd, driftThreshold);
	const xmr = decideXmr(pinned.xmrPiconero, prices.xmrUsd, driftThreshold);
	const blurt = decideBlurt(pinned.blurtBase, prices.blurtUsd, driftThreshold);
	return {
		shouldRepin: btc.due || xmr.due || blurt.due,
		btc,
		xmr,
		blurt
	};
}

function decideBtc(
	pinnedSats: number | null,
	btcUsd: number | null,
	threshold: number
): RepinAssetOutcome {
	if (btcUsd === null || !Number.isFinite(btcUsd) || btcUsd <= 0) {
		return { computed: null, drift: null, due: false, note: 'btc: price unavailable — skipped' };
	}
	const fresh = listingFeeSatoshis(btcUsd);
	if (fresh === null || fresh <= 0) {
		return { computed: null, drift: null, due: false, note: 'btc: canonical amount uncomputable' };
	}
	if (fresh > BTC_SATOSHIS_MAX) {
		// A wildly-wrong (too-low) price would demand an absurd
		// satoshi amount; refuse to propose it.
		return { computed: null, drift: null, due: false, note: 'btc: computed amount over sanity ceiling — skipped' };
	}
	if (pinnedSats === null || pinnedSats <= 0) {
		// Nothing pinned yet — propose the canonical amount but only
		// flag "due" so a first pin happens.
		return { computed: fresh, drift: null, due: true, note: 'btc: no current pin — proposing canonical' };
	}
	const drift = driftFrac((pinnedSats / 1e8) * btcUsd, LISTING_FEE_USD.btc);
	const due = drift > threshold;
	return {
		computed: fresh,
		drift,
		due,
		note: `btc: drift ${(drift * 100).toFixed(1)}% ${due ? '>' : '≤'} ${(threshold * 100).toFixed(0)}%`
	};
}

function decideXmr(
	pinnedPiconero: bigint | null,
	xmrUsd: number | null,
	threshold: number
): RepinAssetOutcome {
	if (xmrUsd === null || !Number.isFinite(xmrUsd) || xmrUsd <= 0) {
		return { computed: null, drift: null, due: false, note: 'xmr: price unavailable — skipped' };
	}
	const fresh = listingFeePiconero(xmrUsd);
	if (fresh === null || fresh <= 0n) {
		return { computed: null, drift: null, due: false, note: 'xmr: canonical amount uncomputable' };
	}
	if (fresh > XMR_PICONERO_MAX) {
		return { computed: null, drift: null, due: false, note: 'xmr: computed amount over sanity ceiling — skipped' };
	}
	if (pinnedPiconero === null || pinnedPiconero <= 0n) {
		return { computed: fresh, drift: null, due: true, note: 'xmr: no current pin — proposing canonical' };
	}
	const pinnedUsdValue = (Number(pinnedPiconero) / 1e12) * xmrUsd;
	const drift = driftFrac(pinnedUsdValue, LISTING_FEE_USD.xmr);
	const due = drift > threshold;
	return {
		computed: fresh,
		drift,
		due,
		note: `xmr: drift ${(drift * 100).toFixed(1)}% ${due ? '>' : '≤'} ${(threshold * 100).toFixed(0)}%`
	};
}

function decideBlurt(
	pinnedBase: number | null,
	blurtUsd: number | null,
	threshold: number
): RepinAssetOutcome {
	if (blurtUsd === null || !Number.isFinite(blurtUsd) || blurtUsd <= 0) {
		return { computed: null, drift: null, due: false, note: 'blurt: price unavailable — skipped' };
	}
	const fresh = listingFeeBlurtBase(blurtUsd);
	if (fresh === null || fresh <= 0) {
		return { computed: null, drift: null, due: false, note: 'blurt: canonical amount uncomputable' };
	}
	if (fresh > BLURT_BASE_MAX) {
		return { computed: null, drift: null, due: false, note: 'blurt: computed amount over sanity ceiling — skipped' };
	}
	if (pinnedBase === null || pinnedBase <= 0) {
		return { computed: fresh, drift: null, due: true, note: 'blurt: no current pin — proposing canonical' };
	}
	const drift = driftFrac(pinnedBase * blurtUsd, LISTING_FEE_USD.blurt);
	const due = drift > threshold;
	return {
		computed: fresh,
		drift,
		due,
		note: `blurt: drift ${(drift * 100).toFixed(1)}% ${due ? '>' : '≤'} ${(threshold * 100).toFixed(0)}%`
	};
}

/** Current chain-pinned addresses (amounts come from PinnedAmounts).
 *  BLURT has no address — fees are transfers to the fee-recipient. */
export interface CurrentTreasuryAddresses {
	readonly btcAddress: string | null;
	readonly xmrAddress: string | null;
}

/**
 * Build the NEW treasury block for a re-pin broadcast.
 *
 * Pure.  Keeps the current addresses (a re-pin changes amounts, not
 * destinations) and swaps in each asset's freshly-computed canonical
 * amount.  An asset whose feed was down (computed === null) keeps its
 * CURRENT pinned amount rather than being dropped or zeroed — a feed
 * outage must never silently disable a fee method or move it to a bad
 * value.  An asset with neither a computed nor a current amount (or no
 * address, for BTC/XMR) is omitted (null).
 *
 * The `blurt` block is attached only when a positive base exists, so a
 * pin with no BLURT base serializes byte-identically to the legacy
 * shape.
 */
export function buildRepinnedTreasury(
	decision: RepinDecision,
	addresses: CurrentTreasuryAddresses,
	current: PinnedAmounts
): ReleaseTreasuryBlock {
	// computed is `number` for btc, `bigint` for xmr, `number` for blurt.
	const btcSats = (decision.btc.computed as number | null) ?? current.btcSatoshis;
	const btc =
		addresses.btcAddress !== null && btcSats !== null && btcSats > 0
			? { address: addresses.btcAddress, satoshis: Math.round(btcSats) }
			: null;

	const xmrPico = (decision.xmr.computed as bigint | null) ?? current.xmrPiconero;
	const xmr =
		addresses.xmrAddress !== null && xmrPico !== null && xmrPico > 0n
			? { address: addresses.xmrAddress, piconero: xmrPico.toString() }
			: null;

	const base = (decision.blurt.computed as number | null) ?? current.blurtBase;
	const blurt = base !== null && base > 0 ? { base } : null;

	return blurt !== null ? { btc, xmr, blurt } : { btc, xmr };
}

/** Parsed view of a /v1/release `treasury` block, split into the
 *  addresses (for re-pin) and the pinned amounts (for drift). */
export interface ParsedReleaseTreasury {
	readonly addresses: CurrentTreasuryAddresses;
	readonly pinned: PinnedAmounts;
}

/**
 * Tolerantly parse a /v1/release `treasury` value (or any
 * chain-pinned treasury object) into addresses + pinned amounts.
 *
 * Pure + total: never throws.  Anything missing / malformed maps to
 * null for that field — the caller (the drift-check / re-pin tool)
 * then treats it as "no current pin" (bootstrap) rather than
 * crashing.  This is the read side the auto-re-pin actuator feeds
 * into decideRepin(); isolating it keeps the only-untestable part
 * of the actuator (the raw HTTP fetch) down to a single line.
 */
export function parseReleaseTreasury(treasury: unknown): ParsedReleaseTreasury {
	const empty: ParsedReleaseTreasury = {
		addresses: { btcAddress: null, xmrAddress: null },
		pinned: { btcSatoshis: null, xmrPiconero: null, blurtBase: null }
	};
	if (treasury === null || typeof treasury !== 'object' || Array.isArray(treasury)) {
		return empty;
	}
	const t = treasury as Record<string, unknown>;

	let btcAddress: string | null = null;
	let btcSatoshis: number | null = null;
	if (t.btc !== null && typeof t.btc === 'object') {
		const btc = t.btc as Record<string, unknown>;
		if (typeof btc.address === 'string' && btc.address.length > 0) btcAddress = btc.address;
		if (typeof btc.satoshis === 'number' && Number.isFinite(btc.satoshis) && btc.satoshis > 0) {
			btcSatoshis = btc.satoshis;
		}
	}

	let xmrAddress: string | null = null;
	let xmrPiconero: bigint | null = null;
	if (t.xmr !== null && typeof t.xmr === 'object') {
		const xmr = t.xmr as Record<string, unknown>;
		if (typeof xmr.address === 'string' && xmr.address.length > 0) xmrAddress = xmr.address;
		if (typeof xmr.piconero === 'string' && /^\d+$/.test(xmr.piconero) && xmr.piconero !== '0') {
			try {
				xmrPiconero = BigInt(xmr.piconero);
			} catch {
				xmrPiconero = null;
			}
		}
	}

	let blurtBase: number | null = null;
	if (t.blurt !== null && typeof t.blurt === 'object') {
		const blurt = t.blurt as Record<string, unknown>;
		if (typeof blurt.base === 'number' && Number.isFinite(blurt.base) && blurt.base > 0) {
			blurtBase = blurt.base;
		}
	}

	return {
		addresses: { btcAddress, xmrAddress },
		pinned: { btcSatoshis, xmrPiconero, blurtBase }
	};
}
