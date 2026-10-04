/**
 * Morphit indexer — Sybil fee multiplier.
 *
 * BLURT-native ENFORCEMENT: the order handler checks the paid BLURT
 * against `base × sybilMultiplier(nth) × (1 − max(feeTolerance,
 * FEE_PRICE_TOLERANCE))` with NO price read, so the floor is deterministic
 * across the federation (no TOCTOU). `base` is the chain-pinned
 * `treasury.blurt.base` (Model A; auto-re-pinned by the maintainer as
 * BLURT/USD drifts), falling back to MORPHIT_INDEXER_FEE_BASE_BLURT when no
 * pin exists. What the UI QUOTES tracks the canonical USD target live
 * (`LISTING_FEE_USD.blurt` in `@morphit/asset-registry`, ~12.5¢); the 15%
 * FEE_PRICE_TOLERANCE absorbs the drift between that live quote and the pin
 * between re-pins. Amounts are compared in exact integer milliBLURT
 * (`meetsMinimumMilli`, v1.20.0 G8).
 *
 * Tier schedule (per account; n counts orders currently LIVE — stored live
 * and not past expires_at — plus any created in the last 24h, see the order
 * handler's countForSybilTier):
 *   tiers 1-3 (orders 1, 2, 3): 1.00×
 *   tier 4 (4th):   1.25×
 *   tier 5 (5th):   1.5625×
 *   tier 6 (6th):   1.953125×
 *   tier 7 (7th):   2.44140625×
 *   tier 8 (8th):   3.0517578125×
 *   tier 9 (9th):   3.814697265625×
 *   tier 10 (10th): 4.76837158203125×
 *   11+: compound 1.5× per additional order on tier-10's
 *
 * Tier escalation makes spammy posting expensive while leaving
 * normal users (1-3 listings/day) on the baseline rate.
 */

import { FEE_PRICE_TOLERANCE, FEE_TREASURY_SHARE_BLURT } from '@morphit/asset-registry';

const MULTIPLIERS: readonly number[] = [
	1.0, 1.0, 1.0, 1.25, 1.5625, 1.953125, 2.44140625, 3.0517578125, 3.814697265625, 4.76837158203125
];

/** Compute the Sybil multiplier for the nth order in the 24h
 *  window (1-indexed). */
export function sybilMultiplier(nth: number): number {
	if (nth <= 0) return MULTIPLIERS[0]!;
	if (nth <= MULTIPLIERS.length) return MULTIPLIERS[nth - 1]!;
	const base = MULTIPLIERS[MULTIPLIERS.length - 1]!;
	const extras = nth - MULTIPLIERS.length;
	return base * Math.pow(1.5, extras);
}

/** Expected BLURT amount for the nth order (before tolerance). Same
 *  formula both sides compute. The caller applies the acceptance band
 *  (order handler: max(feeTolerance, FEE_PRICE_TOLERANCE)) and compares the
 *  paid amount in whole milliBLURT via `meetsMinimumMilli`. */
export function expectedFeeBlurt(nth: number, baseBlurt: number): number {
	if (baseBlurt <= 0) {
		throw new Error(`invalid baseBlurt: ${baseBlurt}`);
	}
	return baseBlurt * sybilMultiplier(nth);
}

/**
 * tolerance on the canonical treasury's 10% split leg.
 *
 * The frontend rounds each leg of the fee to milliBLURT
 * (`splitListingFeeBlurt`), so the canonical share can land a
 * fraction of a milli below an exact 10%. This small band absorbs
 * that rounding. It is NOT the fee-underpaid band (that's the wider
 * price-drift tolerance applied to the fee TOTAL) — it only guards
 * the split PROPORTION, i.e. "did the canonical treasury actually
 * receive its ~10% cut of what was paid."
 */
export const FEE_SPLIT_TOLERANCE = 0.02;

/**
 * did the canonical treasury receive its 10% cut?
 *
 * Federation instances split BLURT fees at payment time: 90% to the
 * instance owner, 10% to the canonical treasury. This checks that
 * the amount which actually reached the canonical treasury is at
 * least ~10% of the total paid. When the instance's own fee
 * recipient IS the canonical treasury (the canonical instance, or a
 * federation owner who fell back to it), the whole fee is the
 * canonical's, so `toCanonicalBlurt === totalBlurt` and this is
 * trivially satisfied.
 *
 * This is the enforcement that a federation instance cannot keep the
 * canonical 10%: an order whose fee skipped (or shorted) the
 * canonical leg fails verification and never becomes visible.
 */
export function canonicalShareOk(totalBlurt: number, toCanonicalBlurt: number): boolean {
	if (totalBlurt <= 0) return false;
	const required = totalBlurt * FEE_TREASURY_SHARE_BLURT * (1 - FEE_SPLIT_TOLERANCE);
	return toCanonicalBlurt >= required;
}

