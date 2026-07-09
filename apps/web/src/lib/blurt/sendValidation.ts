/**
 * Morphit — validation for a user-typed BLURT amount.
 *
 * BLURT carries THREE decimal places on chain, and `formatBlurtAmount`
 * serialises with `toFixed(3)`, which ROUNDS. That makes precision a money
 * question, not a cosmetic one:
 *
 *   • `1.0006` would serialise to `1.001 BLURT` — the user sends more than they
 *     typed, silently.
 *   • `0.0004` would serialise to `0.000 BLURT` — a transfer of nothing, which
 *     the chain then rejects after the user has already entered their password.
 *
 * So the field refuses more precision than the asset has, rather than quietly
 * rounding on the user's behalf. The regex is also the gate that rejects the
 * shapes `Number()` accepts but a balance field should not: `-1`, `1e3`, `+2`,
 * `Infinity`, ` 5 ` with hidden characters, and so on.
 */

/** Smallest representable BLURT amount (3 decimal places). */
export const MIN_BLURT = 0.001;

/** Chain precision for BLURT. */
export const BLURT_DECIMALS = 3;

/** Digits, optionally followed by a dot and up to 3 more digits. Nothing else. */
const AMOUNT_SHAPE = /^\d*(\.\d{0,3})?$/;

export interface AmountValidation {
	/** True when the typed text has at most 3 decimals and no exotic shape. */
	readonly precisionOk: boolean;
	/** True when the amount is safe to broadcast: shape + range. */
	readonly valid: boolean;
}

/**
 * Validate a raw amount string against the sender's balance.
 *
 * `balance` is compared with a 1e-6 epsilon so "send my exact balance" (which
 * arrives as `balance.toFixed(3)`) isn't rejected by float representation.
 */
export function validateBlurtAmount(raw: string, balance: number): AmountValidation {
	const trimmed = raw.trim();
	const precisionOk = AMOUNT_SHAPE.test(trimmed);
	if (!precisionOk) return { precisionOk: false, valid: false };
	const n = Number(trimmed);
	const valid = Number.isFinite(n) && n >= MIN_BLURT && n <= balance + 1e-6;
	return { precisionOk, valid };
}

/**
 * Clamp a balance DOWN to BLURT's 3 decimals.
 *
 * "Use full balance" used `balance.toFixed(3)`, which ROUNDS. If a balance ever
 * carries more precision than the asset (an FX path, a future chain change, a
 * mocked value in a test), rounding produces an amount strictly GREATER than
 * the balance — which `validateBlurtAmount` then rejects, leaving the user
 * staring at a disabled button after clicking the button that was supposed to
 * fill the field. Flooring can never exceed the balance.
 *
 * Today the chain always hands us 3-decimal balances, so this is defence in
 * depth rather than a live bug. Money code should not rely on that staying true.
 */
export function floorToBlurtPrecision(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '0.000';
	const scale = 10 ** BLURT_DECIMALS;
	return (Math.floor(n * scale) / scale).toFixed(BLURT_DECIMALS);
}