/**
 * sum the sibling transfer(s) that paid a fee (listing, feature bid, or
 * stranger DM), honoring the payment-time federation split.
 *
 * A fee is one or two sibling transfers that share `expectedMemo`: the owner
 * leg (to `feeRecipient`) and the canonical leg (to `canonicalTreasury`).
 * `feeRecipient` may be a SET of owner accounts (v1.20.0, G1): the listing and
 * stranger-fee handlers pass this indexer's own recipient plus the fee account
 * the op's tagged operator registered on chain (`ownerRecipientsFor` in
 * $indexer/feeRecipients), so a fee paid through another instance verifies
 * here too. The feature-bid handler still passes only its own recipient.
 * Returns the total paid across both legs plus how much reached the canonical
 * treasury, or null if no matching transfer exists in the transaction.
 *
 * When `feeRecipient === canonicalTreasury` (the canonical instance, or a
 * federation owner who fell back to it) the `to === canonicalTreasury` test
 * runs first, so every matched leg counts as the canonical's and
 * `toCanonicalBlurt === totalBlurt`. A transfer carrying the fee memo but
 * addressed to some third account is ignored (defense against a decoy that
 * would pad the total without paying the canonical its cut).
 *
 * Malformed sibling ops are skipped (not errors). The returned total is always
 * a positive finite number by construction.
 */
export function sumFeeTransfers(
	siblingOps: readonly (readonly [string, Record<string, unknown>])[],
	signer: string,
	feeRecipient: string | readonly string[],
	canonicalTreasury: string,
	expectedMemo: string
): {
	totalBlurt: number;
	toCanonicalBlurt: number;
	/** (v1.20.0, G8) Exact integer milliBLURT totals — compare with these. */
	totalMilli: number;
	toCanonicalMilli: number;
} | null {
	const owners: readonly string[] =
		typeof feeRecipient === 'string' ? [feeRecipient] : feeRecipient;
	let toOwner = 0;
	let toCanonical = 0;
	let found = false;
	for (const op of siblingOps) {
		if (!op) continue;
		const [name, body] = op;
		if (name !== 'transfer') continue;
		const b = body as {
			from?: unknown;
			to?: unknown;
			amount?: unknown;
			memo?: unknown;
		};
		if (b.from !== signer) continue;
		if (b.memo !== expectedMemo) continue;
		const toCanonicalLeg = b.to === canonicalTreasury;
		const toOwnerLeg = typeof b.to === 'string' && owners.includes(b.to);
		if (!toCanonicalLeg && !toOwnerLeg) continue;
		if (typeof b.amount !== 'string') continue;
		const amount = parseBlurtMilli(b.amount);
		if (amount === null || amount <= 0) continue;
		if (toCanonicalLeg) {
			toCanonical += amount;
		} else {
			toOwner += amount;
		}
		found = true;
	}
	if (!found) return null;
	const totalMilli = toOwner + toCanonical;
	return {
		totalBlurt: totalMilli / 1000,
		toCanonicalBlurt: toCanonical / 1000,
		totalMilli,
		toCanonicalMilli: toCanonical
	};
}

/**
 * Parse a Graphene BLURT asset string ("56.250 BLURT")
 * into an exact INTEGER count of milliBLURT, or null if malformed. The chain
 * serialises BLURT with exactly 3 decimals; more than 3 is not a valid amount.
 * Parsing the decimal string directly avoids binary-float error entirely.
 */
export function parseBlurtMilli(s: string): number | null {
	const m = /^(\d+)(?:\.(\d{1,3}))?\s+BLURT$/.exec(s);
	if (!m) return null;
	const milli = Number(m[1]) * 1000 + Number(((m[2] ?? '') + '000').slice(0, 3));
	return Number.isSafeInteger(milli) ? milli : null;
}

/**
 * Did `paidMilli` (exact milliBLURT) meet a floor
 * expressed in BLURT? The floor is a float product (base × tier × (1 − T));
 * paying EXACTLY that amount rounded up to the milli must pass, so the floor
 * is taken to whole milliBLURT with a tiny epsilon for the product's own float
 * error. Previously `31.304 + 3.478` (= 34.781999…) was compared against
 * `40.92 × 0.85` (= 34.782000…04) and a payment exactly at the floor was
 * rejected as underpaid.
 */
export function meetsMinimumMilli(paidMilli: number, minBlurt: number): boolean {
	if (!Number.isFinite(minBlurt)) return false;
	return paidMilli >= Math.ceil(minBlurt * 1000 - 1e-6);
}

/**
 * The BLURT listing-fee verdict, shared by the order handler and the G1
 * re-verification (v1.20.0) so both reach the same answer from the same
 * inputs. `fee` is the `sumFeeTransfers` result (non-null), `nth` the order's
 * Sybil tier position, `baseBlurt` the pinned base in effect. The floor is
 * base × tier × (1 − max(feeTolerance, FEE_PRICE_TOLERANCE)) compared in exact
 * milliBLURT (G8); then the canonical treasury's ~10 % leg must be there.
 */
export function listingFeeStatus(
	fee: { totalBlurt: number; toCanonicalBlurt: number; totalMilli: number },
	nth: number,
	baseBlurt: number,
	feeTolerance: number
): 'verified' | 'underpaid' {
	const expected = expectedFeeBlurt(nth, baseBlurt);
	const tolerance = Math.max(feeTolerance, FEE_PRICE_TOLERANCE);
	if (!meetsMinimumMilli(fee.totalMilli, expected * (1 - tolerance))) return 'underpaid';
	if (!canonicalShareOk(fee.totalBlurt, fee.toCanonicalBlurt)) return 'underpaid';
	return 'verified';
}
